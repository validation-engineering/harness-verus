import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { setImmediate as turn } from 'node:timers/promises';

if (!process.execArgv.some(arg => arg === '--import' || arg.startsWith('--import='))) await import('../../scripts/official-register.mjs');
const { Context, domainMutation } = await import('@deepseek-ai/cordis');
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { default: Timer } = await import('@deepseek-ai/cordis-plugin-timer');
const { default: Hmr } = await import('@deepseek-ai/dsh-hmr');
const require = createRequire(import.meta.url);

async function fixture(mode = 'esm', options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cordis-in-place-hmr-')));
  const ctx = new Context(), key = directory;
  const state = globalThis[key] = { events: [], live: new Map(), cleanup: undefined, setup: undefined };
  const url = name => pathToFileURL(join(directory, name)).href;
  const write = (name, source) => writeFile(join(directory, name), source);
  const body = label => `async (ctx) => { const s = globalThis[${JSON.stringify(key)}]; s.events.push(['setup', '${label}', version]);
    ctx.effect(() => async () => { s.events.push(['cleanup', '${label}', version]); await s.cleanup?.(version, '${label}', ctx); s.live.delete('${label}'); });
    await s.setup?.(version, '${label}', ctx); s.live.set('${label}', { version, ctx }); }`;
  const plugin = mode === 'cjs' ? 'plugin.cjs' : 'plugin.mjs';
  const leaf = mode === 'esm' || mode === 'dynamic' ? 'leaf.mjs' : 'leaf.cjs';
  const leafSource = version => leaf.endsWith('.cjs') ? `exports.version = ${version};` : `export const version = ${version};`;
  try {
    await write(leaf, leafSource(1));
    if (mode === 'cjs') {
      await write('middle.cjs', "module.exports = require('./leaf.cjs');");
      await write(plugin, `const {version}=require('./middle.cjs'); module.exports=${body('probe')};`);
    } else if (mode === 'require') {
      await write(plugin, `import {createRequire} from 'node:module'; const {version}=createRequire(import.meta.url)('./leaf.cjs'); export default ${body('probe')};`);
    } else if (mode === 'dynamic') {
      await write(plugin, `const {version}=await import('./leaf.mjs'); export default ${body('probe')};`);
    } else {
      await write('middle.mjs', "export {version} from './leaf.mjs';");
      await write(plugin, `import {version} from './middle.mjs'; export default ${body('probe')};`);
    }
    await write('unrelated.mjs', `const version=100; export default ${body('unrelated')};`);
    await options.prepare?.({ write, url, body, directory, plugin, leaf, state });
    ctx.baseUrl = pathToFileURL(directory + '/').href;
    await ctx.plugin(Loader); await ctx.plugin(Timer); await ctx.plugin(Hmr, { root: options.watch ? ['.'] : [], base: '.', ignored: [], debounce: 5 });
    const hmr = ctx.hmr;
    await hmr.runExclusive(async () => {
      await ctx.loader.create({ id: 'probe', name: url(plugin) });
      await ctx.loader.create({ id: 'unrelated', name: url('unrelated.mjs') });
      for (const name of options.entries ?? []) await ctx.loader.create({ id: name, name: url(name) });
    });
    assert.equal(state.live.get('probe').version, 1);
    return { ctx, hmr, state, url, write, plugin, leaf, directory, leafSource,
      async reload(version) { await write(leaf, leafSource(version)); hmr.stashed.add(url(leaf)); return hmr.partialReload(); },
      async dispose() {
        state.cleanup = undefined; state.setup = undefined;
        for (const fiber of [...ctx.fiber._domain.fibers.values()]) if (fiber._cleanupFailure()) await fiber.retryCleanup().catch(() => {});
        try { await ctx.dispose(); } finally { delete globalThis[key]; await rm(directory, { recursive: true, force: true }); }
      } };
  } catch (error) { await ctx.dispose().catch(() => {}); delete globalThis[key]; await rm(directory, { recursive: true, force: true }); throw error; }
}
const raw = (f, name) => Map.prototype.get.call(f.hmr.internal.loadCache, f.url(name));

