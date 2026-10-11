import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';

if (!process.execArgv.some(arg => arg === '--import' || arg.startsWith('--import='))) {
  await import('../../scripts/official-register.mjs');
}
const { Context, domainMutation } = await import('@deepseek-ai/cordis');
const { LoaderTransactions } = await import('../../src/official-loader-api.mjs');
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { default: Include } = await import('@deepseek-ai/cordis-plugin-include');
const { default: Schema } = await import('@deepseek-ai/schemastery');

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cordis-official-transaction-'));
  const ctx = new Context();
  const active = new Map(), history = [];
  const plugin = {
    name: 'transaction-probe',
    ...(options.volatile ? { Config: Schema.object({ value: Schema.number().volatile() }) } : {}),
    async apply(child, config) {
      const id = child.fiber.entry.id;
      history.push(['apply', id]);
      active.set(id, config);
      child.effect(() => async () => {
        await options.cleanup?.(id, config);
        active.delete(id);
        history.push(['dispose', id]);
      });
      await options.setup?.(child, config);
    },
  };
  const files = Object.fromEntries(['left', 'right'].map(name => [name, join(directory, name + (options.yaml ? '.yml' : '.json'))]));
  const initial = [{ id: 'probe', name: 'cordis:transaction-probe', config: { value: 1 } }];
  try {
    for (const file of Object.values(files)) await writeFile(file, JSON.stringify(initial));
    await ctx.plugin(Loader);
    ctx.loader.builtins.include = Include;
    ctx.loader.builtins['transaction-probe'] = plugin;
    await ctx.loader.root.update(Object.entries(files).map(([id, file]) => ({ id, name: 'cordis:include', config: { path: pathToFileURL(file).href } })));
    await ctx.loader.await();
    const trees = Object.fromEntries(Object.keys(files).map(id => [id, ctx.loader.resolve(id).subtree]));
    assert.equal(active.size, 2);
    return { directory, ctx, active, history, files, trees,
      transactions: Object.fromEntries(Object.entries(trees).map(([id, tree]) => [id, new LoaderTransactions(ctx, tree)])),
      async dispose() { try { await ctx.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } },
    };
  } catch (error) {
    try { await ctx.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}

test('official Include transactions serialize two trees through asynchronous inverse and file-write completion', { timeout: 15000 }, async () => {
  const cleanupEntered = Promise.withResolvers(), cleanupRelease = Promise.withResolvers();
  const writeEntered = Promise.withResolvers(), writeRelease = Promise.withResolvers();
  const f = await fixture({ cleanup: async (id, config) => {
    if (id === 'left:probe' && config.value === 1) { cleanupEntered.resolve(); await cleanupRelease.promise; }
  } });
  const tree = f.trees.left;
  const write = tree._writeFile;
  tree._writeFile = async function (config) { writeEntered.resolve(); await writeRelease.promise; return write.call(this, config); };
  try {
    let firstDone = false, secondDone = false;
    const first = f.transactions.left.update('probe', { config: { value: 2 } }).then(() => { firstDone = true; });
    await Promise.race([cleanupEntered.promise, first.then(() => { throw new Error('Revision finished before expected cleanup'); })]);
    const second = f.transactions.right.update('probe', { config: { value: 3 } }).then(() => { secondDone = true; });
    await nextTurn();
    assert.equal(firstDone, false);
    assert.equal(secondDone, false);
    assert.equal(f.trees.right.resolve('probe').options.config.value, 1);
    cleanupRelease.resolve();
    await writeEntered.promise;
    await nextTurn();
    assert.equal(firstDone, false, 'The lifecycle is insufficient while persistence is pending');
    assert.equal(f.trees.right.resolve('probe').options.config.value, 1);
    writeRelease.resolve();
    await Promise.all([first, second]);
    assert.equal(JSON.parse(await readFile(f.files.left, 'utf8'))[0].config.value, 2);
    assert.equal(JSON.parse(await readFile(f.files.right, 'utf8'))[0].config.value, 3);
    assert.equal(f.active.get('left:probe').value, 2);
    assert.equal(f.active.get('right:probe').value, 3);
  } finally { cleanupRelease.resolve(); writeRelease.resolve(); tree._writeFile = write; await f.dispose(); }
});

test('domain shutdown waits for an admitted official Include write', { timeout: 15000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture();
  const tree = f.trees.left, write = tree._writeFile;
  tree._writeFile = async function (config) { entered.resolve(); await release.promise; return write.call(this, config); };
  try {
    const update = f.transactions.left.update('probe', { config: { value: 8 } });
    await Promise.race([entered.promise, update.then(() => { throw new Error('Revision finished before expected write'); })]);
    let closed = false;
    const close = f.ctx.dispose().then(() => { closed = true; });
    await nextTurn();
    assert.equal(closed, false);
    assert.equal(f.active.size, 2);
    const before = await readFile(f.files.right, 'utf8');
    await assert.rejects(f.transactions.right.update('probe', { config: { value: 9 } }), { code: 'DOMAIN_CLOSED' });
    assert.equal(f.trees.right.resolve('probe').options.config.value, 1);
    assert.equal(await readFile(f.files.right, 'utf8'), before);
    release.resolve();
    await update;
    await close;
    assert.equal(f.active.size, 0);
    assert.equal(JSON.parse(await readFile(f.files.left, 'utf8'))[0].config.value, 8);
    assert.equal(f.ctx.snapshot().plugins.length, 0);
  } finally { release.resolve(); tree._writeFile = write; await f.dispose(); }
});

test('official Include write failure rejects the transaction without pretending to roll back running plugins', { timeout: 15000 }, async () => {
  const f = await fixture();
  const tree = f.trees.left, write = tree._writeFile;
  const reason = new Error('injected write failure');
  tree._writeFile = async () => { throw reason; };
  try {
    const before = await readFile(f.files.left, 'utf8');
    await assert.rejects(f.transactions.left.update('probe', { config: { value: 5 } }), { code: 'OFFICIAL_PERSISTENCE_FAILED' });
    assert.equal(await readFile(f.files.left, 'utf8'), before);
    assert.equal(f.active.get('left:probe').value, 5, 'A failed disk write is not an atomic rollback of plugin effects');
    tree._writeFile = write;
    await f.transactions.left.update('probe', { config: { value: 6 } });
    assert.equal(JSON.parse(await readFile(f.files.left, 'utf8'))[0].config.value, 6);
    assert.equal(f.active.get('left:probe').value, 6);
  } finally { tree._writeFile = write; tree.write(); await tree.flushWrite(); await f.dispose(); }
});

test('official transactions create a real imported plugin and remove it only after async cleanup and persistence', { timeout: 15000 }, async () => {
  const f = await fixture();
  const plugin = join(f.directory, 'imported.mjs');
  await writeFile(plugin, `export async function apply(ctx, config) {
    await Promise.resolve();
    ctx.provide('importedTransactionValue', config.value);
    ctx.effect(() => async () => { await new Promise(resolve => setImmediate(resolve)); });
  }\n`);
  try {
    const id = await f.transactions.left.create({ name: pathToFileURL(plugin).href, config: { value: 'imported' } });
    const entry = f.ctx.loader.resolve(id);
    const localId = entry.options.id;
    const fiber = entry.fiber;
    assert.equal(fiber.state, 2);
    assert.equal(fiber.ctx.get('importedTransactionValue'), 'imported');
    assert(JSON.parse(await readFile(f.files.left, 'utf8')).some(row => row.id === localId));
    await new LoaderTransactions(f.ctx, f.ctx.loader).remove(id);
    assert.equal(fiber.uid, null);
    assert(!f.ctx.snapshot().plugins.some(row => String(row.id) === String(fiber.id)));
    assert(!JSON.parse(await readFile(f.files.left, 'utf8')).some(row => row.id === localId));
  } finally { await f.dispose(); }
});

test('official YAML expression configs keep their raw form and restore into a fresh native Context', { timeout: 15000 }, async () => {
  const f = await fixture({ yaml: true });
  let next;
  try {
    await f.transactions.left.update('probe', { config: { value: { __jsExpr: '21 * 2' } } });
    const saved = await readFile(f.files.left, 'utf8');
    assert.match(saved, /!!js/);
    assert.equal(f.active.get('left:probe').value, 42);
    await f.ctx.dispose();
    next = new Context();
    await next.plugin(Loader);
    next.loader.builtins.include = Include;
    let restored;
    next.loader.builtins['transaction-probe'] = (_ctx, config) => { restored = config.value; };
    await next.loader.root.update([{ id: 'left', name: 'cordis:include', config: { path: pathToFileURL(f.files.left).href } }]);
    await next.loader.await();
    assert.equal(restored, 42);
  } finally { if (next) await next.dispose(); await f.dispose(); }
});

test('official volatile config edits persist without remounting the plugin', { timeout: 15000 }, async () => {
  const f = await fixture({ volatile: true });
  try {
    const fiber = f.trees.left.resolve('probe').fiber;
    const ref = f.active.get('left:probe').value;
    const count = f.history.length;
    await f.transactions.left.update('probe', { config: { value: 7 } });
    assert.equal(f.trees.left.resolve('probe').fiber, fiber);
    assert.equal(f.history.length, count);
    assert.equal(ref.get(), 7);
    assert.equal(JSON.parse(await readFile(f.files.left, 'utf8'))[0].config.value, 7);
  } finally { await f.dispose(); }
});

test('plugin setup cannot reenter an official Loader transaction', { timeout: 15000 }, async () => {
  let edits, rejected;
  const f = await fixture({ setup: async (_ctx, config) => {
    if (config.value !== 2) return;
    try { await edits.update('probe', { config: { value: 99 } }); }
    catch (error) { rejected = error; }
  } });
  edits = f.transactions.left;
  try {
    await edits.update('probe', { config: { value: 2 } });
    assert.equal(rejected?.code, 'REENTRANT_MUTATION');
    assert.equal(f.active.get('left:probe').value, 2);
    assert.equal(JSON.parse(await readFile(f.files.left, 'utf8'))[0].config.value, 2);
  } finally { await f.dispose(); }
});


test('an adapter retained after Include disposal rejects before touching config or files', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    await new LoaderTransactions(f.ctx, f.ctx.loader).remove('left');
    const before = await readFile(f.files.left, 'utf8');
    const options = structuredClone(f.trees.left.root.data);
    await assert.rejects(f.transactions.left.create({ name: 'cordis:transaction-probe', config: { value: 99 } }), { code: 'STALE_LOADER' });
    assert.equal(await readFile(f.files.left, 'utf8'), before);
    assert.deepEqual(f.trees.left.root.data, options);
  } finally { await f.dispose(); }
});

