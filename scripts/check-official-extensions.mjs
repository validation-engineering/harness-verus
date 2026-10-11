#!/usr/bin/env node
// Original CLI, Loader, Settings/PluginManager/Session APIs and AgentLoop.
// Only model transport is a local fixture. This does not execute a browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { backend: { type: 'string', default: 'native' }, register: { type: 'string' }, rust: { type: 'boolean', default: false }, dynamic: { type: 'boolean', default: false } } });
const backend = values.backend;
assert(['upstream', 'native'].includes(backend));
assert(!values.register || backend === 'native');
assert(!values.rust || backend === 'native', 'Rust addon requires the native backend');
assert(!values.dynamic || backend === 'native', 'Dynamic Rust modules require the native backend');
assert(!(values.dynamic && values.rust), '--dynamic and --rust are mutually exclusive');
assert(!Object.hasOwn(process.env, 'CORDIS_NATIVE_BINDING'), 'Use a verified register, not CORDIS_NATIVE_BINDING');
const register = path.resolve(values.register ?? path.join(root, values.rust ? 'scripts/official-extensions-register.mjs' : 'scripts/official-register.mjs'));
const directory = path.join(root, '.cache/official-extensions');
await mkdir(directory, { recursive: true });
const suffix = `${backend}${values.dynamic ? '-dynamic' : values.rust ? '-rust' : ''}${values.register ? '-development' : ''}`;
const temporary = await mkdtemp(path.join(tmpdir(), 'cordis-extensions-'));
const home = path.join(temporary, 'home'), workspace = path.join(temporary, 'workspace'), dshHome = path.join(temporary, 'dsh');
await Promise.all([mkdir(home), mkdir(workspace)]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const key = 'fixture-key-not-a-real-credential', keyName = 'CORDIS_HARNESS_TEST_API_KEY', model = 'local-extension-fixture';
const id = 'cordis-greeting';
const report = { schemaVersion: 1, status: 'running', backend, rust: values.rust, dynamic: values.dynamic,
  evidence: values.register ? 'development-source-runtime' : 'installed-artifacts',
  browserExecution: false, paidModelRequests: false, releaseAcceptance: false,
  node: process.version, platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString(),
  checks: {}, processes: [], requests: [], inputs: {} };
await writeFile(path.join(directory, `${suffix}.json`), JSON.stringify(report, null, 2) + '\n');
const logs = [], requests = [], cases = new Map(), sessions = new Map();
let failure, active, baseURL, dynamicModule;
const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Extension acceptance interrupted'));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const clean = value => value.replaceAll(temporary, '<temporary>').replaceAll(key, '<fixture-key>').replace(/([?&]token=)[^\s"<>]+/g, '$1[redacted]');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    abort.signal.throwIfAborted();
    if (active?.exited) throw new Error(`Child exited while waiting for ${description}: ${JSON.stringify(active.exited)}\n${clean(active.stderr)}`);
    assert(Date.now() < end, `Timed out waiting for ${description}`);
    await delay(30);
  }
}
const events = rows => rows.map(row => `event: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`).join('');
const start = () => ({ type: 'message_start', message: { id: `extension-${requests.length}`, model, usage: { input_tokens: 1, output_tokens: 0 } } });
const finish = stop_reason => [{ type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
const text = value => events([start(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } }, { type: 'content_block_stop', index: 0 }, ...finish('end_turn')]);
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/messages'); assert.equal(request.method, 'POST'); assert.equal(request.headers['x-api-key'], key);
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; assert(bytes < 2 * 1024 * 1024); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks)); assert.equal(body.model, model); assert.equal(body.stream, true);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (JSON.stringify(body.system).includes('Create a concise title')) { requests.push({ kind: 'title' }); response.end(text('Extension verification')); return; }
    const raw = JSON.stringify(body.messages);
    const matches = [...raw.matchAll(/CORDIS_EXTENSION_([a-z_]+)/g)];
    const label = matches.at(-1)?.[1], scenario = cases.get(label);
    assert(scenario, `Unknown fixture case ${label}`);
    const tools = body.tools.map(tool => tool.name);
    assert(tools.includes('todo_write'), 'Keep the official default tools');
    const callId = `call-${label}`;
    const result = body.messages.flatMap(row => Array.isArray(row.content) ? row.content : []).find(row => row.type === 'tool_result' && row.tool_use_id === callId);
    requests.push({ kind: label, tools }); scenario.requested = true;
    assert(requests.length < 50, 'Unexpected retry loop');
    if (scenario.absent) {
      assert(!tools.includes('cordis_greet'), 'Unloaded tool must disappear from the real model request');
      scenario.completed = true; response.end(text(`COMPLETE_${label}`));
    } else if (result) {
      assert.equal(!!result.is_error, !!scenario.error, `Unexpected tool outcome ${label}: ${JSON.stringify(result)}`);
      if (scenario.expected) assert(JSON.stringify(result).includes(scenario.expected), `Missing ${scenario.expected}: ${JSON.stringify(result)}`);
      if (scenario.fields) {
        const rendered = typeof result.content === 'string' ? result.content : result.content.map(row => row.text ?? '').join('\n');
        const output = JSON.parse(rendered);
        for (const [field, value] of Object.entries(scenario.fields)) assert.equal(output[field], value, `Rust ${field}`);
      }
      scenario.result = result; scenario.completed = true; response.end(text(`COMPLETE_${label}`));
    } else {
      assert(tools.includes(scenario.tool ?? 'cordis_greet'), `Tool unavailable in ${label}`);
      scenario.callSent = true;
      response.end(events([start(), { type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: callId, name: scenario.tool ?? 'cordis_greet', input: scenario.args ?? { name: 'Ada' } } },
        { type: 'content_block_stop', index: 0 }, ...finish('tool_use')]));
    }
  } catch (error) { abort.abort(error); response.destroy(); }
});
const extensionRows = () => [{ id, name: pathToFileURL(path.join(root, 'examples/official/greeting.mjs')).href },
  ...(values.rust ? [{ id: 'cordis-rust-text-analysis', name: pathToFileURL(path.join(root, 'examples/official/rust-text-analysis.mjs')).href }] : []),
  ...(values.dynamic ? [
    { id: 'cordis-rust-module', name: 'cordis:rust-module', config: dynamicModule.config },
    { id: 'cordis-rust-dynamic-tool', name: pathToFileURL(path.join(root, 'examples/official/rust-dynamic-text-analysis.mjs')).href },
  ] : [])];