for (const mode of ['esm', 'cjs', 'require', 'dynamic']) test(`real official in-place HMR replaces ${mode} transitive modules and preserves unrelated identity`, { timeout: 20000 }, async () => {
  const f = await fixture(mode);
  try {
    const before = raw(f, f.plugin), unrelated = f.ctx.loader.resolve('unrelated').fiber, unrelatedModule = raw(f, 'unrelated.mjs');
    const root = f.ctx.fiber, domain = root._domain;
    await f.reload(2);
    assert.equal(f.state.live.get('probe').version, 2);
    assert.equal(f.ctx.fiber, root); assert.equal(f.ctx.fiber._domain, domain);
    assert.notEqual(raw(f, f.plugin), before);
    assert.equal(raw(f, 'unrelated.mjs'), unrelatedModule);
    assert.equal(f.ctx.loader.resolve('unrelated').fiber, unrelated);
    assert.deepEqual(f.state.events.filter(row => row[1] === 'probe'), [['setup','probe',1],['cleanup','probe',1],['setup','probe',2]]);
  } finally { await f.dispose(); }
});

test('old inverse must finish before any candidate module evaluates, while shutdown queues behind reload', { timeout: 20000 }, async () => {
  const f = await fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  try {
    const old = raw(f, f.plugin);
    f.state.cleanup = async version => { if (version === 1) { entered.resolve(); await release.promise; } };
    const reload = f.reload(2); await entered.promise;
    let closed = false; const shutdown = f.ctx.dispose().then(() => { closed = true; });
    await turn(); assert.equal(raw(f, f.plugin), old); assert.equal(closed, false);
    assert.equal(f.state.events.some(row => row[0] === 'setup' && row[2] === 2), false);
    await assert.rejects(f.hmr.partialReload(), { code: 'DOMAIN_CLOSED' });
    release.resolve(); await reload; await shutdown;
    assert.equal(f.ctx.snapshot().plugins.length, 0);
    await assert.rejects(f.hmr.partialReload(), { code: 'STALE_OFFICIAL_SERVICE' });
  } finally { release.resolve(); await f.dispose(); }
});

test('cleanup failure retains the native barrier and leaves all module caches unchanged', { timeout: 20000 }, async () => {
  const f = await fixture('cjs');
  try {
    const esm = new Map(f.hmr.internal.loadCache), cjs = new Map(Object.entries(require.cache));
    f.state.cleanup = version => { if (version === 1) throw new Error('old inverse rejected'); };
    await assert.rejects(f.reload(2), error => error.code === 'OFFICIAL_HMR_CLEANUP_FAILED' && error.details.cacheChanged === false);
    assert.deepEqual(new Map(f.hmr.internal.loadCache), esm);
    assert.deepEqual(new Map(Object.entries(require.cache)), cjs);
    assert.equal(f.state.events.some(row => row[0] === 'setup' && row[2] === 2), false);
    assert.ok(f.ctx.snapshot().plugins.some(row => row.cleanupFailed));
    await assert.rejects(f.hmr.partialReload(), { code: 'CLEANUP_BLOCKED' });
  } finally { await f.dispose(); }
});

test('a syntax error restores exact old ESM and CJS identities and supports a later successful reload', { timeout: 20000 }, async () => {
  for (const mode of ['esm', 'cjs']) {
    const f = await fixture(mode);
    try {
      const plugin = raw(f, f.plugin), oldCjs = require.cache[join(f.directory, f.leaf)];
      await f.write(f.leaf, 'this is invalid module syntax !!!'); f.hmr.stashed.add(f.url(f.leaf));
      await assert.rejects(f.hmr.partialReload(), error => error.code === 'OFFICIAL_HMR_RELOAD_FAILED' && error.details.restored === true);
      assert.equal(raw(f, f.plugin), plugin); assert.equal(require.cache[join(f.directory, f.leaf)], oldCjs);
      assert.equal(f.state.live.get('probe').version, 1);
      await f.reload(3); assert.equal(f.state.live.get('probe').version, 3);
    } finally { await f.dispose(); }
  }
});

test('candidate setup failure cleans its effects before restoring the old factory', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const old = raw(f, f.plugin);
    f.state.setup = version => { if (version === 2) throw new Error('candidate setup failed'); };
    await assert.rejects(f.reload(2), error => error.code === 'OFFICIAL_HMR_RELOAD_FAILED' && error.details.restored);
    assert.equal(raw(f, f.plugin), old); assert.equal(f.state.live.get('probe').version, 1);
    assert.deepEqual(f.state.events.filter(row => row[1] === 'probe'), [['setup','probe',1],['cleanup','probe',1],['setup','probe',2],['cleanup','probe',2],['setup','probe',1]]);
  } finally { await f.dispose(); }
});

