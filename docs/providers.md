# Providers

The application uses the unmodified official `AgentLoop`, `LlmRuntime`, tool runtime, prompt assembly, session log, and projection registry from the pinned DeepSeek Harness revision. One Rust-backed Cordis context owns their lifetimes. A provider supplies model stream chunks; it does not implement a replacement agent loop.

## Offline scripted demonstration

`src/plugins/scripted-provider.mjs` registers the `scripted` provider and the `demo` model. This is a deterministic integration fixture, not a language model, and does not interpret arbitrary prompts. Its default scenario:

1. Creates a todo list with the official `todo_write` tool.
2. Reads `README.md` through `workspace_read`.
3. Writes `DEMO_RESULT.md` through `workspace_write`.
4. Completes the todo list and returns a final answer.

Progress is reconstructed from actual assistant calls and their tool results in the request history. Replacing the adapter does not reset progress; replaying the same request does not skip a step. A failed tool stops the scenario and reports the tool's error. An unavailable tool stops before dispatch. A missing or mismatched result rejects the request rather than repeating an operation with an unknown outcome. Each new human message starts the scenario again, with distinct call ids.

Custom integration scenarios can configure `steps: [{ name, arguments }]` and `finalText`. Arguments must be lossless JSON. The provider observes the request `AbortSignal`. It does not invent token usage, silently invoke tools, or claim to have used a remote model.

## Official DeepSeek transport

The `DeepSeekApiKey` export is the unchanged official `@deepseek-ai/dsh-llm-deepseek-api-key` plugin. Mount it after `LlmRuntime`:

```js
await ctx.plugin(DeepSeekApiKey, {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  maxTokens: 4096,
  thinking: 'disabled',
});
const agent = await ctx.agentLoop.create(SessionId('my-session'), {
  provider: 'deepseek-official',
  model: process.env.DEEPSEEK_MODEL,
}, { cwd: workspace });
agent.followup(createUserMessage({
  content: [{ type: 'text', text: prompt }],
  source: { kind: 'user' },
}));
await agent.whenIdle();
```

Set `DEEPSEEK_API_KEY` in the launching environment and choose a model supported by your account. Do not store keys in plugin configuration, transcripts, examples, or committed files. The official plugin resolves credentials for each request; a credentials service is optional for this CLI composition.

In the pinned source, the default API root is `https://api.deepseek.com/anthropic`; the adapter sends Messages SSE requests to `/v1/messages`. It sends `x-api-key`, `anthropic-version`, the official attribution header, and Harness session/user attribution. This is the official Messages adapter, not an OpenAI-compatible `/chat/completions` client. Configure `baseURL` or the trusted launch environment's `DEEPSEEK_BASE_URL` when using another compatible endpoint. A local SSE test endpoint can exercise the same official transport without a paid model call.

The official transport may create an anonymous identifier under `DSH_HOME` (default `~/.dsh`) on first use. Set `DSH_HOME` to an application-owned directory if you want this state separate from an existing Harness installation. Image attachments, file uploads, account login, retries configured by separate plugins, and credential management are optional capabilities beyond the text/tool CLI composition.

This project's tests and demo make no live paid-model request. Passing a local Messages fixture confirms the integration exercised by that fixture; it does not establish current account/model availability or all remote API behavior.

## Extending the composition

A provider plugin declares `inject = ['llm']` and calls `ctx.llm.registerAdapter([providerName], adapter)`. An adapter extends the official `LlmAdapter` and implements `async *stream(request)`. The runtime owns registration cleanup under the provider plugin's fiber. Tool plugins independently declare `inject = ['tools']` and register with the official `defineTool` API; the official loop assembles tool schemas, validates execution, appends results, and requests the next model step.

Use explicit provider/model routes in agent options. Mount the same plugin code with distinct configured provider names when multiple routes are needed. Keep a single Cordis runtime and route all official `@deepseek-ai/cordis` imports through the compatibility registration used by the application commands.
