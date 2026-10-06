import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fixture } from './native-loader-fixture.mjs';
import { workerNames, MAX_WORKERS } from '../../examples/official/rust-text-fleet.mjs';

async function control(f, action, worker) {
  return f.execute({ name: `rust_text_worker_${action}`, arguments: worker === undefined ? {} : { worker } });
}
async function list(f) {
  const result = await control(f, 'list'); assert.equal(result.isError, false);
  return result.value;
}
function nativeZero(f) {
  const modules = f.ctx.fiber._domain.rust.command({ op: 'module_info' }).modules;
  assert(modules.length > 0);
  for (const module of modules) for (const [kind, count] of Object.entries(module.resources)) assert.equal(count, 0, `${module.buildId}: ${kind}`);
}
async function disable(f) {
  await f.transactions.update(f.generatedEntries ? 'rust-text-fleet' : 'native', { disabled: true });
  await f.ctx.loader.await(); await f.ctx.settle();
  assert.equal(f.ctx.tools.get('rust_text_notes_analyze'), undefined);
  assert.equal(f.ctx.tools.get('rust_text_worker_create'), undefined);
  nativeZero(f);
}
async function awaitEntry(entered, operation) {
  await Promise.race([entered, operation.then(() => { throw new Error('Operation finished before the expected lifecycle checkpoint'); }, error => { throw error; })]);
}
function blockedAnalyze() {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), history = [];
  let blocked = true;
  return { entered: entered.promise, history, release() { blocked = false; release.resolve(); },
    hooks: { onEvent: event => history.push(event), async beforeRecord(event) {
      if (event.kind === 'worker-analyze' && event.worker === 'notes' && blocked) { entered.resolve(); await release.promise; }
    } },
  };
}
function before(history, first, second, label = 'fleet-v1') {
  const a = history.findIndex(first), b = history.findIndex(second);
  assert(a >= 0 && b >= 0, `Missing lifecycle events for ${label}`); assert(a < b, `Expected lifecycle order for ${label}`);
}
const ended = kind => event => event.type === 'record-end' && event.kind === kind;

// Source-level validation does not pretend that a mock registry is a graph.
test('fleet names bound service/tool identifiers and reject ambiguous or unbounded names', () => {
  assert.equal(MAX_WORKERS, 16);
  assert.deepEqual(workerNames('notes_2'), { service: 'rustFleet_notes_2', tool: 'rust_text_notes_2_analyze' });
  assert.doesNotThrow(() => workerNames('a'.repeat(32)));
  for (const worker of ['', 'A', '2a', 'a.b', 'a-b', '界', 'a'.repeat(33), null]) assert.throws(() => workerNames(worker));
});

test('generated fleet profile publishes actual native children and mounts actual official tool consumers', { timeout: 30000 }, async () => {
  const f = await fixture({ fleet: true, generatedFleet: true });
  try {
    assert.deepEqual(f.generatedEntries.map(entry => entry.id), ['text-fleet-audit', 'rust-text-fleet', 'rust-text-fleet-tools']);
    assert.equal(new URL(f.generatedEntries[0].name).protocol, 'file:');
    assert.equal(new URL(f.generatedEntries[2].name).protocol, 'file:');
    assert.deepEqual(f.generatedEntries[1].inject, ['textFleetAudit']);
    const initial = await list(f);
    assert.deepEqual(initial.workers.map(item => item.worker), ['code', 'notes']);
    const snapshot = f.ctx.snapshot().plugins;
    const fleetConsumer = f.ctx.loader.resolve(f.readyEntries[0]).fiber;
    for (const worker of initial.workers) {
      assert.equal(worker.status.initialized, true); assert.equal(worker.status.removed, false);
      const node = snapshot.find(node => node.id === worker.status.id); assert(node, 'Publication is a real Driver child');
      assert.notEqual(node.parent, null);
      const consumer = initial.consumers.find(item => item.worker === worker.worker);
      assert.equal(snapshot.find(node => node.id === consumer.consumerId)?.parent, fleetConsumer.id, 'Tool has a separate owned consumer Fiber');
      assert.notEqual(consumer.consumerId, worker.status.id);
    }
    const parentIds = initial.workers.map(worker => snapshot.find(node => node.id === worker.status.id).parent);
    assert.equal(parentIds[0], parentIds[1], 'Workers share the real Rust manager owner');
    assert.notEqual(parentIds[0], fleetConsumer.id);
    const nativeManager = snapshot.find(node => node.id === parentIds[0]); assert.equal(nativeManager.parent, f.entry.fiber.id);
    const result = await f.execute({ text: 'Hello 世界\r\nRust 🦀\n' });
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, { backend: 'rust-published-worker', revision: 'v1', worker: 'notes', bytes: 24, characters: 17, words: 4, lines: 2 });
    const count = f.ctx.snapshot().plugins.length;
    const created = await control(f, 'create', 'review'); assert.equal(created.isError, false);
    assert.equal(f.ctx.snapshot().plugins.length, count + 2, 'Exactly a native provider and a JS consumer were added');
    assert.equal((await f.execute({ name: created.value.tool, text: 'one two' })).value.words, 2);
    assert.equal((await control(f, 'create', 'review')).isError, true);
    assert.equal((await control(f, 'create', 'bad-name')).isError, true);
    const old = f.ctx.rustFleet_review;
    const removed = await control(f, 'remove', 'review'); assert.equal(removed.isError, false);
    assert.equal(f.ctx.snapshot().plugins.length, count);
    assert.equal(f.ctx.tools.get(created.value.tool), undefined);
    assert.equal(f.ctx.get('rustFleet_review'), undefined);
    await assert.rejects(async () => old.analyze('stale'), { code: 'STALE_EPISODE' });
    assert(!(await list(f)).workers.some(worker => worker.worker === 'review'));
    const audit = f.ctx.textFleetAudit.snapshot(); assert(audit.recent.length <= 64); assert(audit.recent.every(event => !Object.hasOwn(event, 'text')));
    await disable(f);
  } finally { await f.dispose(); }
});

