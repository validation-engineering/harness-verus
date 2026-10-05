import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/app.mjs';

const base = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(tmpdir() + '/cordis-app-');
  await writeFile(root + '/README.md', 'Use real official plugins.');
  const config = { base, workspace: root, sessionDirectory: root + '/sessions',
    provider: { type: 'scripted', model: 'demo' },
    plugins: [{ id: 'todo', module: 'official:todo' }, { id: 'workspace', module: 'local:workspace', config: { allowWrite: true } }], ...overrides };
  const apps = [];
  const open = async next => { const app = await createHarness({ ...config, ...next }); apps.push(app); return app; };
  t.after(async () => { try { for (const app of apps.reverse()) await app.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  return { root, config, open, app: await open() };
}

test('real official loop composes official todo and custom workspace and persists a successful turn', async t => {
  const { app, root } = await fixture(t);
  const result = await app.run('Complete the demo', { sessionId: 'complete' });
  assert.equal(result.ok, true); assert.match(result.answer, /Scripted demo completed/);
  assert.deepEqual(result.toolCalls.map(call => call.name), ['todo_write', 'workspace_read', 'workspace_write', 'todo_write']);
  assert.match(await readFile(root + '/DEMO_RESULT.md', 'utf8'), /official AgentLoop/);
  assert.equal(result.projection.values.todos.every(todo => todo.status === 'completed'), true);
  const stored = await app.inspect('complete', 0, 200);
  assert.equal(stored.events.length, result.eventCount);
  assert.equal(stored.events.at(-1).type, 'turn/end');
  assert.equal((await app.sessions())[0].header.id, 'complete');
});

test('official agents.resume restores persisted history after the first app is fully closed', async t => {
  const { app, open } = await fixture(t);
  const first = await app.run('First turn', { sessionId: 'restart' });
  await app.close();
  const restored = await open();
  const second = await restored.run('Second turn', { sessionId: 'restart', resume: true });
  assert.equal(second.ok, true); assert.equal(second.toolCalls.length, 4);
  const log = await restored.inspect('restart', 0, 500);
  assert.equal(log.events.filter(event => event.type === 'user/message').length, 2);
  assert.equal(log.events.filter(event => event.type === 'turn/end').length, 2);
  assert.ok(log.events.length > first.eventCount);
});

test('read-only tool rejection is a failed application outcome, never an empty successful turn', async t => {
  const { app, root } = await fixture(t, { plugins: [{ id: 'todo', module: 'official:todo' }, { id: 'workspace', module: 'local:workspace', config: { allowWrite: false } }] });
  const result = await app.run('Try the demo');
  assert.equal(result.ok, false); assert.equal(result.toolErrors.length, 1);
  assert.match(result.answer, /stopped.*workspace_write/);
  await assert.rejects(readFile(root + '/DEMO_RESULT.md'), { code: 'ENOENT' });
});

test('custom plugin loads, unloads, reloads configuration and restores the old plugin after failed reload', async t => {
  const { app } = await fixture(t, { provider: { type: 'scripted', model: 'demo', options: { steps: [{ name: 'hello', arguments: { name: 'Ada' } }] } } });
  await app.loadPlugin({ id: 'hello', module: './plugins/hello.mjs', config: { prefix: 'One' } });
  assert.equal((await app.run('Say hello')).ok, true);
  await app.reloadPlugin('hello', { prefix: 'Two' });
  const result = await app.run('Say hello again');
  const log = await app.inspect(result.sessionId);
  assert.match(JSON.stringify(log.events), /Two.*Ada/);
  await app.unloadPlugin('hello'); assert.equal(app.tools().some(tool => tool.name === 'hello'), false);
  assert.equal((await app.run('Missing hello')).ok, false);
  await app.loadPlugin({ id: 'hello', module: './plugins/hello.mjs', config: { prefix: 'Restored' } });
  await assert.rejects(app.reloadPlugin('hello', { prefix: 7 }));
  assert.equal((await app.run('After rejected reload')).ok, true);
});

test('one allowed model step runs, then the next step hits the deterministic limit', async t => {
  const { app } = await fixture(t, { limits: { maxSteps: 1 } });
  const result = await app.run('Bound the loop');
  assert.equal(result.ok, false); assert.equal(result.reason.kind, 'error');
  assert.equal(result.toolCalls.length, 1); assert.match(JSON.stringify(result.reason), /StepLimitExceeded/);
});

test('context admission refuses oversized requests and retains the complete human input in the log', async t => {
  const { app } = await fixture(t, { limits: { maxContextBytes: 100 } });
  const prompt = 'Keep this complete instruction. '.repeat(20);
  const result = await app.run(prompt);
  assert.equal(result.ok, false); assert.match(JSON.stringify(result.reason), /ContextLimitExceeded/);
  const log = await app.inspect(result.sessionId);
  assert.ok(JSON.stringify(log.events).includes(prompt));
});

test('simultaneous run and plugin mutation is refused and close joins actual in-flight work', async t => {
  const { app } = await fixture(t);
  const run = app.run('Start a real turn');
  await assert.rejects(app.unloadPlugin('workspace'), /HarnessBusy/);
  const settled = Promise.allSettled([run, app.close()]);
  const results = await settled;
  assert.equal(results[1].status, 'fulfilled');
  await assert.rejects(app.run('After close'), /closing/);
  assert.equal(app.ctx.snapshot().plugins.length, 0);
});


test('cancel covers a queued run before the official agent is created and permits the next run', async t => {
  const { app } = await fixture(t);
  const running = app.run('Cancel before creation', { sessionId: 'cancel-queued' });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  app.cancel();
  await rejected;
  assert.equal((await app.sessions()).some(row => row.header.id === 'cancel-queued'), false);
  assert.equal((await app.run('A new turn after cancellation')).ok, true);
});

test('cancel reaches in-progress official agent creation before any model request', async t => {
  const { app } = await fixture(t);
  let entered, release, creationSignal, requests = 0;
  const arrived = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const stop = app.ctx.on('agent/created', async ({ signal }) => {
    creationSignal = signal;
    entered();
    await barrier;
  });
  const stopRequests = app.ctx.on('agent/request', () => { requests++; });
  const running = app.run('Cancel while creating', { sessionId: 'cancel-creating' });
  const rejected = assert.rejects(running, /cancel|abort/i);
  try {
    await arrived;
    app.cancel();
    assert.equal(creationSignal.aborted, true);
  } finally { release(); }
  await rejected;
  assert.equal(requests, 0);
  assert.equal(app.ctx.agents.get('cancel-creating'), undefined);
  await stop(); await stopRequests();
  assert.equal((await app.run('Create another agent')).ok, true);
});
