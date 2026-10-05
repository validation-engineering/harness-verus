import { defineTool } from '../../src/official-plugin-api.mjs';

export const name = 'cordis-harness-rust-text-analysis';
export const inject = ['tools'];

export async function apply(ctx) {
  if (typeof ctx.rustPlugin !== 'function') throw new Error('This plugin requires the verified Rust text-analysis addon and native Cordis host');
  await ctx.rustPlugin('harness.text-analysis');
  // The consumer owns the dependency: its tool disappears before Rust teardown.
  await ctx.inject(['rustTextAnalysis'], consumer => {
    consumer.tools.register(defineTool({
      name: 'rust_text_analyze',
      description: 'Count UTF-8 bytes, characters, lines, and words using the native Rust plugin.',
      parameters: { text: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {
          backend: { type: 'string', required: true },
          version: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          characters: { type: 'integer', required: true },
          lines: { type: 'integer', required: true },
          words: { type: 'integer', required: true },
        } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const result = await consumer.rustTextAnalysis.analyze(args.text);
        exec.signal.throwIfAborted();
        return result;
      },
    }));
  });
}
