import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fixture } from './native-loader-fixture.mjs';

function images(f) {
  const modules = f.ctx.fiber._domain.rust.command({ op: 'module_info' }).modules;
  assert(modules.length > 0, 'Resource checks must inspect actually loaded libraries');
  return modules;
}
function resourcesAreZero(f, { all = false } = {}) {
  for (const image of images(f)) {
    const required = ['streams', 'objects', 'retainedStreams', 'retainedObjects'];
    for (const kind of required) assert(Object.hasOwn(image.resources, kind), `Missing native resource counter: ${kind}`);
    for (const kind of all ? Object.keys(image.resources) : required) assert.equal(image.resources[kind], 0, `${image.buildId ?? image.moduleId}: ${kind}`);
  }
}
async function disable(f) {
  await f.transactions.update(f.generatedEntries ? 'rust-resources' : 'native', { disabled: true });
  await f.ctx.loader.await(); await f.ctx.settle();
  resourcesAreZero(f, { all: true });
}
function ended(history, kind, revision = 'v1') {
  return history.findIndex(event => event.type === 'record-end' && event.kind === kind && event.revision === revision);
}
function assertBefore(history, first, second, secondRevision = 'v1') {
  const a = ended(history, first), b = ended(history, second, secondRevision);
  assert(a >= 0, `Missing completed ${first}`);
  assert(b >= 0, `Missing completed ${second}`);
  assert(a < b, `${first} must complete before ${second}`);
}
async function awaitEntry(entered, operation) {
  await Promise.race([entered, operation.then(
    () => { throw new Error('The resource tool completed before entering its expected gate'); },
    error => { throw error; },
  )]);
}
function gate(kind) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), history = [];
  let blocked = true;
  return {
    entered: entered.promise, history,
    release() { blocked = false; release.resolve(); },
    hooks: {
      onEvent: event => history.push(event),
      async beforeRecord(event) { if (event.kind === kind && blocked) { entered.resolve(); await release.promise; } },
    },
  };
}

// This uses the exact file URLs produced for a user's profile, not test-only
// builtins. All tools execute through the installed, real official ToolRuntime.
test('generated resource recipes run a Rust stream and owned analysis session through the official Loader and ToolRuntime', { timeout: 30000 }, async () => {
  const f = await fixture({ resources: true, generatedResources: true });
  try {
    const entries = f.generatedEntries;
    assert.deepEqual(entries.map(entry => entry.id), ['text-resource-audit', 'rust-resources', 'rust-resource-tool']);
    assert.equal(new URL(entries[0].name).protocol, 'file:');
    assert.equal(new URL(entries[2].name).protocol, 'file:');
    assert.equal(entries[1].name, 'cordis:rust-module');
    assert.deepEqual(entries[1].inject, ['textResourceAudit']);
    assert(Object.hasOwn(f.entry.fiber.inject, 'textResourceAudit'));
    assert.deepEqual(f.entry.options.config, entries[1].config);
    const text = 'Hello 世界\r\nRust 🦀\n';
    const result = await f.execute({ text, chunkCharacters: 1 });
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, { backend: 'rust-dynamic', revision: 'v1', bytes: 24, characters: 17, lines: 2, words: 4, chunks: 17 });
    resourcesAreZero(f);
    const empty = await f.execute({ text: '', chunkCharacters: 2 });
    assert.equal(empty.isError, false);
    assert.equal(empty.value.chunks, 0);
    assert.equal(empty.value.bytes, 0);
    for (const options of [{ chunkCharacters: 0 }, { chunkCharacters: 4097 }, { text: 'x'.repeat(128 * 1024 + 1) }]) {
      assert.equal((await f.execute(options)).isError, true);
      resourcesAreZero(f);
    }
    // Audit records are bounded and omit user text even after many chunks.
    const bounded = await f.execute({ text: 'x'.repeat(80), chunkCharacters: 1 });
    assert.equal(bounded.isError, false);
    const audit = f.ctx.textResourceAudit.snapshot();
    assert.equal(audit.recent.length, 64);
    assert(audit.total > audit.recent.length);
    assert(audit.recent.every(item => !Object.hasOwn(item, 'text')));
    const oldService = f.ctx.rustTextResources, digest = f.entry.options.config.sha256;
    await f.editor.edit(f.auditEntry, () => ({ label: 'resource-audit-updated' }));
    await f.ctx.loader.await(); await f.ctx.settle();
    assert.equal(f.ctx.textResourceAudit.snapshot().label, 'resource-audit-updated');
    assert.equal((await f.execute()).isError, false);
    assert.equal(f.entry.options.config.sha256, digest);
    assert.throws(() => oldService.session(), { code: 'STALE_EPISODE' });
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    assert.equal(process.pid, f.pid);
    await disable(f);
  } finally { await f.dispose(); }
});

