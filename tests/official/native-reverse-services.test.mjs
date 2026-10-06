import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fixture } from './native-loader-fixture.mjs';

const firstPolicy = { revision: 'policy-v1', prefix: '[one] ', uppercase: false };
const secondPolicy = { revision: 'policy-v2', prefix: '[two] ', uppercase: true };
function position(history, type, revision) {
  const entries = history.map((event, index) => ({ ...event, index }))
    .filter(event => event.type === type && event.policyRevision === revision);
  assert.equal(entries.length, 1, `Expected one ${type} for ${revision}`);
  return entries[0].index;
}
function resourcesAreZero(f) {
  const images = f.ctx.fiber._domain.rust.command({ op: 'module_info' });
  assert(images.modules.length > 0, 'The check must inspect actually loaded libraries');
  for (const image of images.modules) {
    assert(image.resources && Object.keys(image.resources).length > 0);
    for (const [kind, count] of Object.entries(image.resources)) assert.equal(count, 0, `${image.buildId ?? image.pluginId}: ${kind}`);
  }
}
async function assertPolicy(f, revision, normalized) {
  const result = await f.execute({ text: 'Hello 世界' });
  assert.equal(result.isError, false);
  assert.equal(result.value.revision, 'v1');
  assert.equal(result.value.policyRevision, revision);
  assert.equal(result.value.bytes, Buffer.byteLength(normalized));
  assert.equal(result.value.characters, [...normalized].length);
}

test('an official JS provider update reactivates its dependent cdylib and drains consumer/native cleanup before the old JS provider', { timeout: 30000 }, async () => {
  const history = [];
  let f;
  f = await fixture({ policy: firstPolicy, policyHooks: { onEvent(event) {
    history.push({ ...event, ...(event.type === 'native-cleanup' ? { toolPresent: !!f?.ctx.tools.get('rust_policy_text_analyze') } : {}) });
  } } });
  try {
    const oldService = f.ctx.rustPolicyText;
    const codeDigest = f.entry.options.config.sha256;
    await assertPolicy(f, 'policy-v1', '[one] Hello 世界');
    await f.editor.edit(f.policyEntry, () => structuredClone(secondPolicy));
    await f.ctx.loader.await(); await f.ctx.settle();
    await assertPolicy(f, 'policy-v2', '[two] HELLO 世界');
    assert.equal(f.entry.options.config.sha256, codeDigest, 'A JS dependency change restarts the same Rust code generation');
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    assert.equal(process.pid, f.pid);
    await assert.rejects(async () => oldService.analyze('stale'), { code: 'STALE_EPISODE' });
    assert(position(history, 'native-cleanup', 'policy-v1') < position(history, 'provider-cleanup', 'policy-v1'));
    assert(position(history, 'provider-cleanup', 'policy-v1') < position(history, 'provider-setup', 'policy-v2'));
    assert(position(history, 'provider-setup', 'policy-v2') < position(history, 'native-setup', 'policy-v2'));
    assert.equal(history.find(event => event.type === 'native-cleanup' && event.policyRevision === 'policy-v1').toolPresent, false,
      'The real ToolRuntime registration must be removed before Rust cleanup calls the committed JS service');
    await f.transactions.update('native', { disabled: true });
    await f.ctx.loader.await(); await f.ctx.settle();
    resourcesAreZero(f);
  } finally { await f.dispose(); }
});