test('an observer failing after consumer allocation leaves no orphan when the same worker is removed and recreated', { timeout: 30000 }, async () => {
  const f = await fixture({ fleet: true, generatedFleet: true });
  let off;
  try {
    const baseline = f.ctx.snapshot().plugins.length;
    let allocated, once = true;
    off = f.ctx.on('internal/plugin', fiber => {
      if (once && fiber.name === 'text-fleet-consumer:review') {
        once = false; allocated = fiber;
        throw new Error('Fleet consumer observer failed after allocation');
      }
    }, { global: true });
    const failed = await control(f, 'create', 'review');
    assert.equal(failed.isError, true); assert(allocated, 'Observer saw a real allocated Fiber');
    off(); off = undefined;
    const retained = await list(f);
    assert(retained.workers.some(worker => worker.worker === 'review'), 'The native handle remains available for cleanup');
    const consumer = retained.consumers.find(item => item.worker === 'review');
    assert.equal(consumer.state, 'failed');
    if (f.ctx.snapshot().plugins.some(node => node.id === allocated.id)) {
      assert.equal(consumer.consumerId, allocated.id, 'A still-mounted partial consumer must retain its actual Fiber');
    }
    assert.equal((await control(f, 'remove', 'review')).isError, false);
    assert(!f.ctx.snapshot().plugins.some(node => node.id === allocated.id));
    assert.equal(f.ctx.snapshot().plugins.length, baseline);
    const recreated = await control(f, 'create', 'review'); assert.equal(recreated.isError, false);
    assert.equal(f.ctx.snapshot().plugins.length, baseline + 2);
    const result = await f.execute({ name: 'rust_text_review_analyze', text: 'one two' });
    assert.equal(result.isError, false); assert.equal(result.value.worker, 'review'); assert.equal(result.value.words, 2);
    assert.equal((await control(f, 'remove', 'review')).isError, false);
    assert.equal(f.ctx.snapshot().plugins.length, baseline);
    await disable(f);
  } finally { off?.(); await f.dispose(); }
});

test('native replacement recreates configured workers in the same Driver and failed candidates restore the committed fleet', { timeout: 30000 }, async () => {
  const history = [], f = await fixture({ fleet: true, fleetHooks: { onEvent: event => history.push(event) } });
  try {
    const initial = await list(f), old = f.ctx.rustFleet_notes;
    assert.equal((await control(f, 'create', 'ephemeral')).isError, false);
    await f.update('v2');
    const next = await list(f);
    assert.deepEqual(next.workers.map(item => item.worker), ['code', 'notes'], 'Only configured names are recreated; no implicit state migration');
    assert(next.workers.every(item => !initial.workers.some(prior => prior.status.id === item.status.id)));
    assert.equal((await f.execute()).value.revision, 'v2');
    assert.equal(f.ctx.tools.get('rust_text_ephemeral_analyze'), undefined);
    await assert.rejects(async () => old.analyze('stale'), { code: 'STALE_EPISODE' });
    await assert.rejects(f.update('fail'), error => error.code === 'OFFICIAL_NATIVE_UPDATE_FAILED' && error.details.restored === true);
    assert.equal((await f.execute()).value.revision, 'v2');
    assert.equal((await list(f)).workers.length, 2);
    assert.equal(process.pid, f.pid); assert.equal(f.ctx.fiber._domain.driver, f.driver);
    before(history, ended('worker-cleanup'), ended('manager-cleanup'));
    await disable(f);
  } finally { await f.dispose(); }
});

test('updating the external JS provider drains old workers and activates new children with the committed native image', { timeout: 30000 }, async () => {
  const history = [], f = await fixture({ fleet: true, fleetHooks: { onEvent: event => history.push(event) } });
  try {
    const old = f.ctx.rustFleet_notes, prior = await list(f), digest = f.entry.options.config.sha256;
    await f.editor.edit(f.fleetAuditEntry, () => ({ label: 'fleet-v2' }));
    await f.ctx.loader.await(); await f.ctx.settle();
    const next = await list(f);
    assert.equal((await f.execute()).value.revision, 'v1');
    assert.equal(f.ctx.textFleetAudit.snapshot().label, 'fleet-v2');
    assert(next.workers.every(item => !prior.workers.some(old => old.status.id === item.status.id)));
    assert.equal(f.entry.options.config.sha256, digest);
    await assert.rejects(async () => old.analyze('stale'), { code: 'STALE_EPISODE' });
    before(history, event => ended('worker-cleanup')(event) && event.label === 'fleet-v1', event => ended('manager-cleanup')(event) && event.label === 'fleet-v1');
    before(history, event => ended('manager-cleanup')(event) && event.label === 'fleet-v1', event => event.type === 'provider-cleanup' && event.label === 'fleet-v1');
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    await disable(f);
  } finally { await f.dispose(); }
});