test('an already queued edit rejects after the owning Include changes episode', { timeout: 15000 }, async () => {
  const f = await fixture();
  const release = Promise.withResolvers();
  let restart, edit;
  try {
    const owner = f.ctx.loader.resolve('left').fiber;
    restart = domainMutation(f.ctx, async steps => { await release.promise; await steps.restart(owner); });
    edit = f.transactions.left.update('probe', { config: { value: 99 } });
    const rejected = assert.rejects(edit, { code: 'STALE_LOADER' });
    release.resolve();
    await restart;
    await rejected;
    assert.notEqual(f.ctx.loader.resolve('left').subtree, f.trees.left);
    assert.equal(JSON.parse(await readFile(f.files.left, 'utf8'))[0].config.value, 1);
    assert.equal(f.active.get('left:probe').value, 1);
  } finally { release.resolve(); await Promise.allSettled([restart, edit]); await f.dispose(); }
});

test('unconfirmed official plugin cleanup prevents another tree revision from changing options or files', { timeout: 15000 }, async () => {
  let fail = true;
  const f = await fixture({ cleanup: (id) => { if (id === 'left:probe' && fail) throw new Error('injected cleanup failure'); } });
  const fiber = f.trees.left.resolve('probe').fiber;
  try {
    await assert.rejects(f.transactions.left.remove('probe'), /cleanup/i);
    assert(f.ctx.snapshot().plugins.some(row => row.cleanupFailed));
    const before = await readFile(f.files.right, 'utf8');
    await assert.rejects(f.transactions.right.update('probe', { config: { value: 99 } }), { code: 'CLEANUP_BLOCKED' });
    assert.equal(f.trees.right.resolve('probe').options.config.value, 1);
    assert.equal(await readFile(f.files.right, 'utf8'), before);
    fail = false;
    await fiber.retryCleanup();
  } finally { fail = false; if (f.ctx.snapshot().plugins.some(row => row.cleanupFailed)) await fiber.retryCleanup(); await f.dispose(); }
});
