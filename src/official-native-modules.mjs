// Trusted host integration; native entries remain ordinary official Loader fibers.
import { createRustModulePlugin, beginRustModuleMigration } from '@validation-engineering/cordis-loader/rust-module-plugin';
import { officialTransaction } from './integrations/deepseek-loader.mjs';
import { readNativeModule } from './native-module-artifacts.mjs';
import { createNativeBuildWatcher } from './native-build-watch.mjs';

const installed = new WeakSet();
export const nativeModuleSpecifier = 'cordis:rust-module';
export function installOfficialRustModules({ EntryTree, Schema }) {
  if (installed.has(EntryTree)) return;
  if (typeof EntryTree?.prototype?.import !== 'function') throw new TypeError('Expected the pinned official EntryTree');
  const original = EntryTree.prototype.import, domains = new WeakMap();
  EntryTree.prototype.import = function (name, getOuterStack) {
    if (name !== nativeModuleSpecifier) return Reflect.apply(original, this, arguments);
    const domain = this.ctx.fiber._domain;
    if (domain.profile !== 'harness' || typeof getOuterStack !== 'function') throw new Error('Native modules require an owned native Harness entry');
    let entries = domains.get(domain);
    if (!entries) domains.set(domain, entries = new WeakMap());
    let plugin = entries.get(getOuterStack);
    if (!plugin) {
      plugin = createRustModulePlugin(this.ctx.root);
      const validateNative = plugin.Config['~standard'].validate;
      const schema = Schema.object({
        path: Schema.string().required().description('Absolute path to an immutable trusted native library.'),
        sha256: Schema.string().required().description('Expected SHA-256 of that library.'),
        plugins: Schema.array(Schema.object({
          id: Schema.string().required(), factory: Schema.string().required(), config: Schema.any(),
          state: Schema.const('migrate').description('Explicitly transfer the factory logical checkpoint across native updates.'),
        })).required().description('Native factories and their JSON configuration. An empty list disables the group.'),
      });
      const standard = schema['~standard'];
      Object.defineProperty(schema, '~standard', { value: { ...standard, validate(raw) {
        const checked = standard.validate(raw);
        if (checked.issues) return checked;
        const value = { ...checked.value };
        // Schemastery can materialize an absent optional property as undefined;
        // preserve the native transport's strict JSON contract.
        if (Array.isArray(value.plugins)) value.plugins = value.plugins.map(recipe => {
          const captured = { ...recipe };
          if (captured.config === undefined) delete captured.config;
          if (captured.state === undefined) delete captured.state;
          return captured;
        });
        return validateNative(value);
      } } });
      plugin = { ...plugin, Config: schema };
      entries.set(getOuterStack, plugin);
    }
    return plugin;
  };
  installed.add(EntryTree);
}

async function ready(ctx, ids) {
  await ctx.loader.await();
  await ctx.settle();
  for (const id of ids) {
    const entry = ctx.loader.resolve(id);
    if (entry.disabled || !entry.fiber) throw new Error(`Required native module consumer is unavailable: ${id}`);
    await entry.fiber.await();
    if (entry.fiber.state !== 2) throw new Error(`Required native module consumer is not active: ${id}`);
  }
}

/** Persist and reconcile using the real ConfigEditor, including selected consumers. */
export async function updateOfficialRustModule(ctx, entryId, manifestPath, { sha256, readyEntries = [] } = {}) {
  const required = [...readyEntries];
  if (typeof entryId !== 'string' || !required.every(id => typeof id === 'string')) throw new TypeError('Entry IDs must be strings');
  const candidate = await readNativeModule(manifestPath, { sha256 });
  let updateFailure;
  return officialTransaction(ctx, async () => {
    const entry = ctx.loader.resolve(entryId), editor = ctx.configEditor;
    if (entry.options.name !== nativeModuleSpecifier || !entry.fiber || entry.disabled) throw new Error('Native module entry is unavailable');
    const before = structuredClone(entry.options.config);
    const migration = await beginRustModuleMigration(ctx, entry.fiber);
    try {
      await editor.edit(entry, () => structuredClone(candidate.config));
      await ready(ctx, [entryId, ...required]);
      migration.commit();
    } catch (cause) {
      let restored = false, recovery;
      try {
        migration.rollback();
        // ConfigEditor already rolls back activation failures. This also covers
        // a provider that activated but whose required consumer failed.
        await editor.edit(entry, () => structuredClone(before));
        await ready(ctx, [entryId, ...required]);
        // Acceptance includes the selected consumers, on recovery as well as
        // upgrade. An active native provider alone cannot release the source.
        migration.commit();
        restored = true;
      } catch (error) { recovery = error; }
      const error = new Error(restored ? 'Native module update failed; previous configuration is active' : 'Native module update and restoration failed',
        { cause: recovery ? new AggregateError([cause, recovery]) : cause });
      error.code = 'OFFICIAL_NATIVE_UPDATE_FAILED';
      error.details = { restored, entryId };
      updateFailure = error;
      throw error;
    } finally { migration.release(); }
    return { entryId, manifestPath: candidate.manifestPath, manifestSha256: candidate.manifestSha256,
      fiberId: entry.fiber.id, readyEntries: required };
  }).catch(error => {
    if (!updateFailure || error === updateFailure) throw error;
    // The Loader can add real lifecycle/persistence failures after the callback
    // rejected. Keep every cause while preserving this helper's recovery result.
    const combined = new AggregateError([updateFailure, error], updateFailure.message, { cause: error });
    combined.code = updateFailure.code;
    combined.details = updateFailure.details;
    throw combined;
  });
}

/** Called only by the application host; never create a watcher inside setup. */
export function watchOfficialRustModule(ctx, options) {
  const { entryId, artifact, readyEntries = [], ...watch } = options;
  if (typeof artifact !== 'function') throw new TypeError('A verified artifact reader is required');
  return createNativeBuildWatcher({ ...watch, apply: async result => {
    const candidate = await artifact(result);
    return updateOfficialRustModule(ctx, entryId, candidate.manifestPath,
      { sha256: candidate.manifestSha256, readyEntries });
  } });
}