test('removing a worker waits for its real in-flight tool consumer before joining native removal', { timeout: 30000 }, async () => {
  const blocked = blockedAnalyze(), f = await fixture({ fleet: true, fleetHooks: blocked.hooks });
  let operation, removing, off;
  try {
    const state = await list(f), worker = state.workers.find(item => item.worker === 'notes'), consumer = state.consumers.find(item => item.worker === 'notes');
    operation = f.execute(); operation.catch(() => {});
    await awaitEntry(blocked.entered, operation);
    const retiring = Promise.withResolvers();
    off = f.ctx.on('internal/status', changed => { if (changed.id === consumer.consumerId && changed.state === 5) retiring.resolve(); }, { global: true });
    let removed = false;
    removing = control(f, 'remove', 'notes').then(value => { removed = true; return value; }); removing.catch(() => {});
    await awaitEntry(retiring.promise, Promise.race([operation, removing]));
    assert.equal(removed, false);
    assert(f.ctx.snapshot().plugins.some(node => node.id === worker.status.id));
    assert(!blocked.history.some(ended('worker-cleanup')));
    blocked.release();
    assert.equal((await operation).isError, true);
    assert.equal((await removing).isError, false);
    assert(!f.ctx.snapshot().plugins.some(node => node.id === worker.status.id || node.id === consumer.consumerId));
    before(blocked.history, ended('worker-analyze'), event => ended('worker-cleanup')(event) && event.worker === 'notes');
    assert.equal((await f.execute({ name: 'rust_text_code_analyze' })).isError, false);
    await disable(f);
  } finally {
    blocked.release(); off?.();
    try { await Promise.allSettled([operation, removing].filter(Boolean)); } finally { await f.dispose(); }
  }
});

test('failed worker cleanup retains its native child handle and explicit removal retries the real inverse', { timeout: 30000 }, async () => {
  let attempts = 0;
  const f = await fixture({ fleet: true, fleetHooks: { beforeRecord(event) {
    if (event.kind === 'worker-cleanup' && event.worker === 'notes' && ++attempts === 1) throw new Error('Worker refused first cleanup');
  } } });
  try {
    const initial = await list(f), id = initial.workers.find(item => item.worker === 'notes').status.id;
    const failed = await control(f, 'remove', 'notes'); assert.equal(failed.isError, true);
    assert.equal(attempts, 1);
    const retained = await list(f), worker = retained.workers.find(item => item.worker === 'notes');
    assert.equal(worker.status.id, id); assert.equal(worker.status.cleanupFailed, true); assert.equal(worker.status.removed, false);
    assert(f.ctx.snapshot().plugins.some(node => node.id === id && node.cleanupFailed));
    assert.equal(retained.consumers.find(item => item.worker === 'notes').state, 'retiring');
    assert.equal(f.ctx.tools.get('rust_text_notes_analyze'), undefined);
    assert.equal((await control(f, 'remove', 'notes')).isError, false);
    assert.equal(attempts, 2);
    assert(!f.ctx.snapshot().plugins.some(node => node.id === id));
    assert(!(await list(f)).workers.some(item => item.worker === 'notes'));
    assert.equal((await control(f, 'create', 'notes')).isError, false);
    assert.equal((await f.execute()).isError, false);
    await disable(f);
  } finally { await f.dispose(); }
});

test('official shutdown joins an active published-worker call before child, manager and provider cleanup', { timeout: 30000 }, async () => {
  const blocked = blockedAnalyze(), f = await fixture({ fleet: true, fleetHooks: blocked.hooks });
  let operation, closing;
  try {
    operation = f.execute(); operation.catch(() => {});
    await awaitEntry(blocked.entered, operation);
    let done = false;
    closing = f.ctx.dispose().then(() => { done = true; }); closing.catch(() => {});
    await nextTurn(); await nextTurn();
    assert.equal(done, false);
    assert(!blocked.history.some(ended('manager-cleanup')));
    blocked.release();
    assert.equal((await operation).isError, true);
    await closing;
    before(blocked.history, ended('worker-analyze'), event => ended('worker-cleanup')(event) && event.worker === 'notes');
    before(blocked.history, ended('worker-cleanup'), ended('manager-cleanup'));
    before(blocked.history, ended('manager-cleanup'), event => event.type === 'provider-cleanup');
    assert.equal(f.ctx.snapshot().plugins.length, 0); nativeZero(f);
  } finally {
    blocked.release();
    try { await Promise.allSettled([operation, closing].filter(Boolean)); } finally { await f.dispose(); }
  }
});
