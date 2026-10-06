import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fixture, assertRevision, SettingsForms, watchOfficialRustModule, readNativeModule } from './native-loader-fixture.mjs';

test('official Loader native entries expose a normal ConfigEditor schema and call a real Rust library', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    assert.equal(f.entry.options.name, 'cordis:rust-module');
    const schema = f.entry.fiber.runtime.Config;
    assert.equal(SettingsForms.prototype.schema.call({}, f.entry), schema, 'The official settings schema projector recognizes the native entry');
    assert.equal(typeof schema.toJSON, 'function');
    assert.equal(schema.type, 'object');
    assert.deepEqual(Object.keys(schema.dict).sort(), ['path', 'plugins', 'sha256']);
    assert.equal(schema.dict.path.type, 'string');
    assert.equal(schema.dict.sha256.type, 'string');
    assert.equal(schema.dict.plugins.type, 'array');
    const row = f.editor.configuration().find(row => row.entry === f.entry);
    assert(row, 'ConfigEditor exposes the same official Loader entry to the default settings UI');
    assert.deepEqual(row.inherited, f.manifests.v1.config);
    await assertRevision(f, 'v1');
  } finally { await f.dispose(); }
});

test('official ConfigEditor replaces v1 with v2 in the same Driver and PID and persists exact recipes', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const oldService = f.ctx.rustDynamicText;
    await assertRevision(f, 'v1');
    const result = await f.update('v2');
    assert.equal(result.entryId, f.entry.id);
    assert.equal(result.manifestSha256, f.manifests.v2.manifestSha256);
    assert.deepEqual(result.readyEntries, ['include:tool']);
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    assert.equal(process.pid, f.pid);
    assert.deepEqual(f.entry.options.config, f.manifests.v2.config);
    assert.deepEqual(f.editor.configuration().find(row => row.entry === f.entry).override, f.manifests.v2.config);
    await assertRevision(f, 'v2');
    await assert.rejects(async () => oldService.analyze('old handle'), { code: 'STALE_EPISODE' });
  } finally { await f.dispose(); }
});

test('bad library or manifest hashes reject before retiring the old official native Fiber', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const fiber = f.entry.fiber, generation = fiber._generation, before = await readFile(f.patchPath, 'utf8');
    await assert.rejects(f.editor.edit(f.entry, () => ({ ...f.manifests.v2.config, sha256: '0'.repeat(64) })));
    assert.equal(f.entry.fiber, fiber);
    assert.equal(fiber._generation, generation);
    assert.equal(fiber.state, 2);
    assert.deepEqual(f.entry.options.config, f.manifests.v1.config);
    assert.equal(await readFile(f.patchPath, 'utf8'), before);
    await assert.rejects(f.update('v2', { sha256: '0'.repeat(64) }), { code: 'NATIVE_ARTIFACT_DIGEST' });
    assert.equal(f.entry.fiber, fiber);
    assert.equal(fiber._generation, generation);
    await assertRevision(f, 'v1');
  } finally { await f.dispose(); }
});

test('failed native setup restores the previous persisted configuration and real ToolRuntime consumer', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await f.update('v2');
    await assert.rejects(f.update('fail'), error => error.code === 'OFFICIAL_NATIVE_UPDATE_FAILED' && error.details?.restored === true);
    assert.deepEqual(f.entry.options.config, f.manifests.v2.config);
    assert.deepEqual(f.editor.configuration().find(row => row.entry === f.entry).override, f.manifests.v2.config);
    assert.equal(f.entry.fiber.state, 2);
    assert.equal(f.ctx.loader.resolve('include:tool').fiber.state, 2);
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    await assertRevision(f, 'v2');
  } finally { await f.dispose(); }
});

test('official Loader disabling and reenabling a native entry withdraws and restores its actual tool', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    await assertRevision(f, 'v1');
    await f.transactions.update('native', { disabled: true });
    await f.ctx.loader.await(); await f.ctx.settle();
    assert.equal(f.entry.disabled, true);
    assert.equal(f.ctx.tools.get('rust_dynamic_text_analyze'), undefined);
    assert.equal((await f.execute()).isError, true);
    await f.transactions.update('native', { disabled: false });
    await f.ctx.loader.await(); await f.ctx.settle();
    assert.equal(f.entry.disabled, false);
    assert.equal(f.entry.fiber.state, 2);
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    await assertRevision(f, 'v1');
  } finally { await f.dispose(); }
});

test('required consumer rejection rolls back a successfully activated v2 provider to its old configuration', { timeout: 30000 }, async () => {
  const f = await fixture({ rejectV2: true });
  try {
    await assert.rejects(f.update('v2'), error => error.code === 'OFFICIAL_NATIVE_UPDATE_FAILED' && error.details?.restored === true);
    assert(f.consumerHistory.some(([event, revision]) => event === 'setup' && revision === 'v2'), 'The real consumer must have seen and rejected candidate v2');
    assert.deepEqual(f.consumerHistory.at(-1), ['setup', 'v1']);
    assert.deepEqual(f.entry.options.config, f.manifests.v1.config);
    assert.equal(f.ctx.loader.resolve('include:guard').fiber.state, 2);
    assert.equal(f.ctx.loader.resolve('include:tool').fiber.state, 2);
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    await assertRevision(f, 'v1');
  } finally { await f.dispose(); }
});

test('native build watcher serializes verified official updates and preserves the working tool on build failure', { timeout: 30000 }, async () => {
  const f = await fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const events = [];
  let watcher, builds = 0, activeBuilds = 0, highest = 0, artifactsRead = 0, requested = 'v2';
  try {
    const source = join(f.directory, 'watched.rs');
    await writeFile(source, '// trusted plugin source fixture\n');
    watcher = watchOfficialRustModule(f.ctx, { entryId: f.entry.id, readyEntries: f.readyEntries,
      cwd: f.directory, watchPaths: [source], intervalMs: 10,
      build: async () => {
        const revision = requested;
        highest = Math.max(highest, ++activeBuilds);
        try {
          if (++builds === 1) { entered.resolve(); await release.promise; }
          if (revision === 'build-error') throw new Error('compiler rejected candidate source');
          return f.manifests[revision];
        } finally { activeBuilds--; }
      },
      artifact: async ({ buildResult }) => {
        artifactsRead++;
        return readNativeModule(buildResult.manifestPath, { sha256: buildResult.manifestSha256 });
      },
      onEvent: event => events.push(event),
    });
    const first = watcher.buildNow();
    await entered.promise;
    requested = 'build-error';
    const next = watcher.buildNow();
    await nextTurn();
    assert.equal(builds, 1);
    await assertRevision(f, 'v1');
    release.resolve();
    const outcomes = await Promise.all([first, next]);
    assert(outcomes.every(outcome => outcome.status === 'failed' && outcome.phase === 'build'));
    assert.equal(highest, 1);
    assert.equal(builds, 2);
    assert.equal(artifactsRead, 1, 'A failed build must never reach artifact verification or Loader mutation');
    assert(events.some(event => event.status === 'completed'));
    assert(events.some(event => event.status === 'failed' && event.phase === 'build'));
    assert.deepEqual(f.entry.options.config, f.manifests.v2.config);
    await assertRevision(f, 'v2');
    requested = 'v1';
    assert.equal((await watcher.buildNow()).status, 'completed');
    assert.equal(artifactsRead, 2);
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    assert.equal(process.pid, f.pid);
    await assertRevision(f, 'v1');
  } finally { release.resolve(); await watcher?.close(); await f.dispose(); }
});
