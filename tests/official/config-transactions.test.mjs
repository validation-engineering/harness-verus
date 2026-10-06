import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';

if (!process.execArgv.some(arg => arg === '--import' || arg.startsWith('--import='))) await import('../../scripts/official-register.mjs');
const { Context, domainMutation } = await import('@deepseek-ai/cordis');
const { default: Loader } = await import('../../official-runtime/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js');
const { default: Timer } = await import('../../official-runtime/node_modules/@deepseek-ai/cordis-plugin-timer/lib/index.js');
const { default: Hmr } = await import('../../official-runtime/node_modules/@deepseek-ai/dsh-hmr/lib/index.js');
const { ConfigEditor } = await import('../../official-runtime/node_modules/@deepseek-ai/dsh-config-editor/lib/index.js');
const { mountRootInclude, readProfilePatches } = await import('../../official-runtime/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
const { withFileLock } = await import('../../official-runtime/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js');
const { default: Schema } = await import('../../official-runtime/node_modules/@deepseek-ai/schemastery/lib/index.mjs');

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cordis-official-config-'));
  const ctx = new Context(), active = new Map(), history = [];
  const configPath = join(directory, 'cordis.json'), patchPath = join(directory, 'cordis.patch.yml');
  const profile = { name: 'transaction-fixture', dir: directory, patchPath, installAnchor: new URL('../../official-runtime/package.json', import.meta.url).pathname,
    home: join(directory, 'home'), cwd: directory, startedBundles: [], overlays: [], telemetryDisabledEnv: '1' };
  const patches = [{ insert: [{ id: 'probe', name: 'cordis:config-probe', config: { value: 1 } }] }];
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'config-fixture', dsh: { profile: { bundles: [] } } }));
  await writeFile(configPath, '[]\n');
  await writeFile(patchPath, JSON.stringify(patches));
  try {
    ctx.baseUrl = pathToFileURL(directory + '/').href;
    await ctx.plugin(Loader);
    if (options.hmr !== false) { await ctx.plugin(Timer); await ctx.plugin(Hmr, { root: [], ignored: [], base: '.', debounce: 5 }); assert.ok(ctx.hmr); }
    ctx.provide('profileContext', profile);
    ctx.loader.builtins['config-probe'] = {
      name: 'config-probe', Config: Schema.object({ value: Schema.number() }),
      async apply(child, config) {
        history.push(['apply', config.value]);
        child.effect(() => async () => { await options.cleanup?.(config, child); active.delete('probe'); history.push(['dispose', config.value]); });
        await options.setup?.(config, { ctx, child, patchPath, directory });
        active.set('probe', config.value);
      },
    };
    await mountRootInclude(ctx, configPath, readProfilePatches('dsh', profile), options.hostResolved ? new URL('../../official-runtime/', import.meta.url).href : undefined);
    await ctx.loader.await();
    await ctx.plugin(ConfigEditor);
    const entry = ctx.loader.resolve('include:probe'), tree = ctx.loader.resolve('include').subtree;
    assert.equal(active.get('probe'), 1);
    return { ctx, active, history, directory, configPath, patchPath, profile, entry, tree, editor: ctx.configEditor,
      async dispose() { try { await ctx.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } } };
  } catch (error) { try { await ctx.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } throw error; }
}

