import { setTimeout } from 'node:timers/promises';
import { defineTool, Schema } from '../../src/official-plugin-api.mjs';

export const name = 'cordis-harness-greeting';
export const inject = ['tools'];
export const Config = Schema.object({
  prefix: Schema.string().max(200).default('Hello').volatile(),
});

export function apply(ctx, config) {
  const lifetime = new AbortController();
  const active = new Set();
  // Own every admitted call until it actually settles, including cancellation.
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Greeting plugin disposed'));
    await Promise.allSettled([...active]);
  });
  ctx.tools.register(defineTool({
    name: 'cordis_greet',
    description: 'Greet a name; optionally wait a bounded number of milliseconds. No files or network are accessed.',
    parameters: {
      name: { type: 'string', required: true },
      wait_ms: { type: 'integer' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        greeting: { type: 'string', required: true },
        backend: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = AbortSignal.any([exec.signal, lifetime.signal]);
      signal.throwIfAborted();
      if (args.name.length > 200) throw new Error('name must be at most 200 characters');
      const wait = args.wait_ms ?? 0;
      if (!Number.isInteger(wait) || wait < 0 || wait > 5000) throw new Error('wait_ms must be an integer from 0 to 5000');
      const operation = (async () => {
        if (wait) await setTimeout(wait, undefined, { signal });
        signal.throwIfAborted();
        return { greeting: `${config.prefix.get()}, ${args.name}!`, backend: 'javascript' };
      })();
      active.add(operation);
      try { return await operation; } finally { active.delete(operation); }
    },
  }));
}
