import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fixture } from './native-loader-fixture.mjs';
import { createTextMetrics, MAX_TEXT_BYTES } from '../../examples/official/text-pipeline.mjs';

function nativeResourcesAreZero(f) {
  const modules = f.ctx.fiber._domain.rust.command({ op: 'module_info' }).modules;
  assert(modules.length > 0, 'Inspect actually loaded dynamic libraries');
  for (const image of modules) {
    assert(Object.keys(image.resources).length > 0);
    for (const [kind, count] of Object.entries(image.resources)) assert.equal(count, 0, `${image.moduleId ?? image.buildId}: ${kind}`);
  }
}
function jsResourcesAreZero(f) {
  const state = f.ctx.textPipeline.inspect();
  assert.equal(state.streams, 0);
  assert.equal(state.sessions, 0);
  assert.equal(f.ctx.fiber._domain.rust.streams.resources.size, 0);
  assert.equal(f.ctx.fiber._domain.rust.objects.resources.size, 0);
  return state;
}
async function disable(f) {
  await f.transactions.update(f.generatedEntries ? 'rust-js-pipeline' : 'native', { disabled: true });
  await f.ctx.loader.await(); await f.ctx.settle();
  jsResourcesAreZero(f); nativeResourcesAreZero(f);
}
async function awaitEntry(entered, operation) {
  await Promise.race([entered, operation.then(
    () => { throw new Error('The operation completed before the expected resource checkpoint'); },
    error => { throw error; },
  )]);
}
function before(history, first, second, revision = 'js-pipeline-v1') {
  const index = type => history.findIndex(event => event.type === type && event.providerRevision === revision);
  const a = index(first), b = index(second);
  assert(a >= 0, `Missing ${first}`); assert(b >= 0, `Missing ${second}`);
  assert(a < b, `${first} must complete before ${second}`);
}
function blockedHook(kind) {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), history = [];
  let blocked = true;
  return { entered: entered.promise, history,
    release() { blocked = false; release.resolve(); },
    hooks: { onEvent: event => history.push(event),
      [kind]: async () => { if (blocked) { entered.resolve(); await release.promise; } },
    },
  };
}
function retirement(f) {
  const consumer = f.ctx.loader.resolve(f.readyEntries[0]).fiber, entered = Promise.withResolvers();
  const off = f.ctx.on('internal/status', changed => {
    if (changed === consumer && changed.state === 5) entered.resolve();
  }, { global: true });
  return { entered: entered.promise, off, consumer };
}

// A source-level unit test: no native factory is loaded by this case.
test('JS text metrics preserve cross-chunk Rust whitespace/CRLF semantics and reject bounds without mutation', () => {
  const metrics = createTextMetrics('js-v1');
  for (const part of ['hel', 'lo 世', '界\r', '\nlast']) metrics.append(part);
  assert.deepEqual(metrics.snapshot(), { providerRevision: 'js-v1', bytes: 18, characters: 14, words: 3, lines: 2, chunks: 4 });
  for (const [text, words, lines] of [['', 0, 0], ['a\uFEFFb', 1, 1], ['a\u0085b', 2, 1], ['\n\n', 0, 2], ['a\r\n', 1, 1], ['\r', 0, 1]]) {
    const sample = createTextMetrics('fixed');
    for (const character of text) sample.append(character);
    assert.equal(sample.snapshot().words, words);
    assert.equal(sample.snapshot().lines, lines);
  }
  const bounded = createTextMetrics('limit');
  bounded.append('x'.repeat(MAX_TEXT_BYTES));
  const prior = bounded.snapshot();
  assert.throws(() => bounded.append('界'), /exceeds/);
  assert.throws(() => bounded.append('\uD800'), /Unicode/);
  assert.deepEqual(bounded.snapshot(), prior);
});

