#!/usr/bin/env node
// Real official headless profile, HTTP provider, todo tool, and JSONL resume.
// The only composition patch redirects the official provider/model to loopback.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { backend: { type: 'string', default: 'native' }, register: { type: 'string' } } });
assert(['upstream', 'native'].includes(values.backend), '--backend must be upstream or native');
assert(!values.register || values.backend === 'native', '--register requires --backend native');
assert(!Object.hasOwn(process.env, 'CORDIS_NATIVE_BINDING'), 'Unset CORDIS_NATIVE_BINDING');
const backend = values.backend, development = !!values.register;
const register = path.resolve(values.register ?? path.join(root, 'scripts/official-register.mjs'));
const reportDir = path.join(root, '.cache/official-headless');
await mkdir(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `${backend}${development ? '-development' : ''}.json`);
const logPath = reportPath.replace(/\.json$/, '.log');
const temporary = await mkdtemp(path.join(tmpdir(), 'cordis-official-headless-'));
const workspace = path.join(temporary, 'workspace'), home = path.join(temporary, 'home'), dshHome = path.join(temporary, 'dsh');
await Promise.all([mkdir(workspace), mkdir(home)]);
const MODEL = 'local-messages-fixture', KEY_NAME = 'CORDIS_HARNESS_TEST_API_KEY';
const FAKE_KEY = 'local-fixture-only-not-a-real-credential';
const FIRST = 'CORDIS_FIXTURE_FIRST: Record the verified official todo.', SECOND = 'CORDIS_FIXTURE_RESUME: Confirm the prior todo and answer survived restart.';
const FIRST_ANSWER = 'The official todo tool completed before restart.', SECOND_ANSWER = 'The official session restored the prior tool result after restart.';
const todos = [{ content: 'Confirm the official tool call', status: 'completed' }];
const callId = 'official-headless-todo-call';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { schemaVersion: 1, status: 'running', backend,
  evidence: development ? 'development-source-runtime' : 'installed-artifacts',
  releaseAcceptance: false, paidModelRequests: false, modelTransport: 'loopback HTTP/SSE fixture',
  officialComposition: 'Unmodified dsh-base + dsh-headless; provider connection and default model patch only',
  startedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`,
  checks: {}, runs: [], requests: [], warnings: [], diagnostics: [] };
const abort = new AbortController();
const interrupt = () => abort.abort(new Error('Headless acceptance interrupted'));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
let failure, active;
const logs = [], serverErrors = [], requests = [];
const clean = text => text.replaceAll(temporary, '<temporary>').replaceAll(FAKE_KEY, '<fixture-key>');
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const start = () => ({ type: 'message_start', message: { id: `msg-${requests.length}`, model: MODEL, usage: { input_tokens: 3, output_tokens: 0 } } });
const finish = stop => [{ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
const textEvents = text => [start(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, { type: 'content_block_stop', index: 0 }, ...finish('end_turn')];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/messages');
    assert.equal(request.headers['x-api-key'], FAKE_KEY);
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; assert(bytes < 2 * 1024 * 1024, 'Fixture request exceeded 2 MiB'); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.model, MODEL); assert.equal(body.stream, true);
    const tools = body.tools ?? [], messages = JSON.stringify(body.messages), system = JSON.stringify(body.system);
    const title = system.includes('Create a concise title for an AI coding-assistant session');
    requests.push({ kind: title ? 'title' : messages.includes(SECOND) ? 'resume' : 'first', body });
    assert(requests.length <= 8, 'Unexpected model retry/request loop');
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (title) response.end(sse(textEvents('Official runtime verification')));
    else {
      assert(tools.some(tool => tool.name === 'todo_write'), 'Default composition must expose official todo_write');
      const result = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === callId);
      if (messages.includes(SECOND)) {
        assert(messages.includes(FIRST) && messages.includes(FIRST_ANSWER), 'Resumed request must retain the first turn and answer');
        assert(result && !result.is_error, 'Resumed request must retain the successful official tool result');
        response.end(sse(textEvents(SECOND_ANSWER)));
      } else if (result) {
        assert(!result.is_error, 'Official todo tool failed');
        response.end(sse(textEvents(FIRST_ANSWER)));
      } else {
        assert(messages.includes(FIRST), 'Unexpected first-turn request');
        response.end(sse([start(), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name: 'todo_write', input: { todos } } },
          { type: 'content_block_stop', index: 0 }, ...finish('tool_use')]));
      }
    }
  } catch (error) { serverErrors.push(error); abort.abort(error); response.destroy(error); }
});

async function execute(prompt, sessionId) {
  const observerPath = path.join(temporary, `observer-${report.runs.length}.json`);
  const args = [...(backend === 'native' ? ['--import', register] : []), path.join(root, 'scripts/official-test-entry.mjs'),
    'headless', '--patch', path.join(temporary, 'provider.patch.yml'), '--json', ...(sessionId ? ['--session-id', sessionId] : []), prompt];
  // No inherited provider credentials, .env files, proxy variables, or Node preloads.
  const env = { PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(), HOME: home, USERPROFILE: home,
    LANG: 'en_US.UTF-8', NO_COLOR: '1', TERM: 'dumb', DSH_HOME: dshHome,
    DSH_AGENTS_HOME: path.join(temporary, 'agents'), DSH_TELEMETRY_DISABLED: '1',
    [KEY_NAME]: FAKE_KEY, CORDIS_HARNESS_TEST_REPORT: observerPath };
  const child = spawn(process.execPath, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const runStarted = Date.now();
  let stdout = '', stderr = '', exited, finalAt, forced = false;
  const done = new Promise(resolve => {
    child.once('error', error => { exited = { error: error.message }; resolve(exited); });
    child.once('close', (code, signal) => { exited = { code, signal }; resolve(exited); });
  });
  active = { child, done };
  const collect = (chunk, error) => {
    if (error) stderr += chunk.toString(); else stdout += chunk.toString();
    if (stdout.includes('"type":"final"')) finalAt ??= Date.now();
    if (stdout.length + stderr.length > 8 * 1024 * 1024) abort.abort(new Error('Headless output exceeded 8 MiB'));
  };
  child.stdout.on('data', chunk => collect(chunk, false)); child.stderr.on('data', chunk => collect(chunk, true));
  let timer, onAbort;
  try {
    await Promise.race([done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Official headless run timed out')), 90000);
      onAbort = () => reject(abort.signal.reason);
      abort.signal.addEventListener('abort', onAbort, { once: true });
    })]);
    abort.signal.throwIfAborted();
    const observer = JSON.parse(await readFile(observerPath, 'utf8'));
    report.observers ??= {};
    report.observers[sessionId ? 'resume' : 'first'] = observer;
    assert.deepEqual(exited, { code: 0, signal: null }, `Headless failed:\n${clean(stderr)}\n${clean(stdout)}`);
    const rows = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(rows[0]?.type, 'session'); assert.equal(rows.at(-1)?.type, 'final');
    assert.equal(rows.at(-1).text, sessionId ? SECOND_ANSWER : FIRST_ANSWER);
    assert(rows.some(row => row.type === 'status' && row.phase === 'turn_end' && row.reason.kind === 'completed'));
    assert(rows.some(row => row.type === 'text' && row.text === rows.at(-1).text));
    if (sessionId) assert.equal(rows[0].sessionId, sessionId);
    else {
      const call = rows.find(row => row.type === 'tool_call');
      assert.equal(call?.tool, 'todo_write'); assert.deepEqual(call.input, { todos });
      const result = rows.find(row => row.type === 'tool_result');
      assert.equal(result?.callId, callId); assert.equal(result.status, 'completed');
      assert.match(result.result, /1 completed/);
    }
    assert.equal(observer.backend, backend);
    assert.equal(observer.ready.contexts.length, 1, 'One official host Context must own the composition');
    assert.equal(observer.exit.contexts.length, 1);
    const ready = observer.ready.contexts[0], ended = observer.exit.contexts[0];
    const names = ready.fibers.map(row => row.name);
    for (const name of ['headless-runner', 'tool-todo', 'JsonlSessionPersistence']) assert(names.includes(name), `Missing default official plugin: ${name}`);
    assert.equal(ended.fibers.length, 0, 'Official shutdown must drain every registered plugin');
    if (backend === 'native') {
      assert.equal(ready.native.profile, 'harness'); assert(ready.native.plugins.length > 0);
      // Official root.fiber.dispose() resets the graph; ctx.dispose() would also
      // destroy its domain. The one clean, idle root sentinel is permitted here.
      assert(ended.native.plugins.length <= 1 && ended.native.plugins.every(node => node.parent === null &&
        node.state === 'Active' && !node.retired && !node.cleanupFailed && node.pendingAction === null && node.error === null),
        'Native shutdown must leave no plugins or pending cleanup, except a clean reset root');
    }
    report.runs.push({ resumed: !!sessionId, pid: child.pid, exit: exited, sessionId: rows[0].sessionId, ndjson: rows,
      graph: { contexts: 1, fibersAtReady: ready.fibers.length, pluginNames: [...new Set(names)].sort(),
        ...(backend === 'native' ? { nativeProfile: ready.native.profile, nativePluginsAtReady: ready.native.plugins.length, nativeNodesAtExit: ended.native.plugins.length, nativePluginsAtExit: ended.native.plugins.filter(node => node.parent !== null).length } : {}) } });
    return rows[0].sessionId;
  } finally {
    clearTimeout(timer);
    if (onAbort) abort.signal.removeEventListener('abort', onAbort);
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([done, new Promise(resolve => { const timer = setTimeout(resolve, 8000); timer.unref(); })]);
      if (!exited) { forced = true; child.kill('SIGKILL'); await done; }
    }
    logs.push(`--- ${sessionId ? 'resume' : 'first'} stdout ---\n${clean(stdout)}\n--- stderr ---\n${clean(stderr)}`);
    report.checks.shutdown ??= [];
    report.checks.shutdown.push({ resumed: !!sessionId, ...exited, forced, elapsedMs: Date.now() - runStarted,
      ...(finalAt ? { afterFinalMs: Date.now() - finalAt } : {}) });
    active = undefined;
  }
}
async function sessionLogs() {
  const found = [];
  const { sessionFormatCatalog } = await import('@deepseek-ai/dsh-session-format-catalog');
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.jsonl(?:\.zstd)?$/.test(entry.name)) {
        const bytes = await readFile(file);
        const decoded = []; let offset = 0, total = 0;
        if (entry.name.endsWith('.zstd')) while (offset < bytes.length) {
          const frame = zstdDecompressSync(bytes.subarray(offset), { info: true, maxOutputLength: 16 * 1024 * 1024 });
          assert(frame.engine.bytesWritten > 0, 'Zstandard decoder must consume a complete frame');
          offset += frame.engine.bytesWritten; total += frame.buffer.length;
          assert(total < 64 * 1024 * 1024, 'Fixture session exceeds decoding limit');
          decoded.push(frame.buffer);
        }
        const text = (entry.name.endsWith('.zstd') ? Buffer.concat(decoded) : bytes).toString();
        const rows = text.trim().split('\n').map(line => JSON.parse(line));
        const restore = sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' });
        for (const row of rows.slice(1)) restore.decodeRow(row);
        const artifact = restore.finish();
        found.push({ file: path.relative(dshHome, file), bytes: bytes.length, sha256: sha256(bytes), rows, artifact });
        assert(!text.includes(FAKE_KEY), 'Fixture key must never enter durable session history');
      }
    }
  }
  await visit(path.join(dshHome, 'sessions'));
  return found;
}
try {
  const pkg = JSON.parse(await readFile(path.join(root, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  assert.equal(pkg.version, '0.2.0-rc.2'); report.version = pkg.version;
  report.inputs = {};
  for (const file of ['package-lock.json', 'scripts/official-test-entry.mjs', 'scripts/check-official-headless.mjs',
    'node_modules/@deepseek-ai/dsh/lib/bin.js', 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
    'node_modules/@deepseek-ai/dsh-headless/cordis.patch.yml']) report.inputs[file] = sha256(await readFile(path.join(root, file)));
  if (backend === 'native') report.registerSha256 = sha256(await readFile(register));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const patch = [ { id: 'llm-deepseek', config: { apiKeyEnv: KEY_NAME, baseURL, thinking: 'disabled', maxTokens: 512,
    models: [{ id: MODEL, name: MODEL, contextWindow: 131072 }], streamIdleTimeoutMs: 5000 } },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: MODEL } } ];
  await writeFile(path.join(temporary, 'provider.patch.yml'), JSON.stringify(patch, null, 2) + '\n');
  report.checks.patch = { changedEntryIds: patch.map(row => row.id), replacedPlugins: [], disabledPlugins: [] };
  const sessionId = await execute(FIRST);
  const before = (await sessionLogs()).find(log => log.rows[0].id === sessionId);
  assert(before, 'Official JSONL backend must persist the first session');
  assert(before.artifact.events.some(event => event.type === 'todo/write'), 'Official durable log must contain actual todo/write');
  await execute(SECOND, sessionId);
  assert.notEqual(report.runs[0].pid, report.runs[1].pid, 'Resume must run in an independent process');
  const after = (await sessionLogs()).find(log => log.rows[0].id === sessionId);
  assert(after && after.rows.length > before.rows.length, 'Resume must extend the existing official JSONL log');
  assert.deepEqual(after.rows.slice(0, before.rows.length), before.rows, 'Persisted first-turn history must remain unchanged');
  assert(JSON.stringify(after.rows).includes(SECOND_ANSWER));
  assert.equal(requests.filter(row => row.kind === 'resume').length, 1);
  assert.equal(requests.filter(row => row.kind === 'first').length, 2);
  assert.deepEqual(serverErrors, []);
  report.checks.persistence = { backend: '@deepseek-ai/dsh-session-persistence-jsonl', file: before.file, sessionId,
    firstRows: before.rows.length, resumedRows: after.rows.length, firstEvents: before.artifact.events.length, resumedEvents: after.artifact.events.length, firstSha256: before.sha256, resumedSha256: after.sha256,
    prefixPreserved: true, independentProcessResume: true };
} catch (error) { failure = error; }
finally {
  if (active) { active.child.kill('SIGKILL'); await active.done; }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const output = logs.join('\n');
  report.requests = requests.map(row => ({ kind: row.kind, model: row.body.model, messages: row.body.messages.length, tools: row.body.tools?.length ?? 0 }));
  report.warnings = output.split('\n').filter(line => /(?:\bwarning\b|\[W\]|ExperimentalWarning)/.test(line));
  report.diagnostics = output.split('\n').filter(line => !report.warnings.includes(line) && /(?:\[E\]|\berror\b|\bfailed\b)/i.test(line));
  // The official projection cache is explicitly fail-soft, not the durable log.
  // Preserve expected cancellation diagnostics while requiring JSONL resume and
  // a completely drained plugin graph; any other warning remains a failure.
  report.expectedCacheCancellationWarnings = backend === 'native' && report.checks.persistence?.independentProcessResume
    ? report.warnings.filter(line => line.includes('session projection cache:') && /managed continuation belongs to an old episode|STALE_EPISODE/.test(line)) : [];
  if (!failure && (report.warnings.length !== report.expectedCacheCancellationWarnings.length || report.diagnostics.length)) failure = new Error('Official headless emitted unexpected warnings/errors; inspect the acceptance log');
  report.status = failure ? 'failed' : 'passed'; report.finishedAt = new Date().toISOString();
  if (failure) report.error = clean(failure.stack ?? String(failure));
  await writeFile(logPath, output); report.log = path.relative(root, logPath); report.logSha256 = sha256(output);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
console.log(JSON.stringify({ status: report.status, backend, evidence: report.evidence, version: report.version,
  requests: report.requests, persistence: report.checks.persistence, report: path.relative(root, reportPath), ...(failure ? { error: failure.message } : {}) }, null, 2));
if (failure) process.exitCode = 1;
