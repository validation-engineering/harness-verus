import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LlmAdapter, LlmError, ToolCallId } from '../../dist/upstream/plugins.mjs';

export const name = 'scripted-provider';
export const inject = ['llm'];

/** This is a deterministic integration fixture, not an intelligent model. */
export function demoSteps() {
  return [
    { name: 'todo_write', arguments: { todos: [
      { content: 'Read the workspace README', status: 'in_progress' },
      { content: 'Write DEMO_RESULT.md', status: 'pending' },
    ] } },
    { name: 'workspace_read', arguments: { path: 'README.md' } },
    { name: 'workspace_write', arguments: { path: 'DEMO_RESULT.md', content:
      '# Cordis Harness demo\n\n'
      + 'The official AgentLoop invoked the official todo plugin and the custom workspace tools.\n'
      + 'The README read completed before this file was written.\n'
      + 'This run used a deterministic scripted provider, not a live language model.\n' } },
    { name: 'todo_write', arguments: { todos: [
      { content: 'Read the workspace README', status: 'completed' },
      { content: 'Write DEMO_RESULT.md', status: 'completed' },
    ] } },
  ];
}

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function validatedSteps(steps) {
  if (!Array.isArray(steps) || steps.length > 100) {
    throw new TypeError('scripted-provider steps must be an array with at most 100 entries');
  }
  // JSON round trips reject unsupported payloads before any model request.
  return freeze(steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)
      || typeof step.name !== 'string' || !step.name.trim()
      || step.arguments === null || typeof step.arguments !== 'object' || Array.isArray(step.arguments)) {
      throw new TypeError(`scripted-provider step ${index} requires name and an arguments object`);
    }
    const copy = JSON.parse(JSON.stringify(step.arguments));
    if (!isDeepStrictEqual(copy, step.arguments)) {
      throw new TypeError(`scripted-provider step ${index} arguments must be lossless JSON`);
    }
    return { name: step.name, arguments: copy };
  }));
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

function toolChunks(id, step) {
  const args = JSON.stringify(step.arguments);
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

/** Progress comes exclusively from the current request's actual call/result history. */
export class ScriptedAdapter extends LlmAdapter {
  constructor(options = {}) {
    super();
    const steps = options.steps === undefined ? demoSteps() : options.steps;
    const finalText = options.finalText === undefined ? (options.steps === undefined
      ? 'Scripted demo completed: read README.md, wrote DEMO_RESULT.md, and completed the todo list.'
      : 'Scripted scenario completed: all configured tool results confirmed success.') : options.finalText;
    this.steps = validatedSteps(steps);
    if (typeof finalText !== 'string' || !finalText.trim()) throw new TypeError('finalText must be a non-empty string');
    this.finalText = finalText;
    this.scriptId = createHash('sha256').update(JSON.stringify(this.steps)).digest('hex').slice(0, 12);
  }

  providerInfo(provider) {
    return { id: provider, name: 'Scripted offline integration fixture' };
  }

  async listModels(provider) {
    return [{ id: 'demo', provider, name: 'Deterministic demo (no language model)' }];
  }

  async *stream(options) {
    options.signal?.throwIfAborted();
    const messages = options.messages ?? [];
    const start = messages.findLastIndex(message => message.role === 'user'
      && (message.source === undefined || message.source.kind === 'user'));
    if (start < 0) throw new LlmError('Scripted provider requires a user prompt', 'SCRIPT_HISTORY_INVALID');
    const user = messages[start];
    // Stable across adapter replacement/resume; different user turns get different ids.
    const turnId = createHash('sha256').update(JSON.stringify([
      this.scriptId, options.sessionId ?? '', user.id ?? start, user.content,
    ])).digest('hex').slice(0, 20);
    const history = messages.slice(start + 1);
    const calls = history.flatMap(message => message.role === 'assistant'
      ? message.content.filter(block => block.type === 'tool-call') : []);
    let chunks;
    for (let index = 0; index < this.steps.length; index++) {
      const step = this.steps[index];
      const id = ToolCallId(`scripted_${turnId}_${index}`);
      const matches = calls.filter(call => call.id === id);
      if (matches.length > 1) throw new LlmError(`Duplicate scripted call ${index}`, 'SCRIPT_HISTORY_INVALID');
      const call = matches[0];
      const results = history.filter(message => message.role === 'tool' && message.toolCallId === id);
      if (!call) {
        if (results.length) throw new LlmError(`Scripted result ${index} has no call`, 'SCRIPT_HISTORY_INVALID');
        if (!(options.tools ?? []).some(tool => tool.name === step.name)) {
          chunks = textChunks(`Scripted demo stopped: required tool "${step.name}" is unavailable. No later steps were executed.`);
        } else {
          chunks = toolChunks(id, step);
        }
        break;
      }
      let args;
      try { args = JSON.parse(call.arguments); }
      catch { throw new LlmError(`Invalid scripted arguments at step ${index}`, 'SCRIPT_HISTORY_INVALID'); }
      if (call.name !== step.name || !isDeepStrictEqual(args, step.arguments) || results.length !== 1) {
        throw new LlmError(`Scripted step ${index} lacks one matching, settled tool result`, 'SCRIPT_HISTORY_INVALID');
      }
      const result = results[0];
      if (result.isError !== false) {
        const detail = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 1_000);
        chunks = textChunks(`Scripted demo stopped: tool "${step.name}" failed or did not confirm success.${detail ? ` ${detail}` : ''} No later steps were executed.`);
        break;
      }
    }
    for (const chunk of chunks ?? textChunks(this.finalText)) {
      options.signal?.throwIfAborted();
      yield chunk;
    }
  }
}

export function apply(ctx, config = {}) {
  const { provider = 'scripted', ...options } = config;
  if (typeof provider !== 'string' || !provider.trim()) throw new TypeError('scripted provider name must be non-empty');
  // LlmRuntime owns this registration as an effect of this plugin's fiber.
  ctx.llm.registerAdapter([provider], new ScriptedAdapter(options));
}