test('candidate inverse and old restoration failures are reported without claiming recovery', { timeout: 20000 }, async () => {
  for (const blocked of [true, false]) {
    const f = await fixture();
    try {
      const old = raw(f, f.plugin);
      f.state.setup = version => { if (version === 2 || !blocked) throw new Error('activation rejected'); };
      f.state.cleanup = version => { if (blocked && version === 2) throw new Error('candidate inverse rejected'); };
      await assert.rejects(f.reload(2), error => error.code === (blocked ? 'OFFICIAL_HMR_RECOVERY_BLOCKED' : 'OFFICIAL_HMR_RESTORE_FAILED') && error.details.restored === false);
      assert.equal(raw(f, f.plugin) === old, !blocked);
      assert.equal(f.state.live.has('probe'), false);
      if (blocked) assert.ok(f.ctx.snapshot().plugins.some(row => row.cleanupFailed));
    } finally { await f.dispose(); }
  }
});

test('native addon and external owner boundaries reject before retiring an old plugin', { timeout: 20000 }, async () => {
  const f = await fixture('require');
  try {
    const old = f.ctx.loader.resolve('probe').fiber;
    f.hmr.externals.add(f.url(f.leaf));
    await assert.rejects(f.reload(2), { code: 'OFFICIAL_HMR_HOST_BOUNDARY' });
    assert.equal(f.ctx.loader.resolve('probe').fiber, old);
    assert.equal(f.state.live.get('probe').version, 1);
  } finally { await f.dispose(); }
});

test('domain admission precedes HMR planning and plugin setup cannot reenter it', { timeout: 20000 }, async () => {
  const f = await fixture(), release = Promise.withResolvers();
  try {
    const hold = domainMutation(f.ctx, () => release.promise);
    let done = false; const reload = f.reload(2).then(() => { done = true; });
    await turn(); assert.equal(done, false); assert.equal(f.state.live.get('probe').version, 1);
    f.state.setup = async version => { if (version === 2) await assert.rejects(f.hmr.partialReload(), { code: 'REENTRANT_MUTATION' }); };
    release.resolve(); await hold; await reload;
    assert.equal(f.state.live.get('probe').version, 2);
  } finally { release.resolve(); await f.dispose(); }
});

for (const phase of ['old', 'candidate', 'restore']) test(`retained ${phase} failure resumes its journal after explicit cleanup recovery`, { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    f.state.setup = version => { if (phase !== 'old' && (version === 2 || phase === 'restore')) throw new Error('setup rejected'); };
    f.state.cleanup = version => { if (phase === 'old' && version === 1 || phase === 'candidate' && version === 2) throw new Error('inverse rejected'); };
    await assert.rejects(f.reload(2));
    assert.ok(f.hmr.lastReloadFailure);
    f.state.setup = undefined; f.state.cleanup = undefined;
    const failed = new Set(f.ctx.snapshot().plugins.filter(row => row.cleanupFailed).map(row => String(row.id)));
    for (const fiber of [...f.ctx.fiber._domain.fibers.values()]) if (failed.has(String(fiber.id))) await fiber.retryCleanup();
    await f.reload(3);
    assert.equal(f.state.live.get('probe').version, 3);
    assert.equal(f.hmr.lastReloadFailure, undefined);
    assert.equal(f.ctx.snapshot().plugins.some(row => row.cleanupFailed), false);
    const setups = f.state.events.filter(row => row[0] === 'setup' && row[1] === 'probe').map(row => row[2]);
    assert.equal(setups.at(-2), 1, 'retained old factory is restored before the fresh candidate');
  } finally { await f.dispose(); }
});

test('shared dependencies reload all configured dependents in one root and keep other entries', { timeout: 20000 }, async () => {
  const f = await fixture('esm', { entries: ['second.mjs'], prepare: async ({write, body}) => {
    await write('second.mjs', `import {version} from './leaf.mjs'; export default ${body('second')};`);
  } });
  try {
    await f.reload(2);
    assert.equal(f.state.live.get('probe').version, 2); assert.equal(f.state.live.get('second').version, 2);
    const events = f.state.events.filter(row => row[1] !== 'unrelated');
    const firstNew = events.findIndex(row => row[0] === 'setup' && row[2] === 2);
    assert.equal(events.slice(0, firstNew).filter(row => row[0] === 'cleanup').length, 2);
  } finally { await f.dispose(); }
});

