import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, watchOfficialRustModule } from './native-loader-fixture.mjs';

async function control(f, action, worker) {
  return f.execute({ name: `rust_text_worker_${action}`, arguments: worker === undefined ? {} : { worker } });
}
async function catalog(f) {
  const result = await control(f, 'list'); assert.equal(result.isError, false);
  return result.value;
}
async function customize(f) {
  assert.equal((await control(f, 'create', 'review')).isError, false);
  assert.equal((await control(f, 'remove', 'code')).isError, false);
  assert.deepEqual((await catalog(f)).workers.map(item => item.worker), ['notes', 'review']);
}
async function assertWorkers(f, revision, names = ['notes', 'review']) {
  const state = await catalog(f);
  assert.deepEqual(state.workers.map(item => item.worker), names);
  assert.deepEqual(state.consumers.map(item => item.worker).sort(), names);
  for (const worker of names) {
    const result = await f.execute({ name: `rust_text_${worker}_analyze`, text: 'Hello 世界' });
    assert.equal(result.isError, false); assert.equal(result.value.revision, revision);
    assert.equal(result.value.worker, worker); assert.equal(result.value.bytes, 12);
  }
  assert.equal(process.pid, f.pid); assert.equal(f.ctx.fiber._domain.driver, f.driver);
  return state;
}
function nativeZero(f) {
  const { modules, checkpoints } = f.ctx.fiber._domain.rust.command({ op: 'module_info' });
  assert.equal(checkpoints.tokens, 0, 'All in-memory checkpoint receipts must be released');
  assert.equal(checkpoints.bytes, 0, 'No checkpoint payload bytes may remain after close');
  assert(modules.length);
  for (const image of modules) for (const [kind, count] of Object.entries(image.resources)) assert.equal(count, 0, kind);
}
async function close(f) { await f.ctx.dispose(); assert.equal(f.ctx.snapshot().plugins.length, 0); nativeZero(f); }
async function awaitEntry(entered, operation) {
  await Promise.race([entered, operation.then(() => { throw new Error('Operation completed before its lifecycle checkpoint'); }, error => { throw error; })]);
}
function gate() {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), history = [];
  let blocked = true;
  return { entered: entered.promise, history, release() { blocked = false; release.resolve(); },
    hooks: { onEvent: event => history.push(event), async beforeRecord(event) {
      if (blocked && event.kind === 'worker-analyze' && event.worker === 'notes') { entered.resolve(); await release.promise; }
    } },
  };
}
function retirement(f, id) {
  const entered = Promise.withResolvers();
  const off = f.ctx.on('internal/status', changed => { if (changed.id === id && changed.state === 5) entered.resolve(); }, { global: true });
  return { entered: entered.promise, off };
}

test('generated migrate recipes preserve dynamic worker names through an ordinary official ConfigEditor native update', { timeout: 30000 }, async () => {
  const f = await fixture({ fleet: true, generatedFleet: true, migration: true });
  try {
    assert.equal(f.generatedEntries[1].config.plugins[0].state, 'migrate');
    assert.equal(new URL(f.generatedEntries[2].name).protocol, 'file:');
    await customize(f);
    const prior = await catalog(f), old = f.ctx.rustFleet_review;
    // This is the actual default configuration path, not the separate native controller.
    await f.editor.edit(f.entry, () => structuredClone(f.manifests.v2.config));
    await f.ctx.loader.await(); await f.ctx.settle();
    const next = await assertWorkers(f, 'v2');
    assert(next.workers.every(worker => !prior.workers.some(old => old.status.id === worker.status.id)));
    assert(next.consumers.every(consumer => !prior.consumers.some(old => old.consumerId === consumer.consumerId)));
    assert.equal(f.ctx.tools.get('rust_text_code_analyze'), undefined, 'Removed defaults must not be seeded again');
    await assert.rejects(async () => old.analyze('stale'), { code: 'STALE_EPISODE' });
    const persisted = await readFile(f.patchPath, 'utf8');
    assert(!persisted.includes('review'), 'Logical checkpoints are not silently written to the profile');
    await close(f);
  } finally { await f.dispose(); }
});

test('a native setup failure restores the original checkpoint and exact tool catalog through official recovery', { timeout: 30000 }, async () => {
  const f = await fixture({ fleet: true, migration: true });
  try {
    await customize(f);
    const before = structuredClone(f.entry.options.config), prior = await catalog(f);
    await assert.rejects(f.update('fail'), error => error.code === 'OFFICIAL_NATIVE_UPDATE_FAILED' && error.details.restored === true);
    assert.deepEqual(f.entry.options.config, before);
    const restored = await assertWorkers(f, 'v1');
    assert(restored.workers.every(worker => !prior.workers.some(old => old.status.id === worker.status.id)));
    assert.equal(f.ctx.tools.get('rust_text_code_analyze'), undefined);
    await close(f);
  } finally { await f.dispose(); }
});