test('Rust resources preserve pull backpressure, Unicode boundaries, owned session isolation and explicit early release', { timeout: 30000 }, async () => {
  const history = [], handles = [];
  const f = await fixture({ resources: true, resourceHooks: { onEvent: event => history.push(event) } });
  try {
    const stream = f.ctx.rustTextResources.chunks('A世界🦀', 2);
    handles.push(() => stream.return());
    assert.equal(ended(history, 'stream-pull'), -1, 'Opening a stream must not prefetch');
    assert.deepEqual(await stream.next(), { done: false, value: { text: 'A世', offsetBytes: 0, revision: 'v1' } });
    await nextTurn();
    assert.equal(history.filter(event => event.type === 'record-end' && event.kind === 'stream-pull').length, 1);
    assert.deepEqual(await stream.next(), { done: false, value: { text: '界🦀', offsetBytes: 4, revision: 'v1' } });
    assert.deepEqual(await stream.next(), { done: true, value: undefined });
    const one = f.ctx.rustTextResources.session(), two = f.ctx.rustTextResources.session();
    handles.push(() => one.close(), () => two.close());
    assert.equal(one.typeName, 'TextAnalysisSession');
    assert.equal(one.ownership, 'owned');
    assert.deepEqual(one.methods, ['append', 'snapshot']);
    for (const part of ['hel', 'lo 世', '界\r', '\nlast']) await one.call('append', part);
    const snapshot = await one.call('snapshot');
    assert.equal(snapshot.words, 3);
    assert.equal(snapshot.lines, 2);
    assert.equal(snapshot.chunks, 4);
    assert.equal((await two.call('snapshot')).bytes, 0);
    await assert.rejects(one.call('undeclared'), /UndeclaredObjectMethod/);
    await assert.rejects(one.call('append', 'x'.repeat(128 * 1024)), /session exceeds/);
    assert.deepEqual(await one.call('snapshot'), snapshot, 'Rejected append must not corrupt previously accumulated text');
    const early = f.ctx.rustTextResources.chunks('three chunks here', 2);
    handles.push(() => early.return());
    for await (const chunk of early) { assert.equal(chunk.text, 'th'); break; }
    await Promise.all([one.close(), two.close()]);
    await assert.rejects(one.call('snapshot'), { code: 'STALE_EPISODE' });
    resourcesAreZero(f);
    await disable(f);
  } finally {
    await Promise.allSettled(handles.map(close => close()));
    await f.dispose();
  }
});

test('official tool cancellation closes Rust resources only after an admitted stream pull and its JS audit settle', { timeout: 30000 }, async () => {
  const blocked = gate('stream-pull');
  const f = await fixture({ resources: true, resourceHooks: blocked.hooks });
  let operation;
  try {
    const controller = new AbortController();
    let settled = false;
    operation = f.execute({ signal: controller.signal, chunkCharacters: 2 });
    operation.then(() => { settled = true; }, () => { settled = true; });
    await awaitEntry(blocked.entered, operation);
    controller.abort(new Error('Cancel resource tool'));
    await nextTurn(); await nextTurn();
    assert.equal(settled, false);
    assert.equal(ended(blocked.history, 'stream-pull'), -1);
    assert.equal(ended(blocked.history, 'stream-close'), -1);
    blocked.release();
    assert.equal((await operation).isError, true);
    assertBefore(blocked.history, 'stream-pull', 'stream-close');
    resourcesAreZero(f);
    assert.equal((await f.execute()).isError, false);
    await disable(f);
  } finally {
    blocked.release();
    try { await Promise.allSettled([operation].filter(Boolean)); } finally { await f.dispose(); }
  }
});