test('rollback preserves concurrent dynamic imports from the same unchanged shared utility', { timeout: 20000 }, async () => {
  const f = await fixture('esm', { prepare: async ({write, body}) => {
    await write('shared.mjs', 'export const load = name => import(name);');
    await write('plugin.mjs', `import './shared.mjs'; import {version} from './middle.mjs'; export default ${body('probe')};`);
    await write('foreign.mjs', 'export const identity = {};');
    await write('candidate-new.mjs', 'export const identity = {};');
  } });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  try {
    const shared = f.hmr.internal.loadCache.get(f.url('shared.mjs')).module.getNamespace();
    f.state.setup = async version => { if (version === 2) {
      await shared.load('./candidate-new.mjs'); entered.resolve(); await release.promise; throw new Error('candidate fails after concurrent import');
    } };
    const reload = f.reload(2); const rejected = assert.rejects(reload, error => error.details?.restored === true);
    await entered.promise;
    const foreign = await shared.load('./foreign.mjs'), foreignJob = raw(f, 'foreign.mjs');
    await assert.rejects(import(f.url(f.plugin)), { code: 'OFFICIAL_HMR_MODULE_BUSY' });
    release.resolve(); await rejected;
    assert.equal(raw(f, 'foreign.mjs'), foreignJob);
    assert.equal((await shared.load('./foreign.mjs')).identity, foreign.identity);
    assert.equal(f.hmr.internal.loadCache.has(f.url('candidate-new.mjs')), false);
    f.state.setup = undefined;
    await f.reload(3); assert.equal(f.state.live.get('probe').version, 3);
  } finally { release.resolve(); await f.dispose(); }
});

test('native addon dependency is detected before old teardown and candidate additions are refused before dlopen', { timeout: 20000 }, async () => {
  // The runtime artifact is a real local native binary. Loading it as an
  // application dependency does not receive the facade's trusted-host exemption.
  const addon = new URL('../../node_modules/@validation-engineering/cordis/native/cordis.node', import.meta.url).pathname;
  const f = await fixture('cjs', { prepare: async ({write, body}) => {
    await write('plugin.cjs', `require(${JSON.stringify(addon)}); const {version}=require('./leaf.cjs'); module.exports=${body('probe')};`);
  } });
  try {
    const old = raw(f, f.plugin), fiber = f.ctx.loader.resolve('probe').fiber;
    await assert.rejects(f.reload(2), { code: 'OFFICIAL_HMR_NATIVE_ADDON' });
    assert.equal(raw(f, f.plugin), old); assert.equal(f.ctx.loader.resolve('probe').fiber, fiber);
  } finally { await f.dispose(); }
  const candidate = await fixture('cjs');
  try {
    await candidate.write(candidate.leaf, `require(${JSON.stringify(addon)}); exports.version=2;`);
    candidate.hmr.stashed.add(candidate.url(candidate.leaf));
    await assert.rejects(candidate.hmr.partialReload(), error => error.code === 'OFFICIAL_HMR_RELOAD_FAILED' && error.details.restored);
    assert.equal(candidate.state.live.get('probe').version, 1);
  } finally { await candidate.dispose(); }
});

test('a non-entry named factory retaining a changed module is rejected before cache mutation', { timeout: 20000 }, async () => {
  const f = await fixture('esm', { prepare: async ({write, body}) => {
    await write('plugin.mjs', `import {version} from './middle.mjs'; export const extra=${body('extra')}; export default ${body('probe')};`);
  } });
  try {
    const namespace = f.hmr.internal.loadCache.get(f.url(f.plugin)).module.getNamespace();
    const extra = await f.ctx.plugin(namespace.extra), old = raw(f, f.plugin);
    await assert.rejects(f.reload(2), { code: 'OFFICIAL_HMR_HOST_BOUNDARY' });
    assert.equal(raw(f, f.plugin), old); assert.equal(extra.uid === null, false);
  } finally { await f.dispose(); }
});

