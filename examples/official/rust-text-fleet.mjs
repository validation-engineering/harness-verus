import { Schema, defineTool } from '../../src/official-plugin-api.mjs';

export const name = 'cordis-harness-rust-text-fleet';
export const inject = ['tools', 'rustTextFleet'];
export const MAX_WORKERS = 16;
export const Config = Schema.object({ workers: Schema.array(Schema.string().pattern(/^[a-z][a-z0-9_]{0,31}$/)).max(MAX_WORKERS).default(['notes', 'code']) });
export function workerNames(worker) {
  if (typeof worker !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(worker)) throw new Error('worker must match [a-z][a-z0-9_]{0,31}');
  return { service: `rustFleet_${worker}`, tool: `rust_text_${worker}_analyze` };
}
const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };

export async function apply(ctx, config) {
  const manager = ctx.rustTextFleet, workers = new Map();
  let closing = false, tail = Promise.resolve();
  function serialize(action) {
    if (closing) return Promise.reject(new Error('Text fleet is closing'));
    const pending = tail.then(action);
    tail = pending.catch(() => {});
    return pending;
  }
  async function remove(worker) {
    workerNames(worker);
    const entry = workers.get(worker);
    // Retain both the real Fiber and native handle until actual removal succeeds.
    if (entry) entry.state = 'retiring';
    if (entry?.consumer) await entry.consumer.dispose();
    const result = await manager.remove(worker);
    workers.delete(worker);
    return result;
  }
  ctx.effect(() => async () => {
    closing = true;
    await tail;
    // A bridge episode owns consumers, not the manager's logical catalog.
    // Its native workers are retired by their actual Rust manager owner. A
    // bridge-only restart reconnects them; only the remove tool deletes names.
    const outcomes = await Promise.allSettled([...workers.values()].map(entry => entry.consumer?.dispose()));
    const errors = outcomes.filter(item => item.status === 'rejected').map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, 'Text fleet consumers could not be removed');
  });
  async function connect(worker, existing = false) {
    const names = workerNames(worker);
    if (workers.has(worker)) throw new Error(`Worker ${worker} already exists; remove it before retrying creation`);
    if (workers.size >= MAX_WORKERS) throw new Error(`Text fleet supports at most ${MAX_WORKERS} workers`);
    const entry = { worker, ...names, consumer: undefined, state: 'creating' };
    workers.set(worker, entry);
    try {
      const published = await (existing ? manager.ready(worker) : manager.create(worker));
      const plugin = { name: `text-fleet-consumer:${worker}`, inject: ['tools', names.service], apply(child) {
        const lifetime = new AbortController(), active = new Set();
        child.effect(() => async () => {
          lifetime.abort(new Error(`Worker ${worker} consumer disposed`));
          await Promise.allSettled([...active]);
        });
        child.tools.register(defineTool({ name: names.tool, description: `Analyze text with the dynamically published Rust worker ${worker}.`,
          parameters: { text: { type: 'string', required: true } }, output, isConcurrencySafe: () => true,
          async execute({ text }, exec) {
            const signal = AbortSignal.any([exec.signal, lifetime.signal]); signal.throwIfAborted();
            const pending = (async () => { const value = await child[names.service].analyze(text); signal.throwIfAborted(); return value; })();
            active.add(pending);
            try { return await pending; } finally { active.delete(pending); }
          },
        }));
      } };
      const known = new Set(ctx.registry.get(plugin)?.fibers ?? []);
      try { entry.consumer = ctx.plugin(plugin).ctx.fiber; }
      catch (error) {
        // A synchronous observer can fail after the real graph allocation.
        // Keep that Fiber if it still exists, so remove joins its disposal.
        entry.consumer = [...ctx.registry.get(plugin)?.fibers ?? []]
          .find(fiber => !known.has(fiber) && fiber.parent.fiber === ctx.fiber);
        throw error;
      }
      await entry.consumer.await();
      if (entry.consumer.state !== 2) throw new Error(`Worker ${worker} consumer did not become active`);
      entry.state = 'active';
      return { ...published, tool: names.tool, consumerId: entry.consumer.id };
    } catch (error) {
      entry.state = 'failed';
      throw error;
    }
  }
  // Initial publication happens after the native manager is Active. Its own
  // setup must not await a child whose private dependency is that same manager.
  if (new Set(config.workers).size !== config.workers.length) throw new Error('Initial workers must have unique names');
  const resumed = await manager.resumeCatalog(config.workers);
  for (const worker of resumed.workers) await connect(worker, resumed.seeded);
  const controls = [
    ['rust_text_worker_create', 'Publish a new Rust worker and mount its real tool consumer.', { worker: { type: 'string', required: true } }, ({ worker }) => connect(worker)],
    ['rust_text_worker_remove', 'Drain and remove the tool consumer, then retire and join its Rust worker.', { worker: { type: 'string', required: true } }, ({ worker }) => remove(worker)],
    ['rust_text_worker_list', 'Inspect actual native child state and the corresponding tool consumers.', {}, async () => ({ ...(await manager.list()), consumers: [...workers.values()].map(({ worker, tool, consumer, state }) => ({ worker, tool, consumerId: consumer?.id ?? null, state })) })],
  ];
  for (const [tool, description, parameters, run] of controls) ctx.tools.register(defineTool({ name: tool, description, parameters, output,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      // Administrative mutations are serialized and joined to completion. An
      // aborted caller does not roll back a successfully published graph node.
      const result = await serialize(() => run(args));
      exec.signal.throwIfAborted();
      return result;
    },
  }));
}