test('default ConfigEditor admits before the official file lock and serializes later edits and shutdown', { timeout: 20000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture();
  const before = await readFile(f.patchPath, 'utf8');
  const locked = withFileLock(join(f.directory, 'package.json'), async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  try {
    let changed = false, secondChanged = false, closed = false;
    const first = f.editor.edit(f.entry, config => { changed = true; return { ...config, value: 2 }; });
    const second = f.editor.edit(f.entry, config => { secondChanged = true; return { ...config, value: 3 }; });
    const shutdown = f.ctx.dispose().then(() => { closed = true; });
    await nextTurn();
    assert.equal(changed, false); assert.equal(secondChanged, false); assert.equal(closed, false);
    assert.equal(await readFile(f.patchPath, 'utf8'), before);
    await assert.rejects(f.editor.edit(f.entry, () => ({ value: 9 })), { code: 'DOMAIN_CLOSED' });
    release.resolve(); await locked; await first; await second; await shutdown;
    assert.equal(changed, true); assert.equal(secondChanged, true); assert.equal(closed, true);
    assert.match(await readFile(f.patchPath, 'utf8'), /value: 3/);
    assert.equal(f.ctx.snapshot().plugins.length, 0);
  } finally { release.resolve(); await locked; await f.dispose(); }
});

test('ConfigEditor without HMR retains admission and the lifecycle barrier', { timeout: 20000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture({ hmr: false, cleanup: async config => { if (config.value === 1) { entered.resolve(); await release.promise; } } });
  try {
    let done = false, nextChanged = false;
    const first = f.editor.edit(f.entry, () => ({ value: 2 })).then(() => { done = true; });
    await entered.promise;
    const second = f.editor.edit(f.entry, () => { nextChanged = true; return { value: 3 }; });
    await nextTurn(); assert.equal(done, false); assert.equal(nextChanged, false);
    release.resolve(); await first; await second;
    assert.equal(f.active.get('probe'), 3);
  } finally { release.resolve(); await f.dispose(); }
});

test('bundled Include.refresh rejoins after file read and waits for asynchronous inverse', { timeout: 20000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture({ cleanup: async config => { if (config.value === 1) { entered.resolve(); await release.promise; } } });
  try {
    // Root patches define probe; replace the file with an additional real row.
    f.tree.config.patches = [];
    await writeFile(f.configPath, JSON.stringify([{ id: 'probe', name: 'cordis:config-probe', config: { value: 4 } }]));
    let done = false;
    const refresh = f.tree.refresh().then(() => { done = true; });
    await entered.promise; await nextTurn(); assert.equal(done, false);
    release.resolve(); await refresh;
    assert.equal(f.active.get('probe'), 4);
  } finally { release.resolve(); await f.dispose(); }
});

test('ConfigEditor change callbacks cannot borrow the enclosing transaction after an await', { timeout: 20000 }, async () => {
  const cleanupEntered = Promise.withResolvers(), release = Promise.withResolvers(), attempted = Promise.withResolvers();
  const f = await fixture({ cleanup: async config => { if (config.value === 1) { cleanupEntered.resolve(); await release.promise; } } });
  try {
    let borrowed = false;
    const revision = f.editor.edit(f.entry, config => {
      void (async () => {
        await cleanupEntered.promise;
        attempted.resolve(await f.ctx.hmr.runExclusive(() => { borrowed = true; }).then(() => 'admitted', error => error.code));
      })();
      return { ...config, value: 2 };
    });
    assert.equal(await attempted.promise, 'REENTRANT_MUTATION');
    assert.equal(borrowed, false);
    release.resolve(); await revision;
    assert.equal(f.active.get('probe'), 2);
  } finally { release.resolve(); await f.dispose(); }
});

test('ConfigEditor rejected activation completes official file and runtime rollback before rejecting', { timeout: 20000 }, async () => {
  const f = await fixture({ setup: config => { if (config.value === 2) throw new Error('candidate activation rejected'); } });
  const before = await readFile(f.patchPath, 'utf8');
  try {
    await assert.rejects(f.editor.edit(f.entry, () => ({ value: 2 })), /candidate activation rejected|failed|inactive/i);
    assert.equal(await readFile(f.patchPath, 'utf8'), before);
    assert.equal(f.active.get('probe'), 1);
    await f.editor.edit(f.entry, () => ({ value: 3 }));
    assert.equal(f.active.get('probe'), 3);
  } finally { await f.dispose(); }
});

test('HMR config queue remains behind the domain queue before its callback can touch a file', { timeout: 20000 }, async () => {
  const f = await fixture(), release = Promise.withResolvers();
  try {
    const held = domainMutation(f.ctx, () => release.promise);
    let entered = false;
    const reload = f.ctx.hmr.runExclusive(async () => { entered = true; await f.tree.refresh(); });
    await nextTurn(); assert.equal(entered, false);
    release.resolve(); await held; await reload;
    assert.equal(entered, true);
  } finally { release.resolve(); await f.dispose(); }
});

test('an unobserved config path does not alter the live module cache', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const hmr = f.ctx.hmr, cache = new Map(hmr.internal.loadCache);
    hmr.stashed.add(pathToFileURL(f.configPath).href);
    await hmr.runExclusive(() => hmr.partialReload());
    assert.deepEqual(new Map(hmr.internal.loadCache), cache);
    assert.equal(f.active.get('probe'), 1);
  } finally { await f.dispose(); }
});

