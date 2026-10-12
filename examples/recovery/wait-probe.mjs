import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertWaitObservation, errorRecord } from '../../src/recovery-contract.mjs';

/** Attempt a real lifecycle wait from the current managed callback. */
export async function rejectRetainedWait(ctx, provider, config, phase) {
  const before = ctx.snapshot();
  let error;
  try { await provider.dispose(); } catch (cause) { error = errorRecord(cause); }
  const observation = { version: config.version, phase, owner: ctx.fiber.id, provider: provider.id,
    error, before, after: ctx.snapshot() };
  assertWaitObservation(observation);
  await appendFile(join(config.directory, 'wait-events.jsonl'), JSON.stringify(observation) + '\n');
}
