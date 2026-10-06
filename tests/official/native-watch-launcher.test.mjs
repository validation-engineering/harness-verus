// Run this file as a separate validation step, not beside manifest readers:
// the real offline Cargo build refreshes shared native module build evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRustModules } from '../../scripts/verify-rust-modules.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cargoHome = resolve(process.env.CARGO_HOME ?? join(homedir(), '.cargo'));
const rustupHome = resolve(process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'));
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function within(promise, timeout, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function launch(args, home) {
  const child = spawn(process.execPath, ['scripts/official-native.mjs', '--watch', ...args], {
    cwd: root, env: { PATH: [join(cargoHome, 'bin'), dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
      CARGO_HOME: cargoHome, RUSTUP_HOME: rustupHome, CARGO_NET_OFFLINE: 'true',
      HOME: home, USERPROFILE: home, TMPDIR: process.env.TMPDIR ?? tmpdir(),
      DSH_HOME: join(home, 'dsh'), DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1',
      NO_COLOR: '1', TERM: 'dumb', LANG: 'en_US.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = { child, stdout: '', stderr: '', exit: null, forced: false };
  run.done = new Promise((resolveDone, reject) => {
    child.once('error', error => { run.error = error; reject(error); });
    child.once('close', (code, signal) => { run.exit = { code, signal }; resolveDone(run.exit); });
  });
  run.done.catch(() => {});
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
    run[stream] += bytes.toString();
    if (run[stream].length > 8 * 1024 * 1024) run.error ??= new Error('Native watch launcher output exceeded limit');
  });
  return run;
}
async function stop(run) {
  if (run.exit) return;
  run.child.kill('SIGTERM');
  try { await within(run.done, 15000, 'Native watch launcher did not shut down after SIGTERM'); }
  catch (error) {
    run.forced = true; run.child.kill('SIGKILL');
    await run.done.catch(() => {});
    throw error;
  }
}
async function waitReady(run) {
  const end = Date.now() + 120000;
  while (!run.stderr.includes('Verified Rust generation active')) {
    if (run.error) throw run.error;
    assert.equal(run.exit, null, `Watch launcher exited before native generation became active:\n${run.stderr}`);
    assert(!run.stderr.includes('Native update failed'), run.stderr);
    assert(Date.now() < end, `Timed out waiting for native generation:\n${run.stderr}`);
    await delay(50);
  }
  assert.match(run.stdout + run.stderr, /dsh web:\s+http:\/\/127\.0\.0\.1:\d+\//);
}

test('official native watch launcher skips stopped profiles and drains a real offline build before exit', { timeout: 180000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'cordis-native-watch-launcher-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await verifyRustModules();
  const evidence = join(root, '.cache/rust-modules/build.json');
  const before = await readFile(evidence);
  const invalid = launch(['web', '--cordis-invalid-watch-option'], home);
  try {
    const exit = await within(invalid.done, 30000, 'Invalid Web arguments left a native watcher running');
    assert.notEqual(exit.code, 0, invalid.stderr);
    assert.equal(exit.signal, null);
    assert.match(invalid.stdout + invalid.stderr, /unknown option|Unknown argument|unrecognized option/i);
    assert(!invalid.stderr.includes('Verified Rust generation active'));
    assert(!invalid.stderr.includes('Native update failed'));
    assert.deepEqual(await readFile(evidence), before, 'An exited profile must never begin a native build');
  } finally { await stop(invalid); }
  const active = launch(['web', '--port', '0', '--no-open'], home);
  try {
    await waitReady(active);
    assert.equal(active.exit, null);
    assert(!active.stderr.includes('Native update failed'), active.stderr);
    active.child.kill('SIGTERM');
    const exit = await within(active.done, 15000, `Native watcher failed to close:\n${active.stderr}`);
    assert.deepEqual(exit, { code: 0, signal: null }, active.stderr);
    assert.equal(active.forced, false);
    assert(!active.stderr.includes('Native watcher shutdown failed'), active.stderr);
    assert.notDeepEqual(await readFile(evidence), before, 'The real build must refresh source-bound module evidence');
    await verifyRustModules();
  } finally { await stop(active); }
});