test('ConfigEditor surfaces a real rollback rename failure and does not report a committed revision', { timeout: 20000 }, async () => {
  const f = await fixture({ setup: async (config, { patchPath }) => {
    if (config.value !== 2) return;
    await rm(patchPath); await mkdir(patchPath);
    throw new Error('candidate failed with rollback destination unavailable');
  } });
  try {
    await assert.rejects(f.editor.edit(f.entry, () => ({ value: 2 })));
    await assert.rejects(readFile(f.patchPath, 'utf8'), { code: 'EISDIR' });
    assert.notEqual(f.active.get('probe'), 2);
    assert.notEqual(f.entry.fiber.state, 2);
  } finally { await f.dispose(); }
});

test('unconfirmed cleanup rejects the next ConfigEditor request before changing options or files', { timeout: 20000 }, async () => {
  let blocked = true;
  const f = await fixture({ cleanup: config => { if (blocked && config.value === 1) throw new Error('cleanup unconfirmed'); } });
  try {
    await assert.rejects(f.editor.edit(f.entry, () => ({ value: 2 })));
    const before = await readFile(f.patchPath, 'utf8');
    const options = structuredClone(f.entry.options);
    let changed = false;
    await assert.rejects(f.editor.edit(f.entry, () => { changed = true; return { value: 3 }; }), { code: 'CLEANUP_BLOCKED' });
    assert.equal(changed, false);
    assert.equal(await readFile(f.patchPath, 'utf8'), before);
    assert.deepEqual(f.entry.options, options);
    blocked = false;
    await f.entry.fiber.retryCleanup();
  } finally { blocked = false; await f.dispose(); }
});

test('an old bundled Include refresh handle is refused after domain shutdown', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.ctx.dispose();
    const before = await readFile(f.configPath, 'utf8');
    await assert.rejects(f.tree.refresh(), { code: 'STALE_LOADER' });
    assert.equal(await readFile(f.configPath, 'utf8'), before);
  } finally { await f.dispose(); }
});


test('packaged HostResolvedRootInclude uses the same transparent configuration barrier', { timeout: 20000 }, async () => {
  const f = await fixture({ hostResolved: true });
  try {
    assert.equal(f.tree.constructor.name, 'HostResolvedRootInclude');
    await f.editor.edit(f.entry, () => ({ value: 7 }));
    assert.equal(f.active.get('probe'), 7);
    assert.match(await readFile(f.patchPath, 'utf8'), /value: 7/);
  } finally { await f.dispose(); }
});

test('queued and retained ConfigEditor service handles are rejected after replacement', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.patchPath, 'utf8');
    const old = f.editor;
    const owner = old.ownerContext.fiber;
    const restarted = owner.restart();
    const queued = old.edit(f.entry, () => ({ value: 8 }));
    await restarted;
    await assert.rejects(queued, { code: 'STALE_OFFICIAL_SERVICE' });
    await assert.rejects(old.edit(f.entry, () => ({ value: 9 })), { code: 'STALE_OFFICIAL_SERVICE' });
    assert.equal(await readFile(f.patchPath, 'utf8'), before);
    await f.ctx.configEditor.edit(f.entry, () => ({ value: 4 }));
    assert.equal(f.active.get('probe'), 4);
  } finally { await f.dispose(); }
});

test('plugin setup cannot use transparent HMR or ConfigEditor APIs to acquire coordinator authority', { timeout: 20000 }, async () => {
  const attempts = [];
  const f = await fixture({ setup: async (config, { ctx }) => {
    if (config.value !== 2) return;
    const entry = ctx.loader.resolve('include:probe');
    attempts.push(await ctx.hmr.runExclusive(() => { throw new Error('unexpected HMR admission'); }).then(() => 'admitted', error => error.code));
    attempts.push(await ctx.configEditor.edit(entry, () => ({ value: 99 })).then(() => 'admitted', error => error.code));
  } });
  try {
    await f.editor.edit(f.entry, () => ({ value: 2 }));
    assert.deepEqual(attempts, ['REENTRANT_MUTATION', 'REENTRANT_MUTATION']);
    assert.equal(f.active.get('probe'), 2);
    assert.doesNotMatch(await readFile(f.patchPath, 'utf8'), /99/);
  } finally { await f.dispose(); }
});
