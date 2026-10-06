import { Schema } from '../../src/official-plugin-api.mjs';

export const name = 'cordis-harness-text-fleet-audit';
export const Config = Schema.object({ label: Schema.string().min(1).max(100).default('text-fleet') });
const kinds = new Set(['manager-setup', 'manager-cleanup', 'worker-setup', 'worker-cleanup', 'worker-analyze']);

// This service is ordinary telemetry, not a worker registry or dispatcher.
export function createTextFleetAudit({ beforeRecord, onEvent } = {}) {
  return { name, Config, async apply(ctx, config) {
    let closing = false, sequence = 0;
    const recent = [], active = new Set();
    const event = (type, details = {}) => onEvent?.({ type, label: config.label, ...details });
    await event('provider-setup');
    ctx.provide('textFleetAudit', {
      async record(kind, revision, worker, bytes) {
        if (closing) throw new Error('Text fleet audit is closing');
        if (!kinds.has(kind) || typeof revision !== 'string' || revision.length > 100 ||
          typeof worker !== 'string' || !/^(?:[a-z][a-z0-9_]{0,31})?$/.test(worker) ||
          !Number.isSafeInteger(bytes) || bytes < 0 || bytes > 128 * 1024) throw new Error('Invalid fleet audit event');
        const item = { kind, revision, worker, bytes, sequence: ++sequence };
        const pending = (async () => {
          await event('record-start', item);
          await beforeRecord?.({ ...item, label: config.label });
          recent.push(Object.freeze({ ...item }));
          if (recent.length > 64) recent.shift();
          await event('record-end', item);
          return null;
        })();
        active.add(pending);
        try { return await pending; } finally { active.delete(pending); }
      },
      snapshot() { return { label: config.label, total: sequence, recent: recent.map(item => ({ ...item })) }; },
    });
    ctx.effect(() => async () => {
      closing = true;
      await Promise.allSettled([...active]);
      await event('provider-cleanup');
    });
  } };
}
export const apply = createTextFleetAudit().apply;
