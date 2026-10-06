import { defineTool } from '../../src/official-plugin-api.mjs';

export const name = 'cordis-harness-rust-resource-text-analysis';
export const inject = ['tools', 'rustTextResources'];

export function apply(ctx) {
  const lifetime = new AbortController(), active = new Set();
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Rust text resource tool disposed'));
    await Promise.allSettled([...active]);
  });
  ctx.tools.register(defineTool({
    name: 'rust_resource_text_analyze',
    description: 'Analyze bounded text through a Rust-owned Unicode chunk stream and a stateful Rust analysis session.',
    parameters: {
      text: { type: 'string', required: true },
      chunkCharacters: { type: 'integer', description: 'Unicode scalar values per chunk (1–4096); defaults to 1024.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {
        backend: { type: 'string', required: true }, revision: { type: 'string', required: true },
        bytes: { type: 'integer', required: true }, characters: { type: 'integer', required: true },
        lines: { type: 'integer', required: true }, words: { type: 'integer', required: true },
        chunks: { type: 'integer', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = AbortSignal.any([exec.signal, lifetime.signal]);
      signal.throwIfAborted();
      const pending = (async () => {
        let stream, session, closing;
        const close = () => closing ??= (async () => {
          // Both closures request cancellation before joining actual completion.
          // An already issued JS audit promise must still finish in its provider.
          const results = await Promise.allSettled([
            Promise.resolve().then(() => stream?.return()),
            Promise.resolve().then(() => session?.close()),
          ]);
          const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
          if (errors.length) throw new AggregateError(errors, 'Rust text resources failed to close');
        })();
        const abort = () => { close().catch(() => {}); };
        try {
          session = ctx.rustTextResources.session();
          stream = ctx.rustTextResources.chunks(args.text, args.chunkCharacters ?? 1024);
          signal.addEventListener('abort', abort, { once: true });
          signal.throwIfAborted();
          for await (const chunk of stream) {
            signal.throwIfAborted();
            await session.call('append', chunk.text);
          }
          signal.throwIfAborted();
          const result = await session.call('snapshot');
          signal.throwIfAborted();
          return result;
        } finally {
          signal.removeEventListener('abort', abort);
          await close();
        }
      })();
      active.add(pending);
      try { return await pending; } finally { active.delete(pending); }
    },
  }));
}
