import { Schema } from '../../src/official-plugin-api.mjs';

export const name = 'cordis-harness-text-resource-audit';
export const Config = Schema.object({ label: Schema.string().min(1).max(100).default('text-resources') });
const kinds = new Set(['native-setup', 'native-cleanup', 'stream-pull', 'stream-close', 'object-append', 'object-close']);

/** Bounded local resource telemetry, containing sizes and lifecycle events but
 * no text content. Trusted host hooks can integrate an asynchronous audit sink.
 */
export function createTextResourceAudit({ beforeRecord, onEvent } = {}) {
  return { name, Config, async apply(ctx, config) {
    const recent = [], active = new Set();
    let closing = false, sequence = 0;
    const event = (type, details = {}) => onEvent?.({ type, label: config.label, ...details });
    await event('provider-setup');
    ctx.provide('textResourceAudit', {
      async record(kind, revision, details) {
        if (closing) throw new Error('Text resource audit is closing');
        if (!kinds.has(kind) || typeof revision !== 'string' || revision.length > 100 ||
          !details || typeof details !== 'object' || Array.isArray(details) ||
          Object.keys(details).some(key => !['bytes', 'offsetBytes'].includes(key) || !Number.isSafeInteger(details[key]) || details[key] < 0 || details[key] > 128 * 1024)) {
          throw new Error('Invalid text resource audit event');
        }
        const item = { kind, revision, ...details, sequence: ++sequence };
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
export const apply = createTextResourceAudit().apply;