test('native replacement drains a blocked owned object call and old handles before the v2 official tool activates', { timeout: 30000 }, async () => {
  const blocked = gate('object-append');
  const f = await fixture({ resources: true, resourceHooks: blocked.hooks });
  let operation, updating, idle, unlisten;
  try {
    idle = f.ctx.rustTextResources.chunks('old idle stream', 2);
    const old = f.ctx.rustTextResources;
    const consumer = f.ctx.loader.resolve(f.readyEntries[0]).fiber;
    const retiring = Promise.withResolvers();
    unlisten = f.ctx.on('internal/status', changed => {
      if (changed === consumer && changed.state === 5) retiring.resolve();
    }, { global: true });
    let operationSettled = false;
    operation = f.execute({ chunkCharacters: 2 });
    operation.then(() => { operationSettled = true; }, () => { operationSettled = true; });
    await awaitEntry(blocked.entered, operation);
    let updated = false;
    updating = f.update('v2').then(value => { updated = true; return value; }); updating.catch(() => {});
    // Updating first reads/hashes the immutable manifest and library. A couple
    // of event-loop turns cannot prove that actual lifecycle retirement began.
    // Wait for the same official tool consumer's UNLOADING notification.
    await awaitEntry(retiring.promise, Promise.race([operation, updating]));
    assert.equal(consumer.state, 5);
    assert.equal(operationSettled, false, 'Retirement must still join the admitted JS audit promise');
    assert.equal(updated, false);
    assert.equal(ended(blocked.history, 'object-close'), -1);
    assert.equal(ended(blocked.history, 'native-cleanup'), -1);
    blocked.release();
    assert.equal((await operation).isError, true);
    await updating;
    assertBefore(blocked.history, 'object-append', 'object-close');
    assertBefore(blocked.history, 'object-close', 'native-cleanup');
    assertBefore(blocked.history, 'native-cleanup', 'native-setup', 'v2');
    await assert.rejects(idle.next(), { code: 'STALE_EPISODE' });
    assert.throws(() => old.session(), { code: 'STALE_EPISODE' });
    const result = await f.execute({ chunkCharacters: 2 });
    assert.equal(result.isError, false);
    assert.equal(result.value.revision, 'v2');
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    assert.equal(process.pid, f.pid);
    resourcesAreZero(f);
    await disable(f);
  } finally {
    blocked.release();
    unlisten?.();
    try { await Promise.allSettled([operation, updating].filter(Boolean)); } finally {
      try { if (idle) await idle.return(); } finally { await f.dispose(); }
    }
  }
});

test('official shutdown joins the owned object call, resource destructors, native cleanup and its committed audit provider', { timeout: 30000 }, async () => {
  const blocked = gate('object-append');
  const f = await fixture({ resources: true, resourceHooks: blocked.hooks });
  let operation, closing;
  try {
    operation = f.execute(); operation.catch(() => {});
    await awaitEntry(blocked.entered, operation);
    let closed = false;
    closing = f.ctx.dispose().then(() => { closed = true; }); closing.catch(() => {});
    await nextTurn(); await nextTurn();
    assert.equal(closed, false);
    assert.equal(ended(blocked.history, 'object-close'), -1);
    assert(!blocked.history.some(event => event.type === 'provider-cleanup'));
    blocked.release();
    assert.equal((await operation).isError, true);
    await closing;
    const provider = blocked.history.findIndex(event => event.type === 'provider-cleanup');
    assertBefore(blocked.history, 'object-append', 'object-close');
    assertBefore(blocked.history, 'object-close', 'native-cleanup');
    assert(provider >= 0, 'The audit provider must actually finish cleanup');
    assert(ended(blocked.history, 'native-cleanup') < provider);
    assert.equal(f.ctx.snapshot().plugins.length, 0);
    resourcesAreZero(f, { all: true });
  } finally {
    blocked.release();
    try { await Promise.allSettled([operation, closing].filter(Boolean)); } finally { await f.dispose(); }
  }
});

test('failed Rust resource close reports the JS sink failure and remains explicitly retryable', { timeout: 30000 }, async () => {
  const failed = new Set(), handles = [];
  const f = await fixture({ resources: true, resourceHooks: { beforeRecord(event) {
    if (['stream-close', 'object-close'].includes(event.kind) && !failed.has(event.kind)) {
      failed.add(event.kind); throw new Error(`Audit refused ${event.kind} once`);
    }
  } } });
  try {
    const stream = f.ctx.rustTextResources.chunks('text', 2), object = f.ctx.rustTextResources.session();
    handles.push(() => stream.return(), () => object.close());
    await stream.next();
    await object.call('append', 'text');
    await assert.rejects(stream.return(), /Audit refused stream-close once/);
    await assert.rejects(object.close(), /Audit refused object-close once/);
    await assert.rejects(object.call('snapshot'), { code: 'STALE_EPISODE' });
    await Promise.all([stream.return(), object.close()]);
    resourcesAreZero(f);
    assert.equal((await f.execute()).isError, false);
    await disable(f);
  } finally {
    await Promise.allSettled(handles.map(close => close()));
    await f.dispose();
  }
});