async function prepare(profile) {
  const { initProfile, PROFILE_TEMPLATES } = await import('@deepseek-ai/dsh-app-boot');
  const directory = path.join(dshHome, 'profiles', profile);
  initProfile(directory, PROFILE_TEMPLATES[profile].bundles);
  await writeFile(path.join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: extensionRows() }], null, 2) + '\n');
  const patch = [{ id: 'llm-deepseek', config: { apiKeyEnv: keyName, baseURL, thinking: 'disabled', maxTokens: 512,
    models: [{ id: model, name: model, contextWindow: 131072 }], streamIdleTimeoutMs: 5000 } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model } }];
  const provider = path.join(temporary, 'provider.patch.yml');
  await writeFile(provider, JSON.stringify(patch)); return provider;
}
function launch(args, label) {
  const observer = path.join(temporary, `${label}.json`);
  const child = spawn(process.execPath, [...(backend === 'native' ? ['--import', register] : []),
    path.join(root, 'scripts/official-test-entry.mjs'), ...args], { cwd: workspace,
    env: { PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(), HOME: home, USERPROFILE: home, LANG: 'en_US.UTF-8', NO_COLOR: '1', TERM: 'dumb',
      DSH_HOME: dshHome, DSH_AGENTS_HOME: path.join(temporary, 'agents'), DSH_TELEMETRY_DISABLED: '1', [keyName]: key, CORDIS_HARNESS_TEST_REPORT: observer },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { child, observer, label, stdout: '', stderr: '', started: Date.now(), forced: false };
  run.done = new Promise(resolve => {
    child.once('error', error => { run.exited = { error: error.message }; resolve(); });
    child.once('close', (code, signal) => { run.exited = { code, signal }; resolve(); });
  });
  child.stdout.on('data', data => { run.stdout += data; if (run.stdout.length > 8 * 1024 * 1024) abort.abort(new Error('Output limit')); });
  child.stderr.on('data', data => { run.stderr += data; if (run.stderr.length > 8 * 1024 * 1024) abort.abort(new Error('Output limit')); });
  active = run; return run;
}
async function stop(run) {
  if (!run.exited) {
    run.child.kill('SIGTERM');
    await Promise.race([run.done, delay(12000)]);
    if (!run.exited) { run.forced = true; run.child.kill('SIGKILL'); await run.done; }
  }
  logs.push(`--- ${run.label} stdout ---\n${clean(run.stdout)}\n--- stderr ---\n${clean(run.stderr)}`);
  const evidence = { label: run.label, ...run.exited, forced: run.forced, elapsedMs: Date.now() - run.started };
  report.processes.push(evidence); active = undefined;
  assert.deepEqual(run.exited, { code: 0, signal: null }, clean(run.stderr)); assert(!run.forced);
  const observer = JSON.parse(await readFile(run.observer, 'utf8'));
  evidence.runtime = observer;
  assert.equal(observer.backend, backend); assert.equal(observer.ready.contexts.length, 1); assert.equal(observer.exit.contexts.length, 1);
  assert.equal(observer.exit.contexts[0].fibers.length, 0);
  if (backend === 'native') {
    const nodes = observer.exit.contexts[0].native.plugins;
    assert(nodes.length <= 1 && nodes.every(node => node.parent === null && node.state === 'Active' && !node.retired && !node.cleanupFailed && node.pendingAction === null && node.error === null));
    evidence.nativePluginsAtExit = nodes.filter(node => node.parent !== null).length;
  }
  evidence.singleContext = true; evidence.registryEmpty = true;
}
async function durableSessions() {
  const { sessionFormatCatalog } = await import('@deepseek-ai/dsh-session-format-catalog');
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!/\.jsonl(?:\.zstd)?$/.test(entry.name)) continue;
      const bytes = await readFile(file); const decoded = []; let offset = 0, total = 0;
      if (file.endsWith('.zstd')) while (offset < bytes.length) {
        const frame = zstdDecompressSync(bytes.subarray(offset), { info: true, maxOutputLength: 16 * 1024 * 1024 });
        assert(frame.engine.bytesWritten > 0); offset += frame.engine.bytesWritten; total += frame.buffer.length; assert(total < 64 * 1024 * 1024); decoded.push(frame.buffer);
      }
      const text = (file.endsWith('.zstd') ? Buffer.concat(decoded) : bytes).toString(); assert(!text.includes(key));
      const rows = text.trim().split('\n').map(row => JSON.parse(row));
      const restore = sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' });
      for (const row of rows.slice(1)) restore.decodeRow(row);
      found.push({ id: rows[0].id, artifact: restore.finish(), sha256: sha(bytes) });
    }
  }
  await visit(path.join(dshHome, 'sessions')); return found;
}
try {
  for (const file of ['scripts/check-official-extensions.mjs', 'scripts/official-test-entry.mjs', 'src/official-plugin-api.mjs',
    'examples/official/greeting.mjs', 'examples/official/rust-text-analysis.mjs', 'package-lock.json']) report.inputs[file] = sha(await readFile(path.join(root, file)));
  if (values.dynamic) for (const file of ['scripts/official-native.mjs', 'scripts/verify-rust-modules.mjs',
    'src/native-module-artifacts.mjs', 'src/official-native-modules.mjs', 'src/official-loader-api.mjs',
    'examples/official/rust-dynamic-text-analysis.mjs', 'examples/shared/dynamic-text-tool.mjs']) report.inputs[file] = sha(await readFile(path.join(root, file)));
  if (backend === 'native') report.registerSha256 = sha(await readFile(register));
  if (values.rust) {
    const { verifyRustAddon } = await import('./verify-rust-addon.mjs');
    const addon = await verifyRustAddon();
    report.rustAddon = { manifestSha256: addon.manifestSha256, coreSourceDigest: addon.coreSourceDigest, binarySha256: sha(await readFile(addon.addonPath)) };
  }
  if (values.dynamic) {
    const { verifyRustModules } = await import('./verify-rust-modules.mjs');
    const modules = await verifyRustModules();
    dynamicModule = modules.published.v1;
    report.rustModule = { manifestSha256: modules.manifestSha256, coreSourceDigest: modules.coreSourceDigest,
      publicationManifestSha256: dynamicModule.manifestSha256, binarySha256: dynamicModule.config.sha256 };
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  baseURL = `http://127.0.0.1:${server.address().port}`;
  const rustScenario = { tool: values.dynamic ? 'rust_dynamic_text_analyze' : 'rust_text_analyze', args: { text: 'Hello 世界\nRust' },
    fields: { backend: values.dynamic ? 'rust-dynamic' : 'rust', ...(values.dynamic ? { revision: 'v1' } : {}), bytes: 17, characters: 13, lines: 2, words: 3 } };
  const nativeCase = values.dynamic ? 'dynamic' : 'rust';
  report.checks.headless = [];
  for (const [label, scenario] of [['headless', { expected: 'Hello, Ada!' }], ...(values.rust || values.dynamic ? [[`headless_${nativeCase}`, rustScenario]] : [])]) {
    cases.set(label, scenario);
    const headless = launch(['headless', '--patch', await prepare('headless'), '--json', `CORDIS_EXTENSION_${label}`], label);
    await Promise.race([headless.done, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Headless timeout')), 45000); timer.unref(); })]);
    await stop(headless);
    const rows = headless.stdout.trim().split('\n').map(row => JSON.parse(row));
    assert.equal(rows.at(-1).text, `COMPLETE_${label}`); assert(cases.get(label).completed);
    assert(rows.some(row => row.type === 'tool_call' && row.tool === (scenario.tool ?? 'cordis_greet')));
    assert(rows.some(row => row.type === 'tool_result' && row.status === 'completed'));
    report.checks.headless.push({ tool: scenario.tool ?? 'cordis_greet', toolCalled: true, final: rows.at(-1).text });
  }
  const web = launch(['web', '--patch', await prepare('web'), '--no-open', '--port', '0'], 'web');
  let startup;
  await until(() => (startup = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/.exec(web.stdout + web.stderr)?.[1]), 'Web startup', 45000);
  const origin = new URL(startup).origin;
  const exchange = await fetch(startup, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); assert.equal(exchange.status, 303);
  const cookie = exchange.headers.getSetCookie().map(row => row.split(';')[0]).join('; ');
  async function rpc(method, args = {}, allowFailure = false) {
    const started = Date.now();
    try {
    const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45000)]) });
    assert.equal(response.status, 200); const body = await response.json();
    if (allowFailure) return body.result;
    assert.equal(body.result?.ok, true, `${method}: ${JSON.stringify(body)}`); return body.result.value;
    } finally {
      report.rpc ??= {};
      const previous = report.rpc[method] ?? { calls: 0, totalMs: 0, maxMs: 0 };
      const elapsed = Date.now() - started;
      report.rpc[method] = { calls: previous.calls + 1, totalMs: previous.totalMs + elapsed, maxMs: Math.max(previous.maxMs, elapsed) };
    }
  }
  async function inventory() { return (await rpc('pluginInventory/list')).entries; }
  let entries = await inventory();
  assert(entries.some(row => row.moduleName === extensionRows()[0].name && row.fiberPhase === 'active'));
  if (values.dynamic) for (const entry of extensionRows().slice(1)) {
    assert(entries.some(row => row.moduleName === entry.name && row.fiberPhase === 'active'), `Native Loader entry must be active: ${entry.name}`);
  }
  assert.equal((await rpc('agentPresets/list')).presets.find(row => row.id === 'standard').isDefault, true);
  async function turn(label, scenario = {}) {
    cases.set(label, scenario);
    const sessionId = 'extension-web'; sessions.set(label, sessionId);
    const created = await rpc('session/create', { request: { sessionId, cwd: workspace } }); assert.equal(created.agentPreset, 'standard');
    await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: `CORDIS_EXTENSION_${label}` }] } });
    return sessionId;
  }
  async function idle(label) {
    await until(async () => cases.get(label).completed && !(await rpc('session/list', { _request: {} })).items.find(row => row.sessionId === sessions.get(label))?.running, `completed ${label}`);
  }
  await turn('initial', { expected: 'Hello, Ada!' }); await idle('initial');
  const descriptor = (await rpc('settings/describe')).namespaces.find(row => row.ns === id); assert(descriptor);
  const rejected = await rpc('settings/update', { ns: id, patch: { prefix: 42 }, expectedRevision: descriptor.revision }, true);
  assert.equal(rejected.ok, false, 'Invalid config must be rejected before replacing the live value');
  await turn('after_rejection', { expected: 'Hello, Ada!' }); await idle('after_rejection');
  const updated = await rpc('settings/update', { ns: id, patch: { prefix: 'Welcome' }, expectedRevision: descriptor.revision });
  assert.equal(updated.value.prefix, 'Welcome');
  await turn('updated', { expected: 'Welcome, Ada!' }); await idle('updated');
  await turn('tool_failure', { args: { name: 'x'.repeat(201) }, error: true, expected: 'at most 200' }); await idle('tool_failure');
  await turn('after_tool_failure', { expected: 'Welcome, Ada!' }); await idle('after_tool_failure');
  const cancelId = await turn('cancelled', { args: { name: 'Ada', wait_ms: 5000 }, error: true });
  await until(() => cases.get('cancelled').callSent, 'cancel tool call'); await delay(300);
  await rpc('session/cancel', { request: { sessionId: cancelId } });
  await until(async () => !(await rpc('session/list', { _request: {} })).items.find(row => row.sessionId === cancelId)?.running, 'cancel settled');
  const plugin = (await rpc('pluginManager/listPlugins')).find(row => row.moduleName === extensionRows()[0].name); assert(plugin && !plugin.readOnlyReason);
  const disabled = await rpc('pluginManager/setPluginEnabled', { id: plugin.entryId, enabled: false }); assert.equal(disabled.application, 'applied');
  await until(async () => (await inventory()).some(row => row.entryId === plugin.entryId && !row.enabled), 'plugin disabled');
  await turn('unloaded', { absent: true }); await idle('unloaded');
  const enabled = await rpc('pluginManager/setPluginEnabled', { id: plugin.entryId, enabled: true }); assert.equal(enabled.application, 'applied');
  await turn('reloaded', { expected: 'Welcome, Ada!' }); await idle('reloaded');
  if (values.rust || values.dynamic) { await turn(nativeCase, { ...rustScenario, requested: false, callSent: false, completed: false }); await idle(nativeCase); }
  report.checks.web = { standardPreset: true, toolCalls: true, invalidConfigurationRejected: true, configurationUpdated: true,
    toolFailureRecovered: true, cancelled: true, unloadedToolAbsent: true, reenabledToolCalled: true, rustToolCalled: values.rust,
    ...(values.dynamic ? { dynamicToolCalled: true, nativeModuleActive: true } : {}) };
  await stop(web);
  const durable = await durableSessions();
  const cancelled = durable.find(row => row.id === cancelId); assert(cancelled);
  const result = cancelled.artifact.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'call-cancelled');
  assert(result && /cancel|abort/i.test(JSON.stringify(result)), 'Durable official history must contain cancelled tool result');
  report.checks.persistence = { sessions: durable.length, cancelledToolResult: result, hashes: Object.fromEntries(durable.map(row => [row.id, row.sha256])) };
  if (values.dynamic) {
    report.checks.persistence.dynamicToolResults = ['headless_dynamic', 'dynamic'].map(label => {
      const callId = `call-${label}`;
      const records = durable.flatMap(session => session.artifact.events
        .filter(event => event.type === 'tool/call' && event.data.callId === callId).map(call => ({ session, call })));
      assert.equal(records.length, 1, `One durable native tool call required for ${label}`);
      const { session, call } = records[0];
      assert.equal(call.data.name, rustScenario.tool);
      const results = session.artifact.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === callId);
      assert.equal(results.length, 1, `One durable native tool result required for ${label}`);
      const message = results[0].data.message;
      assert.equal(message.isError, false); assert.equal(message.content.length, 1); assert.equal(message.content[0].type, 'text');
      const value = JSON.parse(message.content[0].text);
      for (const [field, expected] of Object.entries(rustScenario.fields)) assert.equal(value[field], expected, `Persisted native ${field}: ${label}`);
      return { profile: label === 'dynamic' ? 'web' : 'headless', sessionId: session.id, callId, tool: call.data.name, value };
    });
  }
  assert(!abort.signal.aborted, String(abort.signal.reason));
  for (const [file, expected] of Object.entries(report.inputs)) assert.equal(sha(await readFile(path.join(root, file))), expected, `Input changed during acceptance: ${file}`);
  if (backend === 'native') assert.equal(sha(await readFile(register)), report.registerSha256, 'Register changed during acceptance');
  if (values.rust) {
    const { verifyRustAddon } = await import('./verify-rust-addon.mjs');
    const addon = await verifyRustAddon();
    assert.deepEqual({ manifestSha256: addon.manifestSha256, coreSourceDigest: addon.coreSourceDigest, binarySha256: sha(await readFile(addon.addonPath)) },
      report.rustAddon, 'Rust addon evidence changed during acceptance');
  }
  if (values.dynamic) {
    const { verifyRustModules } = await import('./verify-rust-modules.mjs');
    const modules = await verifyRustModules();
    assert.deepEqual({ manifestSha256: modules.manifestSha256, coreSourceDigest: modules.coreSourceDigest,
      publicationManifestSha256: modules.published.v1.manifestSha256, binarySha256: modules.published.v1.config.sha256 },
    report.rustModule, 'Native module evidence changed during acceptance');
  }
  report.checks.evidenceUnchanged = true;
} catch (error) { failure = error; }
finally {
  if (active) { try { await stop(active); } catch (error) { failure ??= error; } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const output = logs.join('\n');
  report.diagnostics = output.split('\n').filter(line => /(?:\[W\]|\[E\]|\bwarning\b|\berror\b|\bfailed\b)/i.test(line));
  if (!failure && report.diagnostics.length) failure = new Error('Unexpected runtime diagnostics; inspect the extension acceptance log');
  report.requests = requests; report.status = failure ? 'failed' : 'passed'; report.finishedAt = new Date().toISOString();
  if (failure) report.error = clean(failure.stack ?? String(failure)); report.log = `.cache/official-extensions/${suffix}.log`; report.logSha256 = sha(output);
  await writeFile(path.join(root, report.log), output);
  await writeFile(path.join(directory, `${suffix}.json`), JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
console.log(JSON.stringify({ status: report.status, backend, dynamic: values.dynamic, checks: report.checks, report: `.cache/official-extensions/${suffix}.json`, ...(failure ? { error: failure.message } : {}) }, null, 2));
if (failure) process.exitCode = 1;
