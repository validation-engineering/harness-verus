import { Schema } from '../../src/official-plugin-api.mjs';

export const name = 'cordis-harness-text-policy';
export const Config = Schema.object({
  revision: Schema.string().min(1).max(100).default('policy-v1'),
  prefix: Schema.string().max(200).default(''),
  uppercase: Schema.boolean().default(false),
});

/** Ordinary trusted JS service. Hooks let a host observe or supply asynchronous
 * policy work; they are application code, never functions from persisted config.
 */
export function createTextPolicyPlugin({ onEvent, beforeNormalize } = {}) {
  return { name, Config, async apply(ctx, config) {
    const active = new Set();
    let closing = false;
    const event = (type, extra = {}) => onEvent?.({ type, policyRevision: config.revision, ...extra });
    await event('provider-setup');
    ctx.provide('textPolicy', {
      async normalize(text) {
        if (closing) throw new Error('Text policy is closing');
        if (typeof text !== 'string' || Buffer.byteLength(text) > 128 * 1024) throw new Error('Text policy expects at most 128 KiB of UTF-8 text');
        const pending = (async () => {
          await event('normalize-start');
          await beforeNormalize?.({ text, revision: config.revision });
          const normalized = config.prefix + (config.uppercase ? text.toUpperCase() : text);
          await event('normalize-end');
          return { text: normalized, policyRevision: config.revision };
        })();
        active.add(pending);
        try { return await pending; } finally { active.delete(pending); }
      },
      async lifecycle(phase, nativeRevision) {
        if (!['setup', 'cleanup'].includes(phase) || typeof nativeRevision !== 'string') throw new Error('Invalid native lifecycle notification');
        await event(`native-${phase}`, { nativeRevision });
        return null;
      },
    });
    ctx.effect(() => async () => {
      closing = true;
      await Promise.allSettled([...active]);
      await event('provider-cleanup');
    });
  } };
}
export const apply = createTextPolicyPlugin().apply;
