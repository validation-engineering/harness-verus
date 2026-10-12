import { appendFile, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '../../src/plugin-api.mjs';
import { rejectRetainedWait } from './wait-probe.mjs';

export const name = 'recovery-example';
const event = (config, type) => appendFile(join(config.directory, 'plugin-events.jsonl'),
  JSON.stringify({ type, version: config.version }) + '\n');

const FileJournal = {
  name: 'recovery-file-journal',
  async apply(ctx, config) {
    const file = await open(join(config.directory, `journal-${config.version}.jsonl`), 'a');
    ctx.effect(() => async () => {
      await file.close();
      await event(config, 'provider-closed');
    }, 'close journal file');
    await event(config, 'provider-opened');
    ctx.provide('recoveryJournal', {
      async append(type) {
        await file.write(JSON.stringify({ type, version: config.version }) + '\n');
        await file.sync();
      },
    });
  },
};

const checkpointTool = provider => ({
  name: 'recovery-checkpoint-tool',
  inject: ['tools', 'recoveryJournal'],
  async apply(ctx, config) {
    const journal = ctx.recoveryJournal;
    // The effect initializer returns before this continuation runs. Its
    // completed scope must not conceal the still-live setup ancestor.
    let setupProbe;
    ctx.effect(() => {
      setupProbe = Promise.resolve().then(() => rejectRetainedWait(ctx, provider, config, 'setup-after-effect'));
    }, 'completed wait probe initializer');
    await setupProbe;
    ctx.tools.register(defineTool({
      name: 'recovery_version',
      description: 'Read the installed recovery example version and append an audit record.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { version: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(_args, exec) {
        exec.signal.throwIfAborted();
        const task = ctx.task(() => rejectRetainedWait(ctx, provider, config, 'owned-task'), 'tool lifecycle wait probe');
        await task.join();
        await journal.append('agent-tool-call');
        await event(config, 'tool-called');
        return { version: config.version };
      },
    }));
    let cleanupAttempts = 0;
    ctx.effect(() => async () => {
      await rejectRetainedWait(ctx, provider, config, `cleanup-${++cleanupAttempts}`);
      await event(config, 'checkpoint-attempt');
      // A directory at this path causes a real filesystem error. On retry this
      // replacement write is repeatable; the audit append follows a successful
      // checkpoint write. This example does not claim crash-atomic multi-file IO.
      await writeFile(join(config.directory, `checkpoint-${config.version}.json`),
        JSON.stringify({ version: config.version, flushed: true }) + '\n');
      await journal.append('consumer-flushed');
      await event(config, 'checkpoint-succeeded');
    }, 'persist final checkpoint');
    ctx.effect(() => () => event(config, 'one-shot-released'), 'release one-shot marker');
  },
});

export async function apply(ctx, config) {
  if (!['v1', 'v2'].includes(config.version) || typeof config.directory !== 'string') {
    throw new TypeError('The recovery example requires directory and version v1 or v2');
  }
  const provider = await ctx.plugin(FileJournal, config);
  await ctx.plugin(checkpointTool(provider), config);
}
