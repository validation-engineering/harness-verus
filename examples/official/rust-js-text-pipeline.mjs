import { defineTool } from '../../src/official-plugin-api.mjs';

export const name = 'cordis-harness-rust-js-text-pipeline';
export const inject = ['tools', 'rustJsTextPipeline'];

export function apply(ctx) {
  const lifetime = new AbortController(), active = new Set();
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Rust JS text pipeline tool disposed'));
    await Promise.allSettled([...active]);
  });
  ctx.tools.register(defineTool({
    name: 'rust_js_text_analyze',
    description: 'Run an independent Rust consumer over a JavaScript text stream and an explicit JavaScript analysis session.',
    parameters: {
      text: { type: 'string', required: true },
      chunkCharacters: { type: 'integer', description: 'Unicode scalar values per chunk (1–4096); defaults to 1024.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {
        backend: { type: 'string', required: true }, revision: { type: 'string', required: true },
        providerRevision: { type: 'string', required: true }, bytes: { type: 'integer', required: true },
        characters: { type: 'integer', required: true }, lines: { type: 'integer', required: true },
        words: { type: 'integer', required: true }, chunks: { type: 'integer', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = AbortSignal.any([exec.signal, lifetime.signal]);
      signal.throwIfAborted();
      const pending = (async () => {
        // Result cancellation cannot fake completion of already invoked JS work.
        // The Rust action owns the stream/object journal and joins their close.
        const result = await ctx.rustJsTextPipeline.analyze(args.text, args.chunkCharacters ?? 1024);
        signal.throwIfAborted();
        return result;
      })();
      active.add(pending);
      try { return await pending; } finally { active.delete(pending); }
    },
  }));
}
