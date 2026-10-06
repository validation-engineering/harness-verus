import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const SKIP_DIRECTORIES = new Set(['target', '.git']);
const OUTPUT_LIMIT = 16 * 1024;
const ERROR_LIMIT = 2048;

function failure(error, phase, attempt) {
  return Object.freeze({ phase, attempt, message: String(error?.message ?? error).slice(0, ERROR_LIMIT),
    ...(typeof error?.code === 'string' ? { code: error.code.slice(0, 128) } : {}) });
}

/** Content and file timestamps detect rewrites even when the final bytes agree.
 * Directory timestamps are omitted so ignored build output cannot trigger builds.
 * Symlinks are fingerprinted as links, never followed outside the explicit roots.
 */
async function fingerprint(paths) {
  const hash = createHash('sha256');
  const token = value => hash.update(JSON.stringify(value)).update('\n');
  async function visit(path) {
    let stat;
    try { stat = await lstat(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') { token(['missing', path]); return; } throw error; }
    if (stat.isSymbolicLink()) { token(['link', path, await readlink(path)]); return; }
    if (stat.isDirectory()) {
      token(['directory', path]);
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
        await visit(resolve(path, entry.name));
      }
    } else if (stat.isFile()) {
      token(['file', path, String(stat.mtimeNs), String(stat.ctimeNs), String(stat.size)]);
      hash.update(await readFile(path));
      token(['end', path]);
      const after = await lstat(path, { bigint: true });
      if (stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs || stat.size !== after.size) {
        const error = new Error('Watched source changed while being fingerprinted; retrying on the next scan');
        error.code = 'SOURCE_CHANGING';
        throw error;
      }
    } else {
      throw new Error(`Unsupported watched source type: ${path}`);
    }
  }
  for (const path of paths) await visit(path);
  return hash.digest('hex');
}

function runCommand(command, cwd) {
  return new Promise((resolveResult, reject) => {
    // The executable and each argument are passed directly; no shell is involved.
    const child = spawn(command.file, command.args, { cwd,
      env: command.env ? { ...process.env, ...command.env } : process.env,
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    const append = (current, chunk) => Buffer.concat([current, chunk]).subarray(-OUTPUT_LIMIT);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const result = { code, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
      if (code === 0 && signal === null) resolveResult(result);
      else {
        const error = new Error(`Native build failed (${signal ?? `exit ${code}`}): ${result.stderr.slice(-ERROR_LIMIT)}`);
        error.code = 'BUILD_FAILED';
        reject(error);
      }
    });
  });
}

/** A trusted host utility, independent of Cordis graphs and module controllers.
 * apply must verify the generated artifact before asking the host to replace it.
 * Polling is serialized with itself; builds and applies never overlap each other.
 * start/buildNow settle after coalesced work; failure is an outcome, not rejection.
 * Call close before disposing the host. It drains, rather than kills, native builds.
 */
export function createNativeBuildWatcher(options) {
  assert(options && typeof options === 'object', 'Watcher options are required');
  assert(typeof options.cwd === 'string' && options.cwd.length, 'An explicit build cwd is required');
  assert(Array.isArray(options.watchPaths) && options.watchPaths.length > 0 &&
    options.watchPaths.every(path => typeof path === 'string' && path.length), 'Explicit watchPaths are required');
  assert(typeof options.apply === 'function', 'An artifact verification/apply callback is required');
  assert((typeof options.build === 'function') !== (options.command !== undefined), 'Specify exactly one build callback or command');
  const cwd = resolve(options.cwd);
  const paths = [...new Set(options.watchPaths.map(path => resolve(cwd, path)))].sort();
  const interval = options.intervalMs ?? 250;
  assert(Number.isInteger(interval) && interval >= 10, 'intervalMs must be an integer of at least 10 ms');
  if (options.onEvent !== undefined) assert(typeof options.onEvent === 'function', 'onEvent must be a function');
  let command;
  if (options.command !== undefined) {
    assert(options.command && typeof options.command.file === 'string' && options.command.file.length, 'command.file is required');
    const args = options.command.args ?? [];
    assert(Array.isArray(args) && args.every(arg => typeof arg === 'string'), 'command.args must be strings');
    const env = options.command.env;
    assert(env === undefined || (env && typeof env === 'object' && !Array.isArray(env) &&
      Object.values(env).every(value => typeof value === 'string' || value === undefined)), 'command.env values must be strings');
    command = { file: options.command.file, args: [...args], ...(env ? { env: { ...env } } : {}) };
  }
  const build = options.build ?? (() => runCommand(command, cwd));
  const apply = options.apply;
  const observer = options.onEvent;
  let timer, scanning, polling, worker, closePromise, startPromise;
  let started = false, closing = false, closed = false, requested = false, forced = false;
  let observed, attempted, applied, revision = 0, phase = 'idle';
  let attempts = 0, appliedCount = 0, superseded = 0, lastFailure = null, observerFailure = null;
  let lastOutcome = null;

  function report(outcome) {
    lastOutcome = Object.freeze({ ...outcome, superseded });
    try {
      // Observers cannot turn a successful replacement into a failed transaction.
      Promise.resolve(observer?.(lastOutcome)).catch(error => { observerFailure = failure(error, 'observer', attempts); });
    } catch (error) { observerFailure = failure(error, 'observer', attempts); }
    return lastOutcome;
  }
  function rejected(error, stage) {
    lastFailure = failure(error, stage, attempts);
    return report({ ok: false, status: 'failed', phase: stage, attempt: attempts, fingerprint: observed ?? null, error: lastFailure });
  }
  function sample() {
    if (!scanning) {
      scanning = fingerprint(paths).then(value => {
        if (observed !== value) { observed = value; revision++; }
        return value;
      }).finally(() => { scanning = undefined; });
    }
    return scanning;
  }
  async function freshSample() {
    if (scanning) await scanning;
    return sample();
  }
  async function drain() {
    do {
      requested = false;
      if (closing) break;
      let source;
      try { source = await freshSample(); }
      catch (error) { forced = false; rejected(error, 'scan'); break; }
      if (closing) break;
      if (!forced && source === attempted) continue;
      forced = false;
      attempted = source;
      const sourceRevision = revision;
      attempts++;
      phase = 'building';
      let buildResult, buildFailed = false;
      try { buildResult = await build(Object.freeze({ cwd, fingerprint: source, attempt: attempts })); }
      catch (error) { buildFailed = true; rejected(error, 'build'); }
      // A rejected build must never call apply. The marker also permits undefined
      // as a perfectly valid successful custom build result.
      if (closing) break;
      let current;
      try { current = await freshSample(); }
      catch (error) { rejected(error, 'scan'); break; }
      if (closing) break;
      if (source !== current || sourceRevision !== revision) {
        superseded++;
        report({ ok: false, status: 'superseded', phase: 'build', attempt: attempts, fingerprint: source });
        requested = true;
        forced = true;
        continue;
      }
      if (!buildFailed) {
        phase = 'applying';
        try {
          await apply(Object.freeze({ fingerprint: source, buildResult, attempt: attempts }));
          applied = source;
          appliedCount++;
          lastFailure = null;
          report({ ok: true, status: 'completed', phase: 'apply', attempt: attempts, fingerprint: source });
        } catch (error) { rejected(error, 'apply'); }
      }
      if (closing) break;
      try {
        if (await freshSample() !== attempted) requested = true;
      } catch (error) { rejected(error, 'scan'); break; }
    } while (requested && !closing);
    phase = closing ? 'closing' : 'idle';
    if (closing) return report({ ok: false, status: 'closed', phase: 'close', attempt: attempts, fingerprint: applied ?? null });
    return lastOutcome;
  }
  function schedule(force = false) {
    if (closing) return Promise.resolve(Object.freeze({ ok: false, status: 'closed', phase: 'close', attempt: attempts, fingerprint: applied ?? null, superseded }));
    requested = true;
    forced ||= force;
    if (!worker) {
      worker = drain().catch(error => rejected(error, phase)).finally(() => {
        worker = undefined;
        // A polling result may arrive in the promise-settlement microtask gap.
        if (requested && !closing) void schedule();
      });
    }
    return worker;
  }
  async function settled(force) {
    let result = await schedule(force);
    while (worker) result = await worker;
    return result;
  }
  function poll() {
    if (closing || polling) return;
    polling = sample().then(value => { if (!closing && value !== attempted) void schedule(); })
      .catch(error => { if (!closing) rejected(error, 'scan'); })
      .finally(() => { polling = undefined; });
  }
  return Object.freeze({
    start() {
      if (closing) return schedule();
      if (!started) {
        started = true;
        timer = setInterval(poll, interval);
        startPromise = settled(true);
      }
      return startPromise;
    },
    buildNow() { return settled(true); },
    close() {
      if (!closePromise) {
        closing = true;
        clearInterval(timer);
        closePromise = (async () => {
          await worker;
          await scanning?.catch(() => {});
          await polling;
          closed = true;
          phase = 'closed';
          return Object.freeze({ ok: false, status: 'closed', phase: 'close', attempt: attempts, fingerprint: applied ?? null, superseded });
        })();
      }
      return closePromise;
    },
    snapshot() {
      return Object.freeze({ started, closed, closing, phase, attempts, appliedCount, superseded,
        observedFingerprint: observed ?? null, appliedFingerprint: applied ?? null,
        lastFailure, observerFailure, lastOutcome });
    },
  });
}
