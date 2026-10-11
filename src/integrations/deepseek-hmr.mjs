import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire, registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FiberState, Service } from '@validation-engineering/cordis';
import { LoaderError } from '@validation-engineering/cordis-loader';

const require = createRequire(import.meta.url);
const observed = new Map(), hosts = new Set(), pending = new WeakMap();
const candidateScope = new AsyncLocalStorage();
const original = value => value?.[Symbol.for('cordis.original')] ?? value;
let installed = false, active, tail = Promise.resolve();
const file = url => typeof url === 'string' && url.startsWith('file:');
const native = url => file(url) && fileURLToPath(url).endsWith('.node');
const fail = (code, message, details, cause) => new LoaderError(code, message, details, cause);
const add = (graph, parent, child) => {
  if (!file(parent) || !file(child)) return;
  if (!graph.has(parent)) graph.set(parent, new Set());
  graph.get(parent).add(child);
};
const clone = graph => new Map([...graph].map(([key, values]) => [key, new Set(values)]));
function boundary(url) {
  const bootstrap = globalThis[Symbol.for('cordis-verus.compat-cordis.bootstrap.v1')];
  return url === bootstrap?.facade || url === bootstrap?.facade?.replace(/index\.js$/, 'index.cjs');
}

/** Install once before application imports, recording dynamic import/createRequire edges too. */
export function installModuleObservation(Hmr) {
  if (!installed) {
    installed = true;
    registerHooks({ resolve(specifier, context, next) {
      const result = next(specifier, context);
      const candidate = candidateScope.getStore();
      const ours = candidate && candidate === active && candidate.active;
      if (active && !ours && file(result.url)) {
        if (active.affected.has(result.url)) throw fail('OFFICIAL_HMR_MODULE_BUSY', 'An affected module is being replaced', { url: result.url });
        active.foreignURLs.add(result.url);
        active.foreignEdges.add(JSON.stringify([context.parentURL, result.url]));
      }
      if (ours && candidate.urls.has(context.parentURL) && file(result.url) && !boundary(result.url)) {
        if (native(result.url)) throw fail('OFFICIAL_HMR_NATIVE_ADDON', 'Native addons require a process restart', { url: result.url });
        candidate.urls.add(result.url);
        if (!observed.get(context.parentURL)?.has(result.url)) candidate.addedEdges.push([context.parentURL, result.url]);
      }
      add(observed, context.parentURL, result.url);
      return result;
    } });
  }
  Object.defineProperty(Hmr.prototype, 'lastReloadFailure', { configurable: true, get() { return pending.get(original(this))?.error; } });
  const init = Hmr.prototype[Service.init];
  if (typeof init !== 'function') return; // Contract-only fixtures have no runtime.
  Hmr.prototype[Service.init] = async function* () {
    hosts.add(this);
    yield () => { hosts.delete(this); };
    yield* Reflect.apply(init, this, []);
    // The official watcher only tests ESM loadCache.has(). Pure require() leaves
    // must also enter its existing stashed batch, before the debounce fires.
    const changed = path => {
      let filename = resolve(this.baseDir, path);
      try { filename = realpathSync(filename); } catch { /* deleted file */ }
      if (require.cache[filename]) this.stashed.add(pathToFileURL(filename).href);
    };
    this.watcher.on('change', changed);
    yield () => { this.watcher.off('change', changed); };
  };
}

