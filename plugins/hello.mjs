import { defineTool } from '@cordis-harness/app/plugin-api';

export const name = 'hello';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  const prefix = config.prefix ?? 'Hello';
  if (typeof prefix !== 'string' || prefix.length > 200) {
    throw new Error('hello.prefix must be a string of at most 200 characters');
  }
  // Registration belongs to this plugin context and is removed when its Fiber is disposed.
  ctx.tools.register(defineTool({
    name: 'hello',
    description: 'Greet a name using the configured prefix.',
    parameters: { name: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        greeting: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: value.greeting }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      if (args.name.length > 200) throw new Error('name must be at most 200 characters');
      return { greeting: `${prefix}, ${args.name}!` };
    },
  }));
}