test('cancellation and JS provider replacement wait for an already-started reverse Promise to land', { timeout: 30000 }, async () => {
  const history = [], entered = Promise.withResolvers(), release = Promise.withResolvers();
  let blocked = true, f, operation, update;
  f = await fixture({ policy: firstPolicy, policyHooks: {
    onEvent: event => history.push(event),
    beforeNormalize: async () => { if (blocked) { entered.resolve(); await release.promise; } },
  } });
  try {
    const controller = new AbortController();
    operation = f.execute({ signal: controller.signal });
    operation.catch(() => {});
    await entered.promise;
    controller.abort(new Error('User cancelled the tool'));
    let updated = false;
    update = f.editor.edit(f.policyEntry, () => structuredClone(secondPolicy)).then(() => { updated = true; });
    update.catch(() => {});
    await nextTurn(); await nextTurn();
    assert.equal(updated, false);
    assert(!history.some(event => event.type === 'normalize-end'));
    assert(!history.some(event => event.type === 'native-cleanup'));
    assert(!history.some(event => event.type === 'provider-cleanup'));
    blocked = false;
    release.resolve();
    assert.equal((await operation).isError, true);
    await update;
    await f.ctx.loader.await(); await f.ctx.settle();
    assert(position(history, 'normalize-end', 'policy-v1') < position(history, 'native-cleanup', 'policy-v1'));
    assert(position(history, 'native-cleanup', 'policy-v1') < position(history, 'provider-cleanup', 'policy-v1'));
    await assertPolicy(f, 'policy-v2', '[two] HELLO 世界');
    await f.transactions.update('native', { disabled: true });
    await f.ctx.loader.await(); await f.ctx.settle();
    resourcesAreZero(f);
  } finally {
    blocked = false; release.resolve();
    await Promise.allSettled([operation, update].filter(Boolean));
    await f.dispose();
  }
});

test('official shutdown keeps the reverse channel alive through actual JS completion and native cleanup, then releases every resource', { timeout: 30000 }, async () => {
  const history = [], entered = Promise.withResolvers(), release = Promise.withResolvers();
  let f, operation, closing;
  f = await fixture({ policy: firstPolicy, policyHooks: {
    onEvent: event => history.push(event),
    beforeNormalize: async () => { entered.resolve(); await release.promise; },
  } });
  try {
    operation = f.execute();
    operation.catch(() => {});
    await entered.promise;
    let closed = false;
    closing = f.ctx.dispose().then(() => { closed = true; });
    closing.catch(() => {});
    await nextTurn(); await nextTurn();
    assert.equal(closed, false);
    assert(!history.some(event => event.type === 'provider-cleanup'));
    release.resolve();
    assert.equal((await operation).isError, true);
    await closing;
    assert(position(history, 'normalize-end', 'policy-v1') < position(history, 'native-cleanup', 'policy-v1'));
    assert(position(history, 'native-cleanup', 'policy-v1') < position(history, 'provider-cleanup', 'policy-v1'));
    assert.equal(f.ctx.snapshot().plugins.length, 0);
    resourcesAreZero(f);
  } finally {
    release.resolve();
    await Promise.allSettled([operation, closing].filter(Boolean));
    await f.dispose();
  }
});


test('generated policy profile file URLs load the real JS provider and tool through the official Loader', { timeout: 30000 }, async () => {
  const f = await fixture({ policy: firstPolicy, generatedPolicy: true });
  try {
    assert.equal(f.generatedEntries.length, 3);
    assert.deepEqual(f.generatedEntries.map(entry => entry.id), ['text-policy', 'rust-policy', 'rust-policy-tool']);
    assert.equal(new URL(f.generatedEntries[0].name).protocol, 'file:');
    assert.equal(f.generatedEntries[1].name, 'cordis:rust-module');
    assert.deepEqual(f.generatedEntries[1].inject, ['textPolicy']);
    assert(Object.hasOwn(f.entry.fiber.inject, 'textPolicy'), 'The outer Loader Fiber must wait for the JS provider before creating strict native children');
    assert.equal(new URL(f.generatedEntries[2].name).protocol, 'file:');
    assert.equal(f.policyEntry.options.name, f.generatedEntries[0].name);
    assert.equal(f.ctx.loader.resolve('include:rust-policy-tool').options.name, f.generatedEntries[2].name);
    assert.deepEqual(f.entry.options.config, f.generatedEntries[1].config);
    await assertPolicy(f, 'policy-v1', '[one] Hello 世界');
    await f.editor.edit(f.policyEntry, () => structuredClone(secondPolicy));
    await f.ctx.loader.await(); await f.ctx.settle();
    await assertPolicy(f, 'policy-v2', '[two] HELLO 世界');
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    assert.equal(process.pid, f.pid);
    await f.transactions.update('rust-policy', { disabled: true });
    await f.ctx.loader.await(); await f.ctx.settle();
    resourcesAreZero(f);
  } finally { await f.dispose(); }
});
