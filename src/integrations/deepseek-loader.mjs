import { AsyncLocalStorage } from 'node:async_hooks';
import { FiberState, assertDomainMutation, domainMutation } from '@validation-engineering/cordis';
import { LoaderError } from '@validation-engineering/cordis-loader';
import { installModuleObservation, reloadModules } from './deepseek-hmr.mjs';

const methods = ['entries', 'getTasks', 'await', 'resolve', 'resolveGroup', 'create', 'update', 'remove', 'write'];
const incompatible = message => new LoaderError('INCOMPATIBLE_OFFICIAL_LOADER', message);
const thenable = value => value && typeof value.then === 'function';

// This deliberately recognizes the pinned Harness Loader/Include contract. It
// does not turn an arbitrary EntryTree subclass into a durable configuration API.
function canonicalTree(tree) {
  // Cordis exposes services through context-bound tracing proxies. EntryGroup
  // retains the actual tree, so use that identity without changing its methods.
  const original = tree?.root?.tree;
  if (original && original !== tree && original.store === tree.store) return original;
  return tree;
}

function isInclude(tree) {
  return tree?.constructor?.name === 'Include' || tree?.constructor?.name === 'HostResolvedRootInclude'
    && Object.getPrototypeOf(tree.constructor.prototype)?.constructor?.name === 'Include';
}

function inspectTree(tree, domain, allowRetired = false) {
  if (!tree || typeof tree !== 'object' || !tree.ctx?.fiber?._domain) throw incompatible('Expected an official Harness Loader or Include tree');
  if (tree.ctx.fiber._domain !== domain) throw new LoaderError('FOREIGN_DOMAIN', 'Loader tree belongs to another execution domain');
  if (!(tree.constructor?.name === 'Loader' || isInclude(tree))
    || methods.some(name => typeof tree[name] !== 'function')
    || tree.root?.tree !== tree || !Array.isArray(tree.root.data) || !tree.store || typeof tree.store !== 'object') {
    throw incompatible('Unsupported official Loader tree contract');
  }
  if (!allowRetired && (tree.ctx.fiber.uid === null || tree.ctx.fiber._removedFlag
    || [FiberState.DISPOSED, FiberState.UNLOADING].includes(tree.ctx.fiber.state))) {
    throw new LoaderError('STALE_LOADER', 'The official tree owner has been disposed or is unloading');
  }
  const include = isInclude(tree);
  if (include && (typeof tree.filename !== 'string' || typeof tree.flushWrite !== 'function'
    || typeof tree._writeFile !== 'function' || typeof tree.readonly !== 'boolean' || !thenable(tree.writeQueue)
    || !Object.hasOwn(tree, 'pendingWrite') || !Object.hasOwn(tree, 'writeTask'))) {
    throw incompatible('Include requires the pinned pendingWrite/flushWrite/writeQueue persistence contract');
  }
  return include;
}

function optionsCopy(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Loader options must be an object');
  // The official methods mutate their options. Give each queued revision its own
  // copy, including undefined values used by Entry.update to delete fields.
  return structuredClone(options);
}

/** Explicit transactions around the unchanged, pinned Harness EntryTree API. */
export class LoaderTransactions {
  constructor(ctx, tree) {
    const domain = ctx?.fiber?._domain;
    if (!domain || domain.profile !== 'harness') throw incompatible('LoaderTransactions requires a native Harness-profile Context');
    tree = canonicalTree(tree);
    inspectTree(tree, domain);
    this.ctx = ctx;
    this.tree = tree;
    this.revision = 0;
    this.requestedRevision = 0;
    this.lastFailure = undefined;
    this.closed = false;
    this._accepting = true;
    this._domain = domain;
    this._ownerGeneration = tree.ctx.fiber._generation;
    this._contract = new Map(methods.map(name => [name, tree[name]]));
  }

  create(options, parent = null, position = Infinity) {
    return this._submit('create', () => [optionsCopy(options), parent, position]);
  }
  update(id, options, parent, position) {
    return this._submit('update', () => [id, optionsCopy(options), parent, position]);
  }
  remove(id) { return this._submit('remove', () => [id]); }

  _check() {
    inspectTree(this.tree, this._domain);
    if (this.tree.ctx.fiber._generation !== this._ownerGeneration) throw new LoaderError('STALE_LOADER', 'The official tree belongs to a previous owner activation');
    for (const [name, original] of this._contract) {
      if (this.tree[name] !== original) throw incompatible(`Official tree method ${name} changed after adapter creation`);
    }
  }

