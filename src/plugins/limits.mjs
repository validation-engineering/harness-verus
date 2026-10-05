export const name = 'harness-limits';
export const inject = ['llm'];
export function apply(ctx, { maxSteps = 16, maxContextBytes = 262144 } = {}) {
  for (const [name, value] of Object.entries({ maxSteps, maxContextBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  ctx.on('agent/request', async ({ step }, next) => {
    if (step > maxSteps) throw new Error(`StepLimitExceeded: maximum ${maxSteps} model steps per turn`);
    return next();
  });
  ctx.on('llm/stream', async function* (request, next) {
    const bytes = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }));
    if (bytes > maxContextBytes) {
      throw new Error(`ContextLimitExceeded: ${bytes} bytes exceeds ${maxContextBytes}; transcript retained. Read smaller file ranges or start a new session.`);
    }
    yield* next();
  });
}