async function graphOf(cache) {
  const graph = clone(observed);
  // Cache values differ across supported Node internals; use the official get
  // API for the job and retain raw Map values only for exact restoration.
  for (const url of cache.keys()) {
    const job = cache.get(url);
    if (!job?.module || !file(url)) continue;
    const children = await job.linked;
    for (const child of Array.from(children ?? [])) add(graph, url, child.url);
  }
  for (const module of Object.values(require.cache)) {
    if (!module?.filename) continue;
    for (const child of module.children ?? []) if (child.filename) add(graph,
      pathToFileURL(module.filename).href, pathToFileURL(child.filename).href);
  }
  return graph;
}
function closure(roots, graph) {
  const result = new Set(), queue = [...roots];
  for (const url of queue) {
    if (result.has(url) || boundary(url)) continue;
    result.add(url);
    queue.push(...graph.get(url) ?? []);
  }
  return result;
}
async function entriesOf(hmr) {
  const result = new Map();
  for (const entry of hmr.ownerContext.loader.entries()) {
    if (!entry.fiber || entry.fiber.uid === null || entry.options.name.startsWith('cordis:')) continue;
    const resolved = await hmr._resolve(entry.options.name, entry.parent.tree.ctx.baseUrl, {});
    if (!file(resolved?.url)) continue;
    const job = hmr.internal.loadCache.get(resolved.url);
    const plugin = hmr.ownerContext.loader.unwrapExports(job?.module?.getNamespace());
    if (!plugin) throw fail('OFFICIAL_HMR_GRAPH_UNAVAILABLE', 'A live entry has no evaluated module job', { url: resolved.url });
    result.set(resolved.url, { url: resolved.url, plugin, runtime: hmr.ownerContext.registry.get(plugin) });
  }
  return result;
}
async function plan(hmr, changed) {
  const cache = hmr.internal?.loadCache;
  try { Map.prototype.has.call(cache, ''); }
  catch { throw fail('OFFICIAL_HMR_GRAPH_UNAVAILABLE', 'Supported Node module internals are required'); }
  if (changed.some(url => boundary(url) || native(url))) throw fail('OFFICIAL_HMR_HOST_BOUNDARY', 'Native runtime and facade changes require a process restart');
  const graph = await graphOf(cache), entries = await entriesOf(hmr);
  const owned = closure(entries.keys(), graph), reverse = new Map();
  for (const [parent, children] of graph) for (const child of children) add(reverse, child, parent);
  const affected = closure(changed.filter(url => cache.has(url) || file(url) && require.cache[fileURLToPath(url)]), reverse);
  if (!affected.size) return { cache, graph, affected, generations: [] };
  const loaded = url => cache.has(url) || file(url) && !!require.cache[fileURLToPath(url)];
  for (const url of affected) {
    if (boundary(url) || hmr.externals?.has(url) || loaded(url) && !owned.has(url)) {
      throw fail('OFFICIAL_HMR_HOST_BOUNDARY', `A changed module is retained outside the configured plugin graph: ${url}`, { url });
    }
  }
  // Node caches are process-global. Another native domain retaining a factory
  // cannot silently inherit this domain's replacement.
  for (const host of hosts) if (host.ownerContext.fiber !== hmr.ownerContext.fiber && host.ownerContext.fiber.uid !== null) {
    const other = closure((await entriesOf(host)).keys(), graph);
    if ([...affected].some(url => other.has(url))) throw fail('OFFICIAL_HMR_HOST_BOUNDARY', 'Another application domain retains the changed module');
  }
  const generations = [...entries.values()].filter(entry => affected.has(entry.url));
  if (!generations.length) throw fail('OFFICIAL_HMR_HOST_BOUNDARY', 'Changed modules have no configured live plugin owner');
  const dependencies = closure(generations.map(entry => entry.url), graph);
  const addon = [...dependencies].find(native);
  if (addon) throw fail('OFFICIAL_HMR_NATIVE_ADDON', 'A plugin with native addon dependencies requires a process restart', { url: addon });
  const represented = new Set(generations.map(entry => entry.runtime?.callback));
  const all = new Set(generations.flatMap(entry => [...entry.runtime?.fibers ?? []]));
  const ownedByReplacement = fiber => {
    for (let parent = fiber.parent.fiber; parent && parent !== parent.parent.fiber; parent = parent.parent.fiber) if (all.has(parent)) return true;
    return false;
  };
  for (const url of affected) {
    const job = cache.get(url);
    let namespace;
    try { namespace = job?.module?.getNamespace() ?? (file(url) && require.cache[fileURLToPath(url)] ? { default: require.cache[fileURLToPath(url)].exports } : undefined); } catch { continue; }
    if (!namespace) continue;
    for (const value of Object.values(namespace)) {
      const runtime = hmr.ownerContext.registry.get(value);
      if (runtime?.fibers.length && !represented.has(runtime.callback) && ![...runtime.fibers].every(ownedByReplacement)) throw fail('OFFICIAL_HMR_HOST_BOUNDARY',
        'A loaded factory retained outside named Loader entries depends on the changed module', { url });
    }
  }
  for (let owner = hmr.ownerContext.fiber; owner; owner = owner === owner.parent.fiber ? undefined : owner.parent.fiber) {
    if (all.has(owner)) throw fail('OFFICIAL_HMR_HOST_BOUNDARY', 'HMR cannot replace its own lifecycle coordinator');
  }
  for (const generation of generations) generation.fibers = [...generation.runtime?.fibers ?? []].filter(fiber => {
    return !ownedByReplacement(fiber);
  }).map(fiber => ({ fiber, parent: fiber.parent, entry: fiber.entry?.fiber === fiber ? fiber.entry : undefined,
    parentGeneration: fiber.parent.fiber._generation, config: fiber.entry?.fiber === fiber ? fiber.entry.options.config : fiber._config }));
  return { cache, graph, affected: new Set([...affected].filter(loaded)), generations };
}