  _invoke(operation, args) {
    if (operation !== 'remove') return Reflect.apply(this._contract.get(operation), this.tree, args);
    const entry = this.tree.resolve(args[0]);
    const owner = canonicalTree(entry?.parent?.tree);
    inspectTree(owner, this._domain);
    const id = entry.options?.id;
    if (typeof id !== 'string' || owner.store[id] !== entry) throw incompatible('Entry removal requires its original containing tree and local id');
    // The pinned root remove() forwards a qualified id into a local store. Use
    // the same official method on the owning tree with its actual local id.
    return owner.remove(id);
  }

  _submit(operation, prepare) {
    let args, request;
    try {
      assertDomainMutation(this.ctx);
      if (!this._accepting) throw new LoaderError('LOADER_CLOSED', 'Loader transaction adapter is closing or closed');
      this._check();
      args = prepare();
      request = ++this.requestedRevision;
    } catch (error) { return Promise.reject(error); }
    const task = domainMutation(this.ctx, async steps => {
      this._check();
      return this._run(steps, () => this._invoke(operation, args));
    });
    return task.then(value => {
      this.revision++;
      this.lastFailure = undefined;
      return value;
    }, error => {
      this.lastFailure = { revision: request, operation, error };
      throw error;
    });
  }

  async _run(steps, invoke, closing = false) {
    const trees = new Set(), fibers = new Set(), hooks = new Map();
    const writes = new Map(), failures = [], writeFailures = [];
    const remember = error => { if (!failures.includes(error)) failures.push(error); };
    const observe = (tree, promise, prior = false) => {
      if (!thenable(promise)) throw incompatible('Include.flushWrite must return its persistence promise');
      if (!writes.has(promise)) writes.set(promise, Promise.resolve(promise).catch(error => { writeFailures.push({ tree, error, promise, prior }); }));
      return promise;
    };
    const hook = tree => {
      if (hooks.has(tree)) return;
      const descriptor = Object.getOwnPropertyDescriptor(tree, 'flushWrite');
      if (descriptor && (!('value' in descriptor) || !descriptor.configurable)) throw incompatible('Include.flushWrite cannot be observed safely');
      const original = tree.flushWrite;
      const wrapped = function (...args) {
        try { return observe(tree, Reflect.apply(original, this, args)); }
        catch (error) { writeFailures.push({ tree, error }); throw error; }
      };
      Object.defineProperty(tree, 'flushWrite', { value: wrapped, configurable: true, writable: true });
      hooks.set(tree, { descriptor, wrapped });
      observe(tree, tree.writeQueue, true);
    };
    const visit = source => {
      const tree = canonicalTree(source);
      const include = inspectTree(tree, this._domain, trees.has(tree));
      trees.add(tree);
      if (include) hook(tree);
      for (const entry of Object.values(tree.store)) {
        if (entry.fiber) {
          if (entry.fiber._domain !== this._domain) throw new LoaderError('FOREIGN_DOMAIN', 'Entry fiber belongs to another execution domain');
          fibers.add(entry.fiber);
        }
        if (entry.subtree && !scanned.has(entry.subtree)) { scanned.add(entry.subtree); visit(entry.subtree); }
      }
    };
    let scanned;
    const discover = () => {
      scanned = new Set();
      for (const tree of [this.tree, canonicalTree(this.tree.ctx.loader)]) {
        if (tree && !scanned.has(tree)) { scanned.add(tree); visit(tree); }
      }
    };
    const flush = () => {
      for (const tree of hooks.keys()) {
        try { observe(tree, tree.flushWrite()); } catch (error) { remember(error); }
      }
    };
    const drainWrites = async () => {
      // Timers and stop() may have added another queued write while an earlier
      // filesystem operation was pending. Keep the slot until all observed runs
      // have landed, including failures followed by a successful retry.
      while (true) {
        flush();
        const count = writes.size;
        await Promise.all(writes.values());
        if (writes.size === count && [...hooks.keys()].every(tree => tree.pendingWrite === undefined && tree.writeTask === undefined)) break;
      }
    };
    let listener, value;
    try {
      discover();
      // Include emits this before scheduling its timer. Discover newly created
      // Include subtrees in time to observe their first ordinary write as well.
      if (!closing) listener = this.ctx.on('loader/config-update', discover, { global: true });
      let result;
      try { result = steps.capture(invoke); } catch (error) { remember(error); }
      // Flush the synchronous revision before yielding: a following revision
      // cannot overtake this write even if plugin cleanup is asynchronous.
      try { discover(); } catch (error) { remember(error); }
      flush();
      try { value = await result; } catch (error) { remember(error); }
      try { discover(); } catch (error) { remember(error); }
      for (const tree of trees) {
        try { await tree.await(); } catch (error) { remember(error); }
      }
      try { await this.ctx.settle(); } catch (error) { remember(error); }
      try { discover(); } catch (error) { remember(error); }
      for (const fiber of fibers) {
        // HMR explicitly joined this disposal; a removed prior generation's
        // historical setup error must not poison a successful recovery.
        if (fiber._removedFlag && scoped(this.ctx)?.retired.has(fiber)) continue;
        try { await fiber.await(); } catch (error) { remember(error); }
      }
    } catch (error) { remember(error); }
    finally {
      try { await drainWrites(); } catch (error) { remember(error); }
      try { listener?.(); } catch (error) { remember(error); }
      for (const [tree, { descriptor, wrapped }] of hooks) {
        try {
          if (tree.flushWrite !== wrapped) throw incompatible('Include.flushWrite changed during a transaction');
          if (descriptor) Object.defineProperty(tree, 'flushWrite', descriptor);
          else delete tree.flushWrite;
        } catch (error) { remember(error); }
      }
    }
    // The previous revision may have left a rejected queue. Include explicitly
    // retries through that rejection when a new write is scheduled. A successful
    // new write recovers that historical failure, but never hides a failure of
    // any write started during this revision.
    const persistenceFailures = writeFailures.filter(({ tree, promise, prior }) => !prior || tree.writeQueue === promise);
    if (persistenceFailures.length) {
      const errors = [...new Set([...failures, ...persistenceFailures.map(({ error }) => error)])];
      throw new LoaderError('OFFICIAL_PERSISTENCE_FAILED', 'Official Include persistence failed; in-memory changes have not been rolled back',
        { files: [...new Set(persistenceFailures.map(({ tree }) => tree.filename))] }, new AggregateError(errors, 'Loader revision and persistence errors'));
    }
    if (failures.length > 1 && failures[0] instanceof LoaderError && failures[0].code.startsWith('OFFICIAL_HMR_')) {
      const first = failures[0];
      throw new LoaderError(first.code, first.message, first.details, new AggregateError(failures, 'HMR revision and lifecycle errors'));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Official Loader revision failed');
    return value;
  }

  /** Stop admission and wait for earlier revisions; does not dispose the tree. */
  close() {
    try { assertDomainMutation(this.ctx, { recovery: true }); }
    catch (error) { return Promise.reject(error); }
    if (this._closeTask) return this._closeTask;
    this._accepting = false;
    const task = domainMutation(this.ctx, async steps => {
      this._check();
      await this._run(steps, () => undefined, true);
      this.closed = true;
    }, { recovery: true }).catch(error => { this._closeTask = undefined; throw error; });
    this._closeTask = task;
    return task;
  }
}


// The scope carries no authority by itself. Every bridge checks the runtime's
// exact coordinator origin again, including after official asynchronous I/O.
const officialScope = new AsyncLocalStorage();
const installedContracts = new WeakMap();
const refreshedTrees = new WeakMap();

function scoped(ctx) {
  const scope = officialScope.getStore();
  if (!scope?.steps.isCurrent()) return;
  if (ctx?.fiber?._domain !== scope.domain) throw new LoaderError('FOREIGN_DOMAIN', 'Official operation crossed execution domains');
  return scope;
}

function serviceCheck(service, name) {
  const ctx = service.ownerContext;
  const fiber = ctx?.fiber;
  const original = value => value?.[Symbol.for('cordis.original')] ?? value;
  if (!fiber || fiber.uid === null || fiber._removedFlag || fiber.state !== FiberState.ACTIVE
    || original(ctx.get(name)) !== original(service)) {
    throw new LoaderError('STALE_OFFICIAL_SERVICE', `Official ${name} belongs to an inactive or replaced service`);
  }
  return ctx;
}

function coordinate(ctx, execute) {
  try { assertDomainMutation(ctx); }
  catch (error) { return Promise.reject(error); }
  return domainMutation(ctx, steps => {
    const adapter = new LoaderTransactions(ctx.root, canonicalTree(ctx.loader));
    return officialScope.run({ domain: ctx.fiber._domain, steps, retired: new Set() }, () => adapter._run(steps, execute));
  });
}

/** Compose official host operations and application readiness checks in one
 * domain revision. Managed callbacks cannot borrow this transaction's authority.
 */
export function officialTransaction(ctx, execute) {
  if (typeof execute !== 'function') return Promise.reject(new TypeError('officialTransaction requires a callback'));
  return coordinate(ctx, execute);
}

function installRefresh(tree) {
  if (!isInclude(tree) || refreshedTrees.has(tree)) return;
  const original = tree.refresh;
  if (typeof original !== 'function') throw incompatible('Official Include.refresh is unavailable');
  const owner = tree.ctx.fiber, generation = owner._generation;
  const check = () => {
    if (owner.uid === null || owner._removedFlag || owner._generation !== generation
      || [FiberState.DISPOSED, FiberState.UNLOADING].includes(owner.state)) {
      throw new LoaderError('STALE_LOADER', 'Cannot refresh an Include from a previous owner activation');
    }
  };
  const wrapped = function (...args) {
    const invoke = () => { check(); return Reflect.apply(original, this, args); };
    try {
      check();
      return scoped(tree.ctx) ? invoke() : coordinate(tree.ctx.root, invoke);
    } catch (error) { return Promise.reject(error); }
  };
  Object.defineProperty(tree, 'refresh', { value: wrapped, configurable: true, writable: true });
  refreshedTrees.set(tree, { original, wrapped });
}

/**
 * Install host-only bridges on the pinned official classes before mounting the
 * application. Official methods, filesystem locks, rollback, watcher dispatch
 * and config semantics still execute unchanged. The domain queue is outermost.
 */
export function installOfficialTransactions({ Entry, EntryGroup, EntryTree, Hmr, ConfigEditor }) {
  const classes = [Entry, EntryGroup, EntryTree, Hmr, ConfigEditor];
  if (classes.some(value => typeof value !== 'function' || !value.prototype)) throw incompatible('All five pinned official classes are required');
  const previous = classes.map(value => installedContracts.get(value)).find(Boolean);
  if (previous) {
    if (classes.some((value, index) => value !== previous[index])) throw incompatible('Official transaction installation changed class identities');
    return;
  }
  const contracts = [
    [Entry.prototype, ['update'], entry => entry.ctx],
    [EntryGroup.prototype, ['update', 'create', 'remove', 'stop'], group => group.ctx],
    [EntryTree.prototype, ['create', 'update', 'remove'], tree => tree.ctx],
  ];
  for (const [prototype, names] of contracts) for (const name of names) {
    if (typeof prototype[name] !== 'function') throw incompatible(`Official Loader contract lacks ${name}`);
  }
  if (typeof Hmr.prototype.runExclusive !== 'function' || typeof ConfigEditor.prototype.edit !== 'function') {
    throw incompatible('Official HMR/ConfigEditor transaction entrypoints are unavailable');
  }
  for (const [prototype, names, context] of contracts) for (const name of names) {
    const original = prototype[name];
    prototype[name] = function (...args) {
      installRefresh(this.tree ?? this.parent?.tree ?? this);
      const scope = scoped(context(this));
      return scope ? scope.steps.capture(() => Reflect.apply(original, this, args)) : Reflect.apply(original, this, args);
    };
  }
  const exclusive = Hmr.prototype.runExclusive;
  Hmr.prototype.runExclusive = function (operation) {
    try {
      const ctx = serviceCheck(this, 'hmr');
      const generation = ctx.fiber._generation;
      const invoke = () => {
        serviceCheck(this, 'hmr');
        if (ctx.fiber._generation !== generation) throw new LoaderError('STALE_OFFICIAL_SERVICE', 'HMR changed while its operation was queued');
        return Reflect.apply(exclusive, this, [operation]);
      };
      return scoped(ctx) ? invoke() : coordinate(ctx.root, invoke);
    } catch (error) { return Promise.reject(error); }
  };
  installModuleObservation(Hmr);
  Hmr.prototype.partialReload = function () {
    try {
      const ctx = serviceCheck(this, 'hmr');
      const changed = [...this.stashed];
      const execute = () => {
        const scope = scoped(ctx);
        if (!scope) throw incompatible('HMR escaped its admitted transaction');
        return reloadModules(this, scope.steps, changed, scope.retired);
      };
      return scoped(ctx) ? execute() : this.runExclusive(execute);
    } catch (error) { return Promise.reject(error); }
  };
  const edit = ConfigEditor.prototype.edit;
  ConfigEditor.prototype.edit = function (entry, change) {
    try {
      const ctx = serviceCheck(this, 'configEditor');
      const generation = ctx.fiber._generation;
      if (typeof change !== 'function') throw new TypeError('ConfigEditor.edit requires a change callback');
      const invoke = () => {
        serviceCheck(this, 'configEditor');
        if (ctx.fiber._generation !== generation) throw new LoaderError('STALE_OFFICIAL_SERVICE', 'ConfigEditor changed while its edit was queued');
        return Reflect.apply(edit, this, [entry, (...args) => {
          const scope = scoped(ctx);
          if (!scope) throw incompatible('ConfigEditor callback escaped its admitted transaction');
          return scope.steps.observe(entry.fiber, () => change(...args));
        }]);
      };
      return scoped(ctx) ? invoke() : coordinate(ctx.root, invoke);
    } catch (error) { return Promise.reject(error); }
  };
  for (const value of classes) installedContracts.set(value, classes);
}
