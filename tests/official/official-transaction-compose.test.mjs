import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, domainMutation } from '@validation-engineering/cordis';
import { installOfficialTransactions, officialTransaction } from '../../src/integrations/deepseek-loader.mjs';

// Uses the real domain admission/observer machinery. Installed upstream
// filesystem reconciliation is exercised by the application's official suite.
async function fixture() {
  const ctx = new Context({ profile: 'harness' });
  class Entry { update() {} }
  class EntryGroup { update() {} create() {} remove() {} stop() {} }
  class EntryTree { create() {} update() {} remove() {} }
  class Hmr { runExclusive(operation) { return operation(); } partialReload() {} }
  class ConfigEditor {
    constructor(ownerContext) { this.ownerContext = ownerContext; }
    async edit(entry, change) {
      const value = change(entry.config);
      await Promise.resolve();
      entry.config = value;
      return value;
    }
  }
  installOfficialTransactions({ Entry, EntryGroup, EntryTree, Hmr, ConfigEditor });
  const tree = new (class Loader {})();
  tree.ctx = ctx; tree.root = { tree, data: [] }; tree.store = {};
  for (const name of ['entries', 'getTasks', 'await', 'resolve', 'resolveGroup', 'create', 'update', 'remove', 'write']) tree[name] = () => {};
  const editor = new ConfigEditor(ctx);
  ctx.provide('loader', tree); ctx.provide('configEditor', editor);
  const fiber = await ctx.plugin(() => {}), entry = { fiber, config: { version: 1 } };
  tree.store.entry = entry;
  return { ctx, editor, entry };
}

test('official host revision joins ConfigEditor edits and keeps readiness work in the FIFO slot', async () => {
  const { ctx, editor, entry } = await fixture();
  const ready = Promise.withResolvers(), release = Promise.withResolvers(), order = [];
  try {
    const first = officialTransaction(ctx, async () => {
      await editor.edit(entry, () => ({ version: 2 }));
      order.push('updated'); ready.resolve();
      await release.promise;
      await editor.edit(entry, () => ({ version: 1 }));
      order.push('restored');
      return entry.config.version;
    });
    await ready.promise;
    const second = domainMutation(ctx, () => { order.push('next'); });
    assert.deepEqual(order, ['updated']);
    release.resolve();
    assert.equal(await first, 1);
    await second;
    assert.deepEqual(order, ['updated', 'restored', 'next']);
  } finally { release.resolve(); await ctx.dispose(); }
});

test('config change callbacks and their asynchronous descendants cannot borrow official host authority', async () => {
  const { ctx, editor, entry } = await fixture();
  let nested, delayed;
  try {
    await officialTransaction(ctx, async () => {
      await editor.edit(entry, current => {
        nested = assert.rejects(editor.edit(entry, () => ({ version: 99 })), { code: 'REENTRANT_MUTATION' });
        delayed = Promise.resolve().then(() => assert.rejects(officialTransaction(ctx, () => {}), error => ['REENTRANT_MUTATION', 'STALE_EPISODE'].includes(error.code)));
        return current;
      });
      await nested; await delayed;
    });
    assert.equal(entry.config.version, 1);
  } finally { await ctx.dispose(); }
});

test('plugin setup cannot join an outer official host transaction', async () => {
  const { ctx, editor, entry } = await fixture();
  try {
    await officialTransaction(ctx, async () => {
      const fiber = ctx.plugin(async () => {
        await assert.rejects(editor.edit(entry, () => ({ version: 99 })), { code: 'REENTRANT_MUTATION' });
        await assert.rejects(officialTransaction(ctx, () => {}), { code: 'REENTRANT_MUTATION' });
      });
      await fiber;
    });
    assert.equal(entry.config.version, 1);
  } finally { await ctx.dispose(); }
});