async function landAll(tasks, message) {
  const result = await Promise.allSettled(tasks), errors = result.filter(item => item.status === 'rejected').map(item => item.reason);
  if (errors.length) throw new AggregateError(errors, message);
}
function cacheJournal(cache, affected) {
  const esm = new Map(cache), cjs = new Map(Object.entries(require.cache));
  const edges = clone(observed);
  const children = new Map([...cjs.values()].map(module => [module, [...module.children ?? []]]));
  const urls = new Set(affected);
  const addedEdges = [], foreignURLs = new Set(), foreignEdges = new Set();
  return { urls, affected, addedEdges, foreignURLs, foreignEdges, active: true,
    release() {
      // Live timers/promises inherit candidateScope. Do not retain complete old
      // module caches through the successful generation's asynchronous work.
      this.active = false;
      esm.clear(); cjs.clear(); edges.clear(); children.clear();
      urls.clear(); addedEdges.length = 0; foreignURLs.clear(); foreignEdges.clear(); affected.clear();
    },
    invalidate() {
      for (const url of affected) {
        Map.prototype.delete.call(cache, url); observed.delete(url);
        if (file(url)) delete require.cache[fileURLToPath(url)];
      }
    },
    restore() {
      for (const url of urls) {
        if (affected.has(url) || !esm.has(url) && !foreignURLs.has(url)) {
          if (esm.has(url)) Map.prototype.set.call(cache, url, esm.get(url));
          else Map.prototype.delete.call(cache, url);
        }
        if (file(url)) {
          const path = fileURLToPath(url);
          if (affected.has(url) || !cjs.has(path) && !foreignURLs.has(url)) {
            if (cjs.has(path)) require.cache[path] = cjs.get(path);
            else delete require.cache[path];
          }
        }
        if (affected.has(url)) {
          if (edges.has(url)) observed.set(url, new Set(edges.get(url))); else observed.delete(url);
        }
      }
      for (const [parent, child] of addedEdges) {
        if (!edges.get(parent)?.has(child) && !foreignEdges.has(JSON.stringify([parent, child]))) observed.get(parent)?.delete(child);
      }
      for (const [module, prior] of children) {
        // Remove only this candidate's new child links; concurrent unrelated
        // imports and their cache identities remain untouched.
        module.children = [...prior, ...(module.children ?? []).filter(child => !prior.includes(child)
          && (!child.filename || !urls.has(pathToFileURL(child.filename).href) || foreignURLs.has(pathToFileURL(child.filename).href)))];
      }
    },
  };
}
async function activate(hmr, generations, restored, created) {
  for (const generation of generations) {
    const plugin = restored ? generation.plugin : generation.replacement;
    for (const record of generation.fibers) {
      if (record.parent.fiber.uid === null || record.parent.fiber._generation !== record.parentGeneration
        || record.entry && (record.entry.parent.tree.store[record.entry.options.id] !== record.entry || record.entry.options.config !== record.config)) throw fail('OFFICIAL_HMR_OWNER_REMOVED', 'Plugin owner disappeared during replacement');
      const fiber = record.parent.registry.plugin(plugin, record.config, hmr.getOuterStack).ctx.fiber;
      created.add(fiber);
      if (record.entry) { fiber.entry = record.entry; record.entry.fiber = fiber; }
    }
  }
  await landAll([...created].map(async fiber => {
    await fiber.await();
    if (fiber.state !== FiberState.ACTIVE) throw fail('OFFICIAL_HMR_NOT_ACTIVE', 'Replacement did not reach Active', { fiber: fiber.id, state: fiber.state });
  }), 'Plugin activation failed');
}

