/** Share the definition while each profile supplies its own official defineTool. */
export function registerDynamicTextTool(ctx, defineTool) {
  ctx.tools.register(defineTool({
    name: 'rust_dynamic_text_analyze',
    description: 'Analyze Unicode text using the current Rust dynamic plugin generation.',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {
        backend: { type: 'string', required: true },
        revision: { type: 'string', required: true },
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
      const result = await ctx.rustDynamicText.analyze(args.text);
      exec.signal.throwIfAborted();
      return result;
    },
  }));
}