test('real official watcher reloads a require-only leaf through its existing debounce queue', { timeout: 20000 }, async () => {
  const f = await fixture('cjs', { watch: true });
  try {
    const reloaded = Promise.withResolvers();
    const off = f.ctx.on('hmr/reload', () => reloaded.resolve());
    const timeout = setTimeout(() => reloaded.reject(new Error('official watcher did not reload CJS leaf')), 10000);
    try {
      await f.write(f.leaf, f.leafSource(2)); await reloaded.promise;
      assert.equal(f.state.live.get('probe').version, 2);
    } finally { clearTimeout(timeout); off(); }
  } finally { await f.dispose(); }
});

test('restarting HMR removes its old inventory entry and rejects retained service handles', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const old = f.hmr;
    await old.ownerContext.fiber.restart();
    await assert.rejects(old.partialReload(), { code: 'STALE_OFFICIAL_SERVICE' });
    f.hmr = f.ctx.hmr;
    await f.write(f.leaf, f.leafSource(2)); f.hmr.stashed.add(f.url(f.leaf));
    await f.hmr.partialReload(); assert.equal(f.state.live.get('probe').version, 2);
  } finally { await f.dispose(); }
});

test('an affected parent rebuilds its module child once, with cleanup before either new setup', { timeout: 20000 }, async () => {
  const f = await fixture('esm', { prepare: async ({write, body}) => {
    await write('child.mjs', `import {version} from './leaf.mjs'; export default ${body('child')};`);
    await write('plugin.mjs', `import child from './child.mjs'; import {version} from './middle.mjs'; const apply=${body('probe')}; export default async ctx => { await apply(ctx); await ctx.plugin(child); };`);
  } });
  try {
    const oldChild = f.state.live.get('child').ctx.fiber;
    await f.reload(2);
    assert.equal(f.state.live.get('probe').version, 2); assert.equal(f.state.live.get('child').version, 2);
    assert.equal(oldChild._removedFlag, true);
    assert.equal(f.state.events.filter(row => row[0] === 'setup' && row[1] === 'child' && row[2] === 2).length, 1);
    const events = f.state.events.filter(row => row[1] !== 'unrelated');
    assert.equal(events.slice(0, events.findIndex(row => row[0] === 'setup' && row[2] === 2)).filter(row => row[0] === 'cleanup').length, 2);
  } finally { await f.dispose(); }
});

test('all direct instances of a configured factory join its replacement generation', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const factory = f.hmr.internal.loadCache.get(f.url(f.plugin)).module.getNamespace().default;
    const direct = await f.ctx.plugin(factory);
    const configured = f.ctx.loader.resolve('probe').fiber;
    await f.reload(2);
    assert.equal(direct._removedFlag, true); assert.equal(configured._removedFlag, true);
    const replacement = f.hmr.internal.loadCache.get(f.url(f.plugin)).module.getNamespace().default;
    assert.equal(f.ctx.registry.get(replacement).fibers.length, 2);
    assert.equal(f.ctx.registry.get(factory), undefined);
  } finally { await f.dispose(); }
});

test('candidate rollback preserves imports completed by the old asynchronous inverse', { timeout: 20000 }, async () => {
  const f = await fixture('esm', { prepare: async ({write, body}) => {
    await write('shared.mjs', 'export const load = name => import(name);');
    await write('plugin.mjs', `import './shared.mjs'; import {version} from './middle.mjs'; export default ${body('probe')};`);
    await write('cleanup-import.mjs', 'export const identity = {};');
  } });
  try {
    const shared = f.hmr.internal.loadCache.get(f.url('shared.mjs')).module.getNamespace();
    let cleanupIdentity, cleanupJob;
    f.state.cleanup = async version => { if (version === 1) {
      cleanupIdentity = (await shared.load('./cleanup-import.mjs')).identity;
      cleanupJob = raw(f, 'cleanup-import.mjs');
    } };
    f.state.setup = async version => { if (version === 2) {
      await shared.load('./cleanup-import.mjs'); throw new Error('candidate failed');
    } };
    await assert.rejects(f.reload(2), error => error.details?.restored === true);
    assert.equal(raw(f, 'cleanup-import.mjs'), cleanupJob);
    assert.equal((await shared.load('./cleanup-import.mjs')).identity, cleanupIdentity);
    assert.equal(f.state.live.get('probe').version, 1);
  } finally { await f.dispose(); }
});
