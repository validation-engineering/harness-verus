import '@cordis-verus/compat-harness/register';
import { Context } from '@cordis-verus/compat-harness';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
const {
  AgentRegistry, AgentLoop, SessionStore, SessionId, SystemPrompt, ToolRuntime,
  SessionProjectionRegistry, LlmRuntime, ToolTodo, DeepSeekApiKey, createUserMessage,
} = await import('../dist/upstream/plugins.mjs');
const ScriptedProvider = await import('./plugins/scripted-provider.mjs');
const Workspace = await import('./plugins/workspace.mjs');
import * as Limits from './plugins/limits.mjs';
const { default: FileSessions } = await import('./plugins/file-sessions.mjs');
import { PluginManager } from './plugin-manager.mjs';

export async function readConfig(filename = 'harness.config.json', overrides = {}) {
  const path = resolve(filename);
  const input = JSON.parse(await readFile(path, 'utf8'));
  if (input.schema !== 1) throw new Error('Unsupported Harness configuration schema');
  if (!Array.isArray(input.plugins)) throw new TypeError('plugins must be an array');
  const config = { ...input, ...overrides, base: dirname(path), provider: { ...input.provider, ...overrides.provider } };
  config.workspace = await realpath(resolve(config.base, config.workspace ?? '.'));
  config.sessionDirectory = resolve(config.base, config.sessionDirectory ?? '.cordis-harness/sessions');
  return config;
}

export async function createHarness(config, { onEvent = () => {} } = {}) {
  const ctx = new Context();
  const handles = new Map();
  let operating = false, closing = false, closeTask, activeTurn;
  let activeOperation = Promise.resolve();
  const lifetime = new AbortController();
  const provider = config.provider ?? { type: 'scripted', model: 'demo' };
  const route = provider.type === 'scripted' ? 'scripted' : provider.type === 'deepseek' ? 'deepseek-official' : undefined;
  if (!route) { await ctx.dispose(); throw new Error(`Unknown provider type: ${provider.type}`); }
  let workspace;
  try { workspace = await realpath(config.workspace); } catch (error) { await ctx.dispose(); throw error; }
  const manager = new PluginManager(ctx, config.base ?? process.cwd(), {
    'official:todo': ToolTodo, 'local:workspace': Workspace,
  });
  const resolveSpec = spec => spec.module === 'local:workspace'
    ? { ...spec, config: { ...spec.config, root: workspace } }
    : spec.module === 'official:todo' ? { ...spec, config: { allowParallelInProgress: false, ...spec.config } } : spec;
  const mutate = (operation, turn) => {
    if (closing) return Promise.reject(new Error('Harness is closing'));
    if (operating) return Promise.reject(new Error('HarnessBusy: wait for the active turn or plugin mutation'));
    operating = true;
    activeTurn = turn;
    const work = Promise.resolve().then(operation);
    activeOperation = work;
    return work.finally(() => { operating = false; activeTurn = undefined; });
  };
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin);
    await ctx.plugin(SystemPrompt, { personaPrefix: config.systemPrompt ?? 'You are a careful workspace assistant. Use the available tools, report actual results, and read large files in bounded ranges.' });
    await ctx.plugin(FileSessions, { root: resolve(config.sessionDirectory) });
    await ctx.plugin(provider.type === 'scripted' ? ScriptedProvider : DeepSeekApiKey, provider.options ?? {});
    await ctx.plugin(Limits, config.limits ?? {});
    for (const spec of config.plugins ?? []) if (spec.enabled !== false) await manager.load(resolveSpec(spec));
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    ctx.on('session/event', (session, event) => onEvent({ sessionId: session.id, event }));
  } catch (error) {
    try { await ctx.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Harness initialization and cleanup failed'); }
    throw error;
  }
  const api = {
    ctx,
    isBusy: () => operating,
    plugins: () => manager.list(),
    tools: () => ctx.tools.schemas().map(tool => ({ name: tool.name, description: tool.description })),
    loadPlugin: spec => mutate(() => manager.load(resolveSpec(spec))),
    unloadPlugin: id => mutate(() => manager.unload(id)),
    retryPluginCleanup: id => mutate(() => manager.retryCleanup(id)),
    reloadPlugin: (id, config) => mutate(() => {
      const entry = manager.list().find(entry => entry.id === id);
      return manager.reload(id, entry?.module === 'local:workspace' && config ? { ...config, root: workspace } : config);
    }),
    sessions: () => ctx.sessionPersistence.list(),
    async inspect(id, offset = 0, limit = 50) {
      const handle = await ctx.sessionPersistence.open(SessionId(id), 'read');
      try { return { header: handle.header, ...await handle.read(offset, limit) }; } finally { await handle.close(); }
    },
    cancel() {
      activeTurn?.abort(new DOMException('Turn cancelled by user', 'AbortError'));
      for (const { agent } of handles.values()) agent.cancel({ kind: 'user' });
    },
    run(prompt, { sessionId = randomUUID(), resume = false, signal } = {}) {
      const turn = new AbortController();
      signal = AbortSignal.any([turn.signal, lifetime.signal, ...(signal ? [signal] : [])]);
      return mutate(async () => {
        if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('Prompt must not be empty');
        signal?.throwIfAborted();
        let handle = handles.get(sessionId);
        if (!handle) {
          const agentOptions = { provider: route, model: provider.model ?? (provider.type === 'deepseek' ? 'deepseek-flash' : 'demo'), maxTokens: provider.maxTokens ?? 4096 };
          handle = resume
            ? await ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions, signal })
            : await ctx.agents.create({ sessionId: SessionId(sessionId), agentOptions, meta: { cwd: workspace }, signal });
          // A resumed session must not silently gain a different workspace.
          if (handle.agent.session.header.cwd !== workspace) {
            await handle.dispose(); throw new Error('Session workspace differs from the configured workspace');
          }
          handles.set(sessionId, handle);
        }
        const { agent } = handle;
        const before = agent.session.seq;
        const cancel = () => agent.cancel({ kind: 'user' });
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          signal?.throwIfAborted();
          agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
          await agent.whenIdle();
          await ctx.sessionPersistence.flush();
          const events = agent.session.snapshotEvents().filter(event => event.seq >= before);
          const ending = events.findLast(event => event.type === 'turn/end');
          const failures = events.filter(event => event.type === 'tool/result' && event.data.message.isError);
          const answer = events.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
          const ok = ending?.data.reason.kind === 'completed' && failures.length === 0 && !answer.startsWith('Scripted demo stopped:');
          return { ok, sessionId, provider: provider.type, reason: ending?.data.reason ?? { kind: 'missing-turn-end' }, answer,
            toolCalls: events.filter(event => event.type === 'tool/call').map(event => event.data),
            toolErrors: failures.map(event => event.data), eventCount: events.length,
            projection: ctx.sessionProjections.snapshot(agent.session) };
        } finally { signal?.removeEventListener('abort', cancel); }
      }, turn);
    },
    close() {
      if (closeTask) return closeTask;
      closing = true;
      lifetime.abort(new Error('Harness is closing'));
      api.cancel();
      closeTask = (async () => {
        await activeOperation.catch(() => {});
        // Official handles cancel, await quiescence, flush persistence, and remove their scope.
        const results = await Promise.allSettled([...handles.values()].map(handle => handle.dispose()));
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        try { await ctx.dispose(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, 'Harness cleanup failed');
      })();
      return closeTask;
    },
  };
  return api;
}