test('generated JS pipeline fileURL recipes run a real Rust consumer of JS stream and owned sink through ToolRuntime', { timeout: 30000 }, async () => {
  const f = await fixture({ pipeline: true, generatedPipeline: true });
  try {
    const entries = f.generatedEntries;
    assert.deepEqual(entries.map(entry => entry.id), ['text-pipeline', 'rust-js-pipeline', 'rust-js-pipeline-tool']);
    assert.equal(new URL(entries[0].name).protocol, 'file:');
    assert.equal(new URL(entries[2].name).protocol, 'file:');
    assert.deepEqual(entries[1].inject, ['textPipeline']);
    assert(Object.hasOwn(f.entry.fiber.inject, 'textPipeline'));
    assert.deepEqual(f.entry.options.config, entries[1].config);
    const result = await f.execute({ text: 'Hello 世界\r\nRust 🦀\n', chunkCharacters: 1 });
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, { backend: 'rust-js-resources', revision: 'v1', providerRevision: 'js-pipeline-v1', bytes: 24, characters: 17, lines: 2, words: 4, chunks: 17 });
    jsResourcesAreZero(f);
    const empty = await f.execute({ text: '', chunkCharacters: 2 });
    assert.equal(empty.isError, false); assert.equal(empty.value.chunks, 0); assert.equal(empty.value.lines, 0);
    for (const options of [{ chunkCharacters: 0 }, { chunkCharacters: 4097 }, { text: 'x'.repeat(MAX_TEXT_BYTES + 1) }]) {
      assert.equal((await f.execute(options)).isError, true); jsResourcesAreZero(f);
    }
    const many = await f.execute({ text: 'x'.repeat(80), chunkCharacters: 1 });
    assert.equal(many.isError, false);
    const audit = jsResourcesAreZero(f);
    assert.equal(audit.recent.length, 64); assert(audit.total > audit.recent.length);
    assert(audit.recent.every(event => !Object.hasOwn(event, 'text')));
    // The JS schema allows 100 Unicode characters; valid non-ASCII metadata
    // must not be rejected by a narrower byte limit in the Rust consumer.
    const unicodeRevision = '界'.repeat(100);
    await f.editor.edit(f.pipelineEntry, () => ({ revision: unicodeRevision }));
    await f.ctx.loader.await(); await f.ctx.settle();
    const unicode = await f.execute();
    assert.equal(unicode.isError, false); assert.equal(unicode.value.providerRevision, unicodeRevision);
    await disable(f);
  } finally { await f.dispose(); }
});

test('borrowed policy lifetime stays with its JS provider while owned sessions remain isolated across calls and Rust revisions', { timeout: 30000 }, async () => {
  const history = [], f = await fixture({ pipeline: true, pipelineHooks: { onEvent: event => history.push(event) } });
  try {
    const results = await Promise.all([f.execute({ text: 'one 世界', chunkCharacters: 1 }), f.execute({ text: 'a\r\nb c', chunkCharacters: 2 })]);
    assert(results.every(result => !result.isError));
    assert.deepEqual(results.map(result => [result.value.words, result.value.lines, result.value.chunks]), [[2, 1, 6], [3, 2, 3]]);
    assert.equal(history.filter(event => event.type === 'policy-read').length, 2);
    assert.equal(history.filter(event => event.type === 'object-close').length, 2);
    assert.equal(history.filter(event => event.type === 'policy-owner-close').length, 0);
    assert.equal(jsResourcesAreZero(f).policyAlive, true);
    const old = f.ctx.rustJsTextPipeline;
    await f.update('v2');
    await assert.rejects(async () => old.analyze('old', 1), { code: 'STALE_EPISODE' });
    const result = await f.execute();
    assert.equal(result.isError, false); assert.equal(result.value.revision, 'v2');
    assert.equal(result.value.providerRevision, 'js-pipeline-v1');
    assert.equal(f.ctx.fiber._domain.driver, f.driver); assert.equal(process.pid, f.pid);
    assert.equal(history.filter(event => event.type === 'policy-owner-close').length, 0);
    await disable(f);
    assert.equal(f.ctx.textPipeline.inspect().policyAlive, true, 'Borrowed release does not dispose its provider-owned referent');
    await f.ctx.dispose();
    assert.equal(history.filter(event => event.type === 'policy-owner-close').length, 1);
    nativeResourcesAreZero(f);
  } finally { await f.dispose(); }
});

test('JS provider replacement waits for a real owned object call before closing the old pipeline and reactivating Rust', { timeout: 30000 }, async () => {
  const blocked = blockedHook('beforeAppend');
  const f = await fixture({ pipeline: true, pipelineHooks: blocked.hooks });
  let operation, update, checkpoint;
  try {
    const old = f.ctx.rustJsTextPipeline, digest = f.entry.options.config.sha256;
    operation = f.execute({ chunkCharacters: 2 }); operation.catch(() => {});
    await awaitEntry(blocked.entered, operation);
    checkpoint = retirement(f);
    let updated = false;
    update = f.editor.edit(f.pipelineEntry, () => ({ revision: 'js-pipeline-v2' })).then(value => { updated = true; return value; }); update.catch(() => {});
    await awaitEntry(checkpoint.entered, Promise.race([operation, update]));
    assert.equal(updated, false);
    assert(!blocked.history.some(event => event.type === 'object-close'));
    assert(!blocked.history.some(event => event.type === 'native-cleanup'));
    blocked.release();
    assert.equal((await operation).isError, true);
    await update; await f.ctx.loader.await(); await f.ctx.settle();
    before(blocked.history, 'object-append-end', 'object-close');
    before(blocked.history, 'object-close', 'native-cleanup');
    before(blocked.history, 'native-cleanup', 'policy-owner-close');
    before(blocked.history, 'policy-owner-close', 'provider-cleanup');
    await assert.rejects(async () => old.analyze('stale', 1), { code: 'STALE_EPISODE' });
    const result = await f.execute();
    assert.equal(result.isError, false); assert.equal(result.value.providerRevision, 'js-pipeline-v2');
    assert.equal(result.value.revision, 'v1'); assert.equal(f.entry.options.config.sha256, digest);
    assert.equal(f.ctx.fiber._domain.driver, f.driver); assert.equal(process.pid, f.pid);
    await disable(f);
  } finally {
    blocked.release(); checkpoint?.off();
    try { await Promise.allSettled([operation, update].filter(Boolean)); } finally { await f.dispose(); }
  }
});

