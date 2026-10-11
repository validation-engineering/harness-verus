#!/usr/bin/env node
// Exercise the unmodified installed Web profile. This checks HTTP, not browser execution or a model turn.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { backend: { type: 'string', default: 'native' }, register: { type: 'string' } } });
assert(['native', 'upstream'].includes(values.backend), '--backend must be native or upstream');
assert(!values.register || values.backend === 'native', '--register requires --backend native');
const backend = values.backend;
const register = values.register ? resolve(values.register) : resolve(root, 'scripts/official-register.mjs');
const development = !!values.register;
const reportDir = resolve(root, '.cache/official-web');
await mkdir(reportDir, { recursive: true });
const reportPath = resolve(reportDir, `${backend}${development ? '-development' : ''}.json`);
const logPath = resolve(reportDir, `${backend}${development ? '-development' : ''}.log`);
const temporary = await mkdtemp(resolve(tmpdir(), 'cordis-official-web-'));
const workspace = resolve(temporary, 'workspace');
const home = resolve(temporary, 'home');
await Promise.all([mkdir(workspace), mkdir(home)]);
const entry = resolve(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
const observerEntry = resolve(root, 'scripts/official-test-entry.mjs');
const observerPath = resolve(temporary, 'runtime-observer.json');
const dist = resolve(root, 'node_modules/@deepseek-ai/dsh-web-frontend/dist');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  schemaVersion: 1, status: 'running', backend,
  evidence: development ? 'development-source-runtime' : 'installed-artifacts',
  releaseAcceptance: false, browserExecution: false, modelRequests: false,
  startedAt: new Date().toISOString(), node: process.version,
  platform: `${process.platform}-${process.arch}`,
  invocation: { profile: 'web', flags: ['--no-open', '--port', '0'], register: backend === 'native' ? (development ? register : relative(root, register)) : null },
  checks: {}, warnings: [], diagnostics: [],
};
let output = '';
let child;
let ended;
let exitResult;
let startupUrl;
let failure;
let forced = false;
const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Web acceptance interrupted'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const redact = text => text.replace(/([?&]token=)[^\s"<>]+/g, '$1[redacted]').replaceAll(temporary, '<temporary>');
async function until(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    abort.signal.throwIfAborted();
    if (exitResult) throw new Error(`Official process exited before ${description}: ${JSON.stringify(exitResult)}`);
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function request(url, options = {}) {
  const target = new URL(url, startupUrl);
  assert.equal(target.origin, new URL(startupUrl).origin, 'Only the spawned loopback server may be requested');
  const response = await fetch(target, { ...options, redirect: 'manual', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]) });
  return response;
}
async function bytesAt(url, contentType, headers) {
  const response = await request(url, { headers });
  assert.equal(response.status, 200, `${url} must be served`);
  assert.match(response.headers.get('content-type') ?? '', contentType, `${url} content type`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length > 0, `${url} is empty`);
  return bytes;
}
try {
  const packageJson = JSON.parse(await readFile(resolve(dirname(dirname(entry)), 'package.json'), 'utf8'));
  report.version = packageJson.version;
  report.entrySha256 = sha256(await readFile(entry));
  report.observerSha256 = sha256(await readFile(observerEntry));
  if (backend === 'native') report.registerSha256 = sha256(await readFile(register));
  // A strict allowlist prevents ambient provider credentials, user .env, and Node hooks from leaking into acceptance.
  const environment = {
    PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(),
    HOME: home, USERPROFILE: home, LANG: 'en_US.UTF-8', NO_COLOR: '1', TERM: 'dumb',
    DSH_HOME: resolve(temporary, 'dsh'), DSH_AGENTS_HOME: resolve(temporary, 'agents'), DSH_TELEMETRY_DISABLED: '1', CORDIS_HARNESS_TEST_REPORT: observerPath,
  };
  const args = [...(backend === 'native' ? ['--import', register] : []), observerEntry, 'web', '--no-open', '--port', '0'];
  child = spawn(process.execPath, args, { cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  ended = new Promise(resolve => {
    child.once('error', error => { exitResult = { error: error.message }; resolve(exitResult); });
    child.once('exit', (code, signal) => { exitResult = { code, signal }; resolve(exitResult); });
  });
  const collect = chunk => {
    output += chunk.toString();
    if (output.length > 8 * 1024 * 1024) abort.abort(new Error('Official Web output exceeded 8 MiB'));
    startupUrl ??= /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/.exec(output)?.[1];
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  await until(() => !!startupUrl, 90000, 'the official startup URL');
  const url = new URL(startupUrl);
  assert(url.searchParams.has('token'), 'Official startup must provide token exchange');
  report.checks.startup = { origin: url.origin, tokenExchange: true };
  const exchange = await request(startupUrl);
  assert.equal(exchange.status, 303, 'Launch token must exchange into a cookie and clean redirect');
  const cookies = exchange.headers.getSetCookie();
  assert(cookies.length > 0, 'Launch token exchange must set a cookie');
  const cookie = cookies.map(row => row.split(';')[0]).join('; ');
  const cleanUrl = new URL(exchange.headers.get('location'), startupUrl);
  assert.equal(cleanUrl.origin, url.origin);
  assert.equal(cleanUrl.searchParams.has('token'), false);
  const headers = { cookie, origin: url.origin };
  const html = (await bytesAt(cleanUrl, /text\/html/, headers)).toString();
  assert.match(html, /<title>DeepSeek Harness<\/title>/);
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /__DSH_BOOT_READY__/);
  const graphJson = /<script>globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert(graphJson, 'The official host must inject the browser plugin graph');
  const graph = JSON.parse(graphJson);
  assert.equal(typeof graph.rev, 'string');
  assert(Array.isArray(graph.entries) && graph.entries.length > 0);
  assert(Array.isArray(graph.batches) && graph.batches.some(row => row.phase === 'bootstrap'));
  assert(graph.entries.some(row => row.id === '@deepseek-ai/dsh-client-modules'));
  const scheduled = graph.batches.flatMap(row => row.entries);
  assert.deepEqual([...scheduled].sort(), graph.entries.map(row => row.id).sort(), 'Every browser entry must belong to exactly one batch');
  report.checks.html = { title: 'DeepSeek Harness', rootElement: true, bootReady: true, bytes: Buffer.byteLength(html) };
  report.checks.browserGraph = { entries: graph.entries.length, batches: graph.batches.length, revision: graph.rev };
  const staticAssets = [...new Set([...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+\.(?:js|css))"/g)].map(match => match[1]))];
  assert(staticAssets.some(path => path.endsWith('.js')) && staticAssets.some(path => path.endsWith('.css')));
  report.checks.staticAssets = [];
  for (const path of staticAssets) {
    const bytes = await bytesAt(path, path.endsWith('.css') ? /text\/css/ : /(?:java|ecma)script/, headers);
    const original = await readFile(resolve(dist, path));
    assert.deepEqual(bytes, original, `Official asset ${path} must remain unchanged`);
    report.checks.staticAssets.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  report.checks.browserBatches = [];
  for (const batch of graph.batches) {
    const bytes = await bytesAt(batch.url, /(?:java|ecma)script/, headers);
    assert.match(bytes.toString(), /__ModuleLoader__/);
    report.checks.browserBatches.push({ path: batch.url, bytes: bytes.length, entries: batch.entries.length });
  }
  async function rpc(method, args = {}) {
    const response = await request(`/api/${method}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'web-acceptance', method, payload: { args } }),
    });
    assert.equal(response.status, 200, `Official Remote ${method}`);
    const value = await response.json();
    assert.equal(value.type, 'server-response');
    assert.equal(value.rpcId, 'web-acceptance');
    assert.equal(value.result?.ok, true, `${method}: ${JSON.stringify(value.result)}`);
    return value.result.value;
  }
  const inventory = await rpc('pluginInventory/list');
  assert(Array.isArray(inventory.entries) && inventory.entries.length > 0);
  const notReady = inventory.entries.filter(row => row.enabled && row.fiberPhase !== 'active');
  report.checks.pluginInventory = { total: inventory.entries.length, active: inventory.entries.filter(row => row.fiberPhase === 'active').length, entries: inventory.entries.map(({entryId, moduleName, enabled, fiberPhase}) => ({entryId, moduleName, enabled, fiberPhase})), notReady };
  const observer = JSON.parse(await readFile(observerPath, 'utf8'));
  assert.equal(observer.backend, backend, 'The observed Cordis backend must match the requested backend');
  assert.equal(observer.ready?.contexts.length, 1, 'The official application must own one root Context');
  const activeFibers = observer.ready.contexts[0].fibers.filter(row => row.active).length;
  assert(activeFibers >= report.checks.pluginInventory.active, 'Runtime fibers must account for every active Loader entry');
  if (backend === 'native') {
    assert.equal(observer.ready.contexts[0].native?.profile, 'harness');
    assert(observer.ready.contexts[0].native.plugins.length > 0, 'The native lifecycle graph must exist');
  }
  report.checks.runtime = { backend: observer.backend, rootContexts: 1, activeFibers };
  const presets = await rpc('agentPresets/list');
  assert(Array.isArray(presets.presets));
  const standard = presets.presets.find(row => row.id === 'standard');
  assert(standard?.isDefault === true, 'The unchanged standard preset must be the default');
  const broken = presets.presets.filter(row => row.broken);
  report.checks.presets = { ids: presets.presets.map(row => row.id), default: standard.id, broken };
  assert.equal(notReady.length, 0, `Enabled official plugins must activate: ${JSON.stringify(notReady)}`);
  assert.equal(broken.length, 0, `Official presets must be usable: ${JSON.stringify(broken)}`);
  // Creating an empty official Session activates its standard plugin composition without asking a model.
  const sessionRequest = { cwd: workspace, sessionId: 'official-web-acceptance' };
  const created = await rpc('session/create', { request: sessionRequest });
  assert.equal(created.sessionId, sessionRequest.sessionId);
  assert.equal(created.agentPreset, 'standard');
  const adopted = await rpc('session/create', { request: sessionRequest });
  assert.deepEqual(adopted, created, 'Explicit session creation must idempotently adopt the same session');
  const sessions = await rpc('session/list', { _request: {} });
  assert(Array.isArray(sessions.items));
  const listed = sessions.items.find(row => row.sessionId === created.sessionId);
  assert(listed, 'The newly created official Session must be listed');
  assert.equal(listed.running, false, 'Empty-session validation must not start a model turn');
  assert.equal(listed.projections.values.agentPreset, 'standard');
  report.checks.session = { id: created.sessionId, agentPreset: created.agentPreset, idempotentCreate: true, listed: true, running: listed.running, blank: listed.blank };
} catch (error) {
  failure = error;
} finally {
  if (child && !exitResult) {
    const stopAt = Date.now();
    child.kill('SIGTERM');
    await Promise.race([ended, new Promise(resolve => { const timer = setTimeout(resolve, 20000); timer.unref(); })]);
    if (!exitResult) { forced = true; child.kill('SIGKILL'); await ended; }
    report.checks.shutdown = { ...exitResult, forced, elapsedMs: Date.now() - stopAt };
  } else if (exitResult) report.checks.shutdown = { ...exitResult, premature: true };
  try {
    const observed = JSON.parse(await readFile(observerPath, 'utf8'));
    assert.equal(observed.backend, backend);
    assert(observed.exit?.contexts.length > 0, 'Exit runtime evidence must be present');
    for (const context of observed.exit.contexts) {
      assert.equal(context.fibers.length, 0, 'Official shutdown must remove all registered plugin fibers');
      if (backend === 'native') {
        assert.equal(context.native?.profile, 'harness');
        assert(context.native.plugins.length <= 1 && context.native.plugins.every(row => row.parent === null &&
          row.state === 'Active' && !row.retired && !row.cleanupFailed && row.pendingAction === null && row.error === null),
        'Only a clean active root may remain after official shutdown');
      }
    }
    report.runtimeEvidence = observed;
    if (report.checks.shutdown) report.checks.shutdown.registryEmpty = true;
  } catch (error) { failure ??= error; }
  const cleanOutput = redact(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''));
  report.warnings = cleanOutput.split('\n').filter(line => /(?:\bwarn(?:ing)?\b|\[W\]|experimentalwarning|\bdeprecated\b)/i.test(line));
  report.diagnostics = cleanOutput.split('\n').filter(line => /(?:\[E\]|\berror\b|\bfailed\b|missing service|activation.*failed)/i.test(line));
  if (!failure && report.warnings.length) failure = new Error(`Official Web emitted ${report.warnings.length} warning(s); inspect ${relative(root, logPath)}`);
  if (!failure && report.diagnostics.length) failure = new Error(`Official Web emitted ${report.diagnostics.length} error diagnostic(s)`);
  if (!failure && (forced || exitResult?.code !== 0 || exitResult?.signal)) failure = new Error(`Official Web did not shut down cleanly: ${JSON.stringify(exitResult)}`);
  report.status = failure ? 'failed' : 'passed';
  report.finishedAt = new Date().toISOString();
  if (failure) report.error = redact(failure.stack ?? String(failure));
  await writeFile(logPath, cleanOutput);
  report.log = relative(root, logPath);
  report.logSha256 = sha256(cleanOutput);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
console.log(JSON.stringify({ status: report.status, backend, evidence: report.evidence, version: report.version, plugins: report.checks.pluginInventory ? { total: report.checks.pluginInventory.total, active: report.checks.pluginInventory.active, notReady: report.checks.pluginInventory.notReady } : undefined, presets: report.checks.presets, warnings: report.warnings, report: relative(root, reportPath), ...(failure ? { error: failure.message } : {}) }, null, 2));
if (failure) process.exitCode = 1;
