import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Context } from '@cordis-verus/compat-harness';
import {
  AgentLoop, AgentRegistry, DeepSeekApiKey, LlmRuntime, SessionId, SessionStore,
  SessionProjectionRegistry, SystemPrompt, ToolRuntime, ToolTodo,
  createLaunchEnvironmentSnapshot, createUserMessage,
} from '../dist/upstream/plugins.mjs';

const MODEL = 'local-messages-fixture';
const KEY_NAME = 'CORDIS_HARNESS_TEST_API_KEY';
const FAKE_KEY = 'local-fixture-only-not-a-real-credential';
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const start = { type: 'message_start', message: {
  id: 'msg-fixture', model: MODEL, usage: { input_tokens: 3, output_tokens: 0 },
} };
const finish = stop => [
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const textEvents = text => [start,
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 }, ...finish('end_turn'),
];

async function harness(t, respond) {
  const requests = [];
  const serverErrors = [];
  const server = createServer(async (request, response) => {
    try {
      const buffers = [];
      for await (const buffer of request) buffers.push(buffer);
      const recorded = { url: request.url, headers: request.headers,
        body: JSON.parse(Buffer.concat(buffers).toString('utf8')) };
      requests.push(recorded);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      await respond(recorded, response, requests.length);
    } catch (error) {
      serverErrors.push(error);
      response.destroy(error);
    }
  });
  const home = await mkdtemp(path.join(tmpdir(), 'cordis-harness-http-'));
  const previousHome = process.env.DSH_HOME;
  const previousKey = process.env[KEY_NAME];
  process.env.DSH_HOME = home;
  process.env[KEY_NAME] = FAKE_KEY;
  const ctx = new Context();
  t.after(async () => {
    // Close this test's server first so a failed assertion cannot strand a live request.
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    try { await ctx.fiber.dispose(); }
    finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      if (previousKey === undefined) delete process.env[KEY_NAME];
      else process.env[KEY_NAME] = previousKey;
      await rm(home, { recursive: true, force: true });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  // The provider sees only explicit fixture settings, never ambient real credentials.
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
    { source: 'process', values: { [KEY_NAME]: FAKE_KEY } },
  ]));
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin, plugin === SystemPrompt ? { personaPrefix: 'Local transport integration test.' } : {});
  }
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(ToolTodo, { allowParallelInProgress: false });
  await ctx.plugin(DeepSeekApiKey, {
    apiKeyEnv: KEY_NAME, baseURL: `http://127.0.0.1:${port}`,
    thinking: 'disabled', maxTokens: 512,
    models: [{ id: MODEL, name: MODEL, contextWindow: 8192 }],
    streamIdleTimeoutMs: 5000,
  });
  const agent = await ctx.agentLoop.create(SessionId(`http-${port}`), {
    provider: 'deepseek-official', model: MODEL, maxTokens: 512,
  });
  return { ctx, agent, requests, serverErrors };
}

function send(agent) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise the local fixture.' }], source: { kind: 'user' } }));
}
const ending = agent => agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason;

test('official DeepSeek HTTP adapter executes an official tool through the official loop', async t => {
  const todos = [{ content: 'Confirm the official tool call', status: 'completed' }];
  const { ctx, agent, requests, serverErrors } = await harness(t, (_request, response, count) => {
    if (count === 1) {
      response.end(sse([start,
        { type: 'content_block_start', index: 0, content_block: {
          type: 'tool_use', id: 'local-todo-call', name: 'todo_write', input: { todos },
        } },
        { type: 'content_block_stop', index: 0 }, ...finish('tool_use'),
      ]));
    } else {
      response.end(sse(textEvents('The official todo tool completed.')));
    }
  });
  send(agent);
  await agent.whenIdle();
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(ending(agent), { kind: 'completed' });
  assert.equal(requests.length, 2);
  const first = requests[0];
  assert.equal(first.url, '/v1/messages');
  assert.equal(first.headers['x-api-key'], FAKE_KEY);
  assert.equal(first.headers['anthropic-version'], '2023-06-01');
  assert.match(first.headers['user-agent'], /^deepseek-harness\//);
  assert.equal(first.body.model, MODEL);
  assert.equal(first.body.max_tokens, 512);
  assert.equal(first.body.stream, true);
  assert(first.body.tools.some(tool => tool.name === 'todo_write'));
  assert.match(JSON.stringify(first.body.system), /Local transport integration test/);
  assert.match(JSON.stringify(first.body.messages), /Exercise the local fixture/);
  assert(requests[1].body.messages.some(message => message.content.some(block =>
    block.type === 'tool_result' && block.tool_use_id === 'local-todo-call')));
  assert.deepEqual(ctx.sessionProjections.stateOf(agent.session, 'todos'), todos);
  const events = agent.session.snapshotEvents();
  assert.equal(events.filter(event => event.type === 'tool/result').length, 1);
  assert.match(JSON.stringify(events), /The official todo tool completed/);
  assert(!JSON.stringify(events).includes(FAKE_KEY), 'credentials must not enter session history');
});

test('cancelling the official loop aborts an in-flight official HTTP stream', async t => {
  const entered = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const { agent, requests, serverErrors } = await harness(t, (_request, response) => {
    response.on('close', closed.resolve);
    response.write(sse([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    ]));
    entered.resolve();
    // Deliberately keep the transport open until the client aborts it.
  });
  send(agent);
  await entered.promise;
  agent.cancel({ kind: 'user' });
  await agent.whenIdle();
  await closed.promise;
  assert.equal(requests.length, 1);
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(ending(agent), { kind: 'aborted', reason: { kind: 'user' } });
});

test('malformed official provider stream records a real turn error', async t => {
  const { agent, requests, serverErrors } = await harness(t, (_request, response) => {
    response.end(sse([start, { type: 'message_stop' }]));
  });
  send(agent);
  await agent.whenIdle();
  assert.deepEqual(serverErrors, []);
  assert.equal(requests.length, 1);
  assert.equal(ending(agent)?.kind, 'error');
  assert(ending(agent).error.code, 'protocol failure must preserve its structured error');
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'tool/result').length, 0);
});