test('user cancellation waits for the actual JS stream pull and closes action-owned JS capabilities before reporting completion', { timeout: 30000 }, async () => {
  const blocked = blockedHook('beforePull'), f = await fixture({ pipeline: true, pipelineHooks: blocked.hooks });
  let operation;
  try {
    const controller = new AbortController();
    let settled = false;
    operation = f.execute({ text: 'cancel 世界', chunkCharacters: 2, signal: controller.signal });
    operation.then(() => { settled = true; }, () => { settled = true; });
    await awaitEntry(blocked.entered, operation);
    controller.abort(new Error('User cancelled JS pipeline'));
    await nextTurn(); await nextTurn();
    assert.equal(settled, false);
    assert(!blocked.history.some(event => event.type === 'stream-next-end'));
    assert(!blocked.history.some(event => event.type === 'stream-close'));
    blocked.release();
    assert.equal((await operation).isError, true);
    before(blocked.history, 'stream-next-end', 'stream-close');
    jsResourcesAreZero(f);
    assert.equal((await f.execute()).isError, false);
    await disable(f);
  } finally {
    blocked.release();
    try { await Promise.allSettled([operation].filter(Boolean)); } finally { await f.dispose(); }
  }
});

test('official shutdown drains pending JS work and resource disposal before native cleanup and JS policy-owner destruction', { timeout: 30000 }, async () => {
  const blocked = blockedHook('beforeAppend'), f = await fixture({ pipeline: true, pipelineHooks: blocked.hooks });
  let operation, closing;
  try {
    operation = f.execute(); operation.catch(() => {});
    await awaitEntry(blocked.entered, operation);
    let closed = false;
    closing = f.ctx.dispose().then(() => { closed = true; }); closing.catch(() => {});
    await nextTurn(); await nextTurn();
    assert.equal(closed, false);
    assert(!blocked.history.some(event => event.type === 'object-close'));
    assert(!blocked.history.some(event => event.type === 'provider-cleanup'));
    blocked.release();
    assert.equal((await operation).isError, true);
    await closing;
    before(blocked.history, 'object-append-end', 'object-close');
    before(blocked.history, 'object-close', 'native-cleanup');
    before(blocked.history, 'native-cleanup', 'policy-owner-close');
    before(blocked.history, 'policy-owner-close', 'provider-cleanup');
    assert.equal(f.ctx.snapshot().plugins.length, 0);
    assert.equal(f.ctx.fiber._domain.rust.streams.resources.size, 0);
    assert.equal(f.ctx.fiber._domain.rust.objects.resources.size, 0);
    nativeResourcesAreZero(f);
  } finally {
    blocked.release();
    try { await Promise.allSettled([operation, closing].filter(Boolean)); } finally { await f.dispose(); }
  }
});

test('failed JS owned-object disposal stays visible and a later lifecycle cleanup retries the retained resource', { timeout: 30000 }, async () => {
  let attempts = 0;
  const history = [], f = await fixture({ pipeline: true, pipelineHooks: {
    onEvent: event => history.push(event),
    beforeClose(event) { if (event.kind === 'object' && ++attempts === 1) throw new Error('JS text session refused its first close'); },
  } });
  try {
    const failed = await f.execute({ text: 'retry me', chunkCharacters: 2 });
    assert.equal(failed.isError, true, 'A failed close must not become a successful tool result');
    assert.equal(attempts, 1, 'Action completion must not silently retry a reported close failure');
    assert.equal(f.ctx.textPipeline.inspect().sessions, 1, 'The provider retains the object until successful disposal');
    assert.equal(history.filter(event => event.type === 'object-close').length, 0);
    await disable(f);
    assert.equal(attempts, 2);
    assert.equal(history.filter(event => event.type === 'object-close').length, 1);
    await f.transactions.update('native', { disabled: false });
    await f.ctx.loader.await(); await f.ctx.settle();
    assert.equal((await f.execute()).isError, false);
    await disable(f);
  } finally { await f.dispose(); }
});