/** Caller already owns both the native domain coordinator and official HMR queue. */
export function reloadModules(hmr, steps, changed, retired) {
  const task = tail.then(() => performReload(hmr, steps, changed, retired));
  tail = task.catch(() => {});
  return task;
}
async function recover(hmr, steps, state, retired) {
  try {
    await landAll([...state.created].map(fiber => steps.dispose(fiber).then(() => { retired.add(fiber); })), 'Retained generation cleanup failed');
  } catch (cause) {
    state.error = fail('OFFICIAL_HMR_RECOVERY_BLOCKED', 'Retained cleanup remains unconfirmed; explicitly retry failed inverses first',
      { restored: false, cacheChanged: state.invalidated }, new AggregateError([state.cause, cause]));
    throw state.error;
  }
  if (state.invalidated) state.journal.restore();
  state.invalidated = false;
  // A later old-activation failure retains only factories/ownership recipes:
  // the cache itself has already been restored and no longer needs a backup.
  state.journal?.release();
  state.created = new Set();
  try { await activate(hmr, state.generations, true, state.created); }
  catch (cause) {
    state.error = fail('OFFICIAL_HMR_RESTORE_FAILED', 'Old cache restored but old activation failed',
      { restored: false, cacheChanged: false }, new AggregateError([state.cause, cause], 'Reload and restoration failed'));
    throw state.error;
  }
  pending.delete(original(hmr));
}
async function performReload(hmr, steps, changed, retired) {
  if (!steps.isCurrent()) throw fail('REENTRANT_MUTATION', 'Module replacement lost its coordinator');
  const retained = pending.get(original(hmr));
  if (retained) await recover(hmr, steps, retained, retired);
  const { cache, affected, generations } = await plan(hmr, changed);
  if (!generations.length) { for (const url of changed) hmr.stashed.delete(url); return; }
  const old = generations.flatMap(generation => generation.fibers.map(record => record.fiber));
  const created = new Set();
  try { await landAll(old.map(fiber => steps.dispose(fiber).then(() => { retired.add(fiber); })), 'Old plugin cleanup failed'); }
  catch (cause) {
    const error = fail('OFFICIAL_HMR_CLEANUP_FAILED', 'Old cleanup is unconfirmed; module caches were not changed', { cacheChanged: false, restored: false }, cause);
    pending.set(original(hmr), { generations, created: new Set(old), invalidated: false, cause, error });
    throw error;
  }
  // Old inverses may import modules. Their completed imports are part of the
  // pre-candidate baseline and must survive a later candidate failure.
  const journal = cacheJournal(cache, affected);
  journal.invalidate(); active = journal;
  return candidateScope.run(journal, async () => {
    try {
      for (const generation of generations) generation.replacement = hmr.ownerContext.loader.unwrapExports(
        await hmr.ownerContext.loader.import(generation.url, hmr.getOuterStack));
      const candidateGraph = await graphOf(cache);
      const addon = [...closure(generations.map(generation => generation.url), candidateGraph)].find(native);
      if (addon) throw fail('OFFICIAL_HMR_NATIVE_ADDON', 'Candidate contains a native addon dependency', { url: addon });
      await activate(hmr, generations, false, created);
    } catch (cause) {
      // Include roots created by a synchronous plugin() exception, which may not
      // have returned a handle. Their retained runtime remains observable.
      for (const generation of generations) if (generation.replacement) {
        for (const fiber of hmr.ownerContext.registry.get(generation.replacement)?.fibers ?? []) created.add(fiber);
      }
      const state = { generations, journal, created, invalidated: true, cause };
      pending.set(original(hmr), state);
      await recover(hmr, steps, state, retired);
      active = undefined;
      throw fail('OFFICIAL_HMR_RELOAD_FAILED', 'Candidate failed; old module identities and plugins were restored',
        { restored: true, cacheChanged: false }, cause);
    } finally { journal.active = false; active = undefined; }
    for (const url of changed) hmr.stashed.delete(url);
    hmr.accepted = new Set(affected);
    journal.release();
    hmr.ownerContext.emit('hmr/reload', new Map(generations.map(generation => [generation.plugin, { filename: generation.url, runtime: generation.runtime }])));
  });
}
