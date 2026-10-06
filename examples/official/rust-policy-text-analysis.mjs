import { defineTool } from '../../src/official-plugin-api.mjs';

export const name = 'cordis-harness-rust-policy-text-analysis';
export const inject = ['tools', 'rustPolicyText'];

export function apply(ctx) {
  const lifetime = new AbortController(), active = new Set();
  ctx.effect(() => async () => {
    lifetime.abort(new Error('Rust policy text tool disposed'));
    await Promise.allSettled([...active]);
  });
  ctx.tools.register(defineTool({
    name: 'rust_policy_text_analyze',
    description: 'Normalize text with the configured JavaScript policy, then count it in an independent Rust plugin.',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {
        backend: { type: 'string', required: true }, revision: { type: 'string', required: true },
        policyRevision: { type: 'string', required: true }, bytes: { type: 'integer', required: true },
        characters: { type: 'integer', required: true }, lines: { type: 'integer', required: true },
        words: { type: 'integer', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = AbortSignal.any([exec.signal, lifetime.signal]);
      signal.throwIfAborted();
      // Abort closes the tool admission/result, but it cannot pretend that a JS
      // promise already invoked by Rust has finished. Retain it until landing.
      const pending = (async () => {
        const result = await ctx.rustPolicyText.analyze(args.text);
        signal.throwIfAborted();
        return result;
      })();
      active.add(pending);
      try { return await pending; } finally { active.delete(pending); }
    },
  }));
}