test('required-consumer rejection restores the pinned original checkpoint rather than candidate-mutated state', { timeout: 30000 }, async () => {
  const f = await fixture({ fleet: true, migration: true, rejectFleetV2: true });
  try {
    await customize(f);
    const before = structuredClone(f.entry.options.config);
    await assert.rejects(f.update('v2'), error => error.code === 'OFFICIAL_NATIVE_UPDATE_FAILED' && error.details.restored === true);
    assert(f.consumerHistory.some(([phase, revision]) => phase === 'fleet-setup' && revision === 'v2'), 'The candidate reached its real consumer');
    assert.deepEqual(f.entry.options.config, before);
    await assertWorkers(f, 'v1');
    assert.equal(f.ctx.get('rustFleet_candidate_only'), undefined, 'Candidate state must not contaminate rollback');
    assert.equal(f.ctx.tools.get('rust_text_candidate_only_analyze'), undefined);
    // Rollback's source pin must end with the transaction. A later dependency
    // restart must capture these new business changes, not reuse the old DTO.
    assert.equal((await control(f, 'create', 'after_rollback')).isError, false);
    assert.equal((await control(f, 'remove', 'notes')).isError, false);
    await f.editor.edit(f.fleetAuditEntry, () => ({ label: 'fleet-after-rollback' }));
    await f.ctx.loader.await(); await f.ctx.settle();
    assert.equal(f.ctx.textFleetAudit.snapshot().label, 'fleet-after-rollback');
    await assertWorkers(f, 'v1', ['after_rollback', 'review']);
    assert.equal(f.ctx.tools.get('rust_text_notes_analyze'), undefined);
    assert.deepEqual(f.entry.options.config, before);
    await close(f);
  } finally { await f.dispose(); }
});

test('a rejected rollback keeps the original checkpoint until repaired required consumers accept a later update', { timeout: 30000 }, async () => {
  const f = await fixture({ fleet: true, migration: true, rejectFleetV2: true, failFleetRollbackOnce: true });
  try {
    await customize(f);
    const before = structuredClone(f.entry.options.config);
    await assert.rejects(f.update('v2'), error => {
      assert.equal(error.code, 'OFFICIAL_NATIVE_UPDATE_FAILED');
      assert.equal(error.details.restored, false);
      assert(error instanceof AggregateError);
      assert(error.cause instanceof AggregateError, 'Keep the Loader revision failures, not just the business error');
      assert.equal(error.cause.message, 'Official Loader revision failed');
      assert(error.errors.some(item => item.code === 'OFFICIAL_NATIVE_UPDATE_FAILED'));
      return true;
    });
    assert(f.consumerHistory.some(([phase]) => phase === 'fleet-rollback-rejected'), 'The rollback consumer mutated its actual native manager before rejecting it');
    assert.deepEqual(f.entry.options.config, before);
    assert.equal(f.entry.fiber.state, 2, 'Native activation alone must not count as accepted recovery');
    const unaccepted = await f.ctx.rustTextFleet.list();
    assert.equal(unaccepted.revision, 'v1');
    assert(unaccepted.workers.some(item => item.worker === 'rollback_only'), 'The rejected rollback contains distinguishable mutated state');
    f.repairFleetGuard();
    await f.update('v2');
    await assertWorkers(f, 'v2');
    for (const worker of ['candidate_only', 'rollback_only']) {
      assert.equal(f.ctx.get(`rustFleet_${worker}`), undefined, 'Unaccepted generation state must not replace the original checkpoint');
      assert.equal(f.ctx.tools.get(`rust_text_${worker}_analyze`), undefined);
    }
    await close(f);
  } finally { await f.dispose(); }
});

