import assert from 'node:assert/strict';
import test from 'node:test';
import { ScriptedAdapter, demoSteps } from '../src/plugins/scripted-provider.mjs';

const user = text => ({ role: 'user', id: `u-${text}`, source: { kind: 'user' }, content: [{ type: 'text', text }] });
const options = (messages, steps = demoSteps()) => ({
  provider: 'scripted', model: 'demo', sessionId: 'test-session', messages,
  tools: steps.map(step => ({ name: step.name, description: step.name, parameters: {} })),
});
async function invoke(adapter, request) {
  const chunks = [];
  for await (const chunk of adapter.stream(request)) chunks.push(chunk);
  return chunks;
}
const callOf = chunks => chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')?.block;
const textOf = chunks => chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('');
function settle(messages, call, isError = false, text = 'ok') {
  return [...messages,
    { role: 'assistant', content: [call], source: { kind: 'model', provider: 'scripted', model: 'demo' } },
    { role: 'tool', toolCallId: call.id, isError, content: [{ type: 'text', text }] },
  ];
}

test('scripted provider advances only after matching actual tool results', async () => {
  const adapter = new ScriptedAdapter();
  let history = [user('demo')];
  const names = [];
  for (const step of demoSteps()) {
    const request = options(history);
    const call = callOf(await invoke(adapter, request));
    assert.equal(call.name, step.name);
    assert.deepEqual(JSON.parse(call.arguments), step.arguments);
    // Replaying the same input never skips an operation.
    assert.deepEqual(callOf(await invoke(adapter, request)), call);
    names.push(call.name);
    history = settle(history, call);
  }
  assert.deepEqual(names, ['todo_write', 'workspace_read', 'workspace_write', 'todo_write']);
  const done = await invoke(adapter, options(history));
  assert.equal(callOf(done), undefined);
  assert.match(textOf(done), /^Scripted demo completed:/);
  assert.equal(done.at(-1).reason.kind, 'stop');
});

test('a replacement adapter reconstructs progress from history', async () => {
  let history = [user('resume')];
  const first = callOf(await invoke(new ScriptedAdapter(), options(history)));
  history = settle(history, first);
  const next = callOf(await invoke(new ScriptedAdapter(), options(history)));
  assert.equal(next.name, 'workspace_read');
});

test('failed tool stops the script without claiming success or running later tools', async () => {
  const adapter = new ScriptedAdapter();
  let history = [user('failure')];
  history = settle(history, callOf(await invoke(adapter, options(history))));
  history = settle(history, callOf(await invoke(adapter, options(history))), true, 'README.md is missing');
  const chunks = await invoke(adapter, options(history));
  assert.equal(callOf(chunks), undefined);
  assert.match(textOf(chunks), /workspace_read.*failed.*README.md is missing/);
  assert.doesNotMatch(textOf(chunks), /demo completed|wrote DEMO_RESULT/);
});

test('unsettled and mismatched calls are rejected instead of replayed', async () => {
  const adapter = new ScriptedAdapter();
  const history = [user('pending')];
  const call = callOf(await invoke(adapter, options(history)));
  await assert.rejects(invoke(adapter, options([...history, { role: 'assistant', content: [call] }])), /settled tool result/);
  await assert.rejects(invoke(adapter, options(settle(history, { ...call, name: 'wrong' }))), /matching/);
});

test('missing tool produces a clear refusal rather than a synthetic success', async () => {
  const request = options([user('missing')]);
  request.tools = [];
  const chunks = await invoke(new ScriptedAdapter(), request);
  assert.equal(callOf(chunks), undefined);
  assert.match(textOf(chunks), /required tool "todo_write" is unavailable/);
});

test('new human input starts a new deterministic scenario with distinct call ids', async () => {
  const adapter = new ScriptedAdapter();
  const firstHistory = [user('first')];
  const first = callOf(await invoke(adapter, options(firstHistory)));
  const secondHistory = [...settle(firstHistory, first), user('second')];
  const second = callOf(await invoke(adapter, options(secondHistory)));
  assert.equal(second.name, 'todo_write');
  assert.notEqual(second.id, first.id);
});

test('custom scripts copy inputs and require successful evidence before final text', async () => {
  const steps = [{ name: 'echo', arguments: { text: 'hello' } }];
  const adapter = new ScriptedAdapter({ steps, finalText: 'Confirmed echo.' });
  steps[0].arguments.text = 'mutated';
  const history = [user('custom')];
  const call = callOf(await invoke(adapter, options(history, steps)));
  assert.deepEqual(JSON.parse(call.arguments), { text: 'hello' });
  assert.equal(textOf(await invoke(adapter, options(settle(history, call), steps))), 'Confirmed echo.');
});

test('abort is observed before yielding and before each following chunk', async () => {
  const abort = new AbortController();
  const request = { ...options([user('abort')]), signal: abort.signal };
  const iterator = new ScriptedAdapter().stream(request);
  assert.equal((await iterator.next()).value.type, 'block-start');
  abort.abort(new Error('test cancellation'));
  await assert.rejects(iterator.next(), /test cancellation/);
  await assert.rejects(invoke(new ScriptedAdapter(), request), /test cancellation/);
});

test('malformed or lossy custom script payloads fail before registration', () => {
  assert.throws(() => new ScriptedAdapter({ steps: [{ name: '', arguments: {} }] }), /requires name/);
  assert.throws(() => new ScriptedAdapter({ steps: [{ name: 'echo', arguments: { value: Infinity } }] }), /lossless JSON/);
  assert.throws(() => new ScriptedAdapter({ steps: [{ name: 'echo', arguments: { value: undefined } }] }), /lossless JSON/);
});


test('custom scripts without finalText do not claim default demo operations', async () => {
  const steps = [];
  const chunks = await invoke(new ScriptedAdapter({ steps }), options([user('empty')], steps));
  assert.match(textOf(chunks), /Scripted scenario completed/);
  assert.doesNotMatch(textOf(chunks), /README|DEMO_RESULT/);
});

test('a result without explicit success confirmation stops the scenario', async () => {
  const adapter = new ScriptedAdapter();
  const history = [user('unknown')];
  const call = callOf(await invoke(adapter, options(history)));
  const uncertain = settle(history, call);
  delete uncertain.at(-1).isError;
  const chunks = await invoke(adapter, options(uncertain));
  assert.match(textOf(chunks), /did not confirm success/);
  assert.equal(callOf(chunks), undefined);
});
