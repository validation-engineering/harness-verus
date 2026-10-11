import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, domainMutation } from '@validation-engineering/cordis';
import { Context as HarnessContext } from '@validation-engineering/cordis-compat-deepseek';
import { LoaderTransactions } from '../../src/integrations/deepseek-loader.mjs';

// Only an admission-contract fixture; it intentionally performs no Loader or
// persistence behavior. Actual upstream Loader/Include execution is tested in
// harness-verus against its installed, source-locked official packages.
function contract(ctx) {
  const tree = new (class Loader {})();
  tree.ctx = ctx;
  tree.root = { tree, data: [] };
  tree.store = {};
  for (const name of ['entries', 'getTasks', 'await', 'resolve', 'resolveGroup', 'create', 'update', 'remove', 'write']) tree[name] = () => {};
  return tree;
}

test('official transactions require the native Harness profile and a complete tree contract', async () => {
  const ordinary = new Context(), native = new HarnessContext();
  try {
    assert.throws(() => new LoaderTransactions(ordinary, contract(ordinary)), { code: 'INCOMPATIBLE_OFFICIAL_LOADER' });
    assert.throws(() => new LoaderTransactions(native, {}), { code: 'INCOMPATIBLE_OFFICIAL_LOADER' });
    const partial = contract(native);
    delete partial.resolveGroup;
    assert.throws(() => new LoaderTransactions(native, partial), { code: 'INCOMPATIBLE_OFFICIAL_LOADER' });
    const include = Object.assign(new (class Include {})(), contract(native));
    include.root.tree = include;
    assert.throws(() => new LoaderTransactions(native, include), { code: 'INCOMPATIBLE_OFFICIAL_LOADER' });
  } finally { await ordinary.dispose(); await native.dispose(); }
});

test('official transactions reject foreign domains before invoking any tree method', async () => {
  const left = new HarnessContext(), right = new HarnessContext();
  try {
    assert.throws(() => new LoaderTransactions(left, contract(right)), { code: 'FOREIGN_DOMAIN' });
  } finally { await left.dispose(); await right.dispose(); }
});

test('queued official transactions recheck their captured methods before options can change', async () => {
  const ctx = new HarnessContext(), release = Promise.withResolvers();
  const tree = contract(ctx), adapter = new LoaderTransactions(ctx, tree);
  let called = false;
  const held = domainMutation(ctx, () => release.promise);
  const revision = adapter.update('entry', { disabled: true });
  tree.update = () => { called = true; };
  try {
    release.resolve();
    await held;
    await assert.rejects(revision, { code: 'INCOMPATIBLE_OFFICIAL_LOADER' });
    assert.equal(called, false);
    assert.equal(adapter.requestedRevision, 1);
    assert.equal(adapter.revision, 0);
    assert.equal(adapter.lastFailure.operation, 'update');
  } finally { release.resolve(); await ctx.dispose(); }
});

test('official adapter input copy rejects unsupported values before admission', async () => {
  const ctx = new HarnessContext(), adapter = new LoaderTransactions(ctx, contract(ctx));
  try {
    await assert.rejects(adapter.create({ name: 'probe', config: () => {} }), { name: 'DataCloneError' });
    assert.equal(adapter.requestedRevision, 0);
    assert.equal(adapter.revision, 0);
  } finally { await ctx.dispose(); }
});