test('checkpoint migration waits for actual in-flight worker work before reconstructing the new generation', { timeout: 30000 }, async () => {
  const blocked = gate(), f = await fixture({ fleet: true, migration: true, fleetHooks: blocked.hooks });
  let operation, update, checkpoint;
  try {
    await customize(f);
    const prior = await catalog(f), consumer = prior.consumers.find(item => item.worker === 'notes');
    operation = f.execute(); operation.catch(() => {});
    await awaitEntry(blocked.entered, operation);
    checkpoint = retirement(f, consumer.consumerId);
    let done = false;
    update = f.update('v2').then(value => { done = true; return value; }); update.catch(() => {});
    await awaitEntry(checkpoint.entered, Promise.race([operation, update]));
    assert.equal(done, false);
    assert(!blocked.history.some(event => event.kind === 'worker-cleanup' && event.worker === 'notes'));
    assert(!blocked.history.some(event => event.kind === 'manager-setup' && event.revision === 'v2'));
    blocked.release();
    assert.equal((await operation).isError, true);
    await update;
    await assertWorkers(f, 'v2');
    const landed = blocked.history.findIndex(event => event.type === 'record-end' && event.kind === 'worker-analyze' && event.revision === 'v1');
    const started = blocked.history.findIndex(event => event.type === 'record-start' && event.kind === 'manager-setup' && event.revision === 'v2');
    assert(landed >= 0 && started > landed);
    await close(f);
  } finally {
    blocked.release(); checkpoint?.off();
    try { await Promise.allSettled([operation, update].filter(Boolean)); } finally { await f.dispose(); }
  }
});

test('an intentionally empty migrated catalog stays empty instead of reseeding configured defaults', { timeout: 30000 }, async () => {
  const f = await fixture({ fleet: true, migration: true });
  try {
    for (const worker of ['notes', 'code']) assert.equal((await control(f, 'remove', worker)).isError, false);
    await f.update('v2');
    await assertWorkers(f, 'v2', []);
    assert.equal(f.ctx.tools.get('rust_text_notes_analyze'), undefined);
    assert.equal(f.ctx.tools.get('rust_text_code_analyze'), undefined);
    assert.equal((await control(f, 'create', 'after_restore')).isError, false);
    await assertWorkers(f, 'v2', ['after_restore']);
    await close(f);
  } finally { await f.dispose(); }
});

test('real official bridge-only file HMR drains old tool calls and reconnects existing native workers without replacing them', { timeout: 30000 }, async () => {
  const blocked = gate(), f = await fixture({ fleet: true, migration: true, fleetHmr: true, fleetHooks: blocked.hooks });
  let operation, reload, checkpoint;
  try {
    await customize(f);
    const historyStart = blocked.history.length;
    const prior = await catalog(f), oldManager = f.ctx.rustTextFleet, oldWorker = f.ctx.rustFleet_notes;
    const oldEntry = f.ctx.loader.resolve(f.readyEntries[0]).fiber;
    operation = f.execute(); operation.catch(() => {});
    await awaitEntry(blocked.entered, operation);
    checkpoint = retirement(f, oldEntry.id);
    let done = false;
    reload = f.reloadBridge(2).then(value => { done = true; return value; }); reload.catch(() => {});
    await awaitEntry(checkpoint.entered, Promise.race([operation, reload]));
    assert.equal(done, false);
    blocked.release();
    assert.equal((await operation).isError, true);
    await reload;
    const next = await assertWorkers(f, 'v1');
    assert.deepEqual(next.workers.map(worker => worker.status.id), prior.workers.map(worker => worker.status.id));
    assert(next.consumers.every(consumer => !prior.consumers.some(old => old.consumerId === consumer.consumerId)));
    assert.notEqual(f.ctx.loader.resolve(f.readyEntries[0]).fiber.id, oldEntry.id);
    assert.equal((await oldManager.list()).revision, 'v1');
    assert.equal((await oldWorker.analyze('still active')).revision, 'v1');
    assert(!blocked.history.slice(historyStart).some(event => event.kind === 'worker-cleanup' || event.kind === 'manager-cleanup'));
    assert.equal(f.ctx.tools.get('rust_text_code_analyze'), undefined);
    await close(f);
  } finally {
    blocked.release(); checkpoint?.off();
    try { await Promise.allSettled([operation, reload].filter(Boolean)); } finally { await f.dispose(); }
  }
});

test('the verified official build-watcher apply path uses the same checkpoint migration transaction', { timeout: 30000 }, async () => {
  const f = await fixture({ fleet: true, migration: true });
  let watcher;
  try {
    await customize(f);
    const source = join(f.directory, 'source.rs');
    await writeFile(source, '// watched input, separate from the ConfigEditor output\n');
    watcher = watchOfficialRustModule(f.ctx, { entryId: f.entry.id, readyEntries: f.readyEntries,
      cwd: f.directory, watchPaths: [source],
      build: async () => ({ revision: 'v2' }), artifact: async ({ buildResult }) => { assert.equal(buildResult.revision, 'v2'); return f.manifests.v2; },
    });
    const outcome = await watcher.buildNow();
    assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
    assert.equal(watcher.snapshot().attempts, 1, 'Writing the new profile must not trigger another build');
    await assertWorkers(f, 'v2');
    await watcher.close(); await close(f);
  } finally { try { await watcher?.close(); } finally { await f.dispose(); } }
});
