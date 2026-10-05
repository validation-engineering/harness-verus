import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  SessionPersistence, SessionPersistenceRevision, SessionAlreadyExistsError,
  SessionAlreadyOwnedError, SessionPersistenceNotFoundError, SessionHandleClosedError,
  SessionReadOnlyError, SessionOwnershipLostError, SessionPersistenceCorruptionError,
  assertVersion, assertStoredId, assertContiguous, materializeCreateHeader,
  materializeAppendBatch, validateStoredEvents,
} from '../../dist/upstream/plugins.mjs';

const FORMAT = 'cordis-harness.sessions/v1';
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const noop = () => {};
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function checkedId(id) {
  if (typeof id !== 'string' || !id.length || id.length > 1024) throw new TypeError('Invalid session id');
  return id;
}
function checkedHeader(header) {
  // Refuse a recognized newer version before interpreting this version's fields.
  if (header && Number.isSafeInteger(header.version) && header.version > 0) assertVersion(header);
  const result = materializeCreateHeader(header);
  checkedId(result.id); assertVersion(result);
  if (result.cwd !== undefined && (typeof result.cwd !== 'string' || !isAbsolute(result.cwd))) throw new TypeError('Session cwd must be absolute');
  if (typeof result.isSeeded !== 'boolean') throw new TypeError('Session isSeeded must be a boolean');
  if (result.parentSession !== undefined && typeof result.parentSession !== 'string') throw new TypeError('Session parentSession must be a string');
  if (result.origin !== undefined && result.origin !== 'subagent') throw new TypeError('Session origin must be subagent');
  if (result.delegationDepth !== undefined && (!Number.isSafeInteger(result.delegationDepth) || result.delegationDepth < 0)) throw new TypeError('Session delegationDepth must be a non-negative safe integer');
  if (result.agentPreset !== undefined && typeof result.agentPreset !== 'string') throw new TypeError('Session agentPreset must be a string');
  return freeze(result);
}
function checkedRecord(input, id, location) {
  if (input?.format !== FORMAT || !input.header) throw new Error('Unsupported local session container');
  const header = checkedHeader(input.header); assertStoredId(id, header);
  if (!Array.isArray(input.events)) throw new Error('Invalid local session events');
  const inherited = input.inheritedEventCount;
  if (!Number.isSafeInteger(inherited) || inherited < 0 || inherited > input.events.length || (!header.isSeeded && inherited !== 0)) throw new Error('Invalid inherited event count');
  const events = validateStoredEvents(header, input.events, { kind: 'cordis-harness-json', path: location });
  assertContiguous(id, events, 0);
  return freeze({ format: FORMAT, header, inheritedEventCount: inherited, events });
}

/** Small local backend. Atomic full snapshots; no migration or stale-lock recovery. */
export default class FileSessions extends SessionPersistence {
  static inject = ['sessions'];
  constructor(ctx, { root } = {}) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new TypeError('file-sessions root must be absolute');
    super(ctx);
    // Service methods execute through Cordis caller shadows. Bound closures keep
    // state private without relying on a private-field brand on those shadows.
    const store = new Store(resolve(root));
    for (const method of ['create', 'open', 'flush', 'stat', 'list']) this[method] = store[method].bind(store);
    ctx.on('session/event', (session, event) => store.route(session.id, event));
    ctx.effect(() => () => store.close());
  }
}

class Store {
  #root;
  #writers = new Map();
  #handles = new Set();
  #operations = new Set();
  #reservations = new Set();
  #accepting = true;
  #closeTask;
  constructor(root) { this.#root = root; }
  paths(id) {
    const stem = digest(checkedId(id));
    return { file: join(this.#root, stem + '.json'), lease: join(this.#root, stem + '.lock') };
  }
  check(signal) {
    signal?.throwIfAborted();
    if (!this.#accepting) throw new Error('Session persistence is closing');
  }
  track(operation) {
    this.#operations.add(operation);
    operation.then(() => this.#operations.delete(operation), () => this.#operations.delete(operation));
    return operation;
  }
  async load(id) {
    const { file } = this.paths(id);
    let bytes;
    try {
      if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error('Session file exceeds local 64 MiB limit');
      bytes = await readFile(file);
      if (bytes.length > MAX_FILE_BYTES) throw new Error('Session file exceeds local 64 MiB limit');
    } catch (error) {
      if (error.code === 'ENOENT') throw new SessionPersistenceNotFoundError(id);
      throw error;
    }
    try { return checkedRecord(JSON.parse(bytes.toString('utf8')), id, file); }
    catch (error) {
      if (error.name === 'SessionFormatUnsupportedError') throw error;
      throw new SessionPersistenceCorruptionError(`Session ${id} failed validation at ${file}`, { cause: error });
    }
  }
  async acquire(id) {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const { lease: directory } = this.paths(id);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw new SessionAlreadyOwnedError(id); throw error; }
    const lease = { id, directory, token: randomUUID(), initialized: false, lost: false };
    this.#reservations.add(lease);
    try {
      await writeFile(join(directory, 'owner.json'), JSON.stringify({ token: lease.token, pid: process.pid }), { flag: 'wx', mode: 0o600 });
      lease.initialized = true;
      return lease;
    } catch (error) {
      try { await this.release(lease); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Session lease initialization and rollback failed'); }
      throw error;
    }
  }
  async assertLease(lease) {
    if (lease.lost) throw new SessionOwnershipLostError(lease.id);
    try {
      const owner = JSON.parse(await readFile(join(lease.directory, 'owner.json'), 'utf8'));
      if (owner.token !== lease.token) throw new Error('lease owner changed');
    } catch {
      lease.lost = true;
      throw new SessionOwnershipLostError(lease.id);
    }
  }
  async release(lease) {
    if (lease.initialized) await this.assertLease(lease);
    await rm(lease.directory, { recursive: true });
    this.#reservations.delete(lease);
  }
  makeHandle(record, access, lease, materialized) {
    const handle = new FileHandle(this, record, access, lease, materialized);
    this.#handles.add(handle);
    if (access === 'write') {
      this.#writers.set(handle.id, handle);
      this.#reservations.delete(lease);
    }
    return handle;
  }
  async create(header, options = {}) {
    this.check(options.signal);
    const stored = checkedHeader(header);
    const inherited = options.inheritedEventCount ?? 0;
    if (!Number.isSafeInteger(inherited) || inherited < 0 || (!stored.isSeeded && inherited !== 0) || (stored.isSeeded && options.inheritedEventCount === undefined)) throw new TypeError('Invalid inherited event count');
    return this.track((async () => {
      const lease = await this.acquire(stored.id);
      try {
        this.check(options.signal);
        try { await stat(this.paths(stored.id).file); throw new SessionAlreadyExistsError(stored.id); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        this.check(options.signal);
        return this.makeHandle(freeze({ format: FORMAT, header: stored, inheritedEventCount: inherited, events: [] }), 'write', lease, false);
      } catch (error) {
        try { await this.release(lease); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Session creation and rollback failed'); }
        throw error;
      }
    })());
  }
  async open(id, access, options = {}) {
    this.check(options.signal); checkedId(id);
    if (!['read', 'write'].includes(access)) throw new TypeError('Invalid session access');
    return this.track((async () => {
      let lease;
      try {
        if (access === 'write') lease = await this.acquire(id);
        const record = await this.snapshot(id);
        this.check(options.signal);
        return this.makeHandle(record, access, lease, true);
      } catch (error) {
        if (lease) {
          try { await this.release(lease); }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'Session open and rollback failed'); }
        }
        throw error;
      }
    })());
  }
  async snapshot(id, reader) {
    const writer = this.#writers.get(id);
    return writer ? writer.snapshot(reader) : this.load(id);
  }
  route(id, event) { this.#writers.get(id)?.route(event); }
  async flush() {
    this.check();
    const writers = [...this.#writers.values()];
    return this.track((async () => {
      const results = await Promise.allSettled(writers.map(handle => handle.barrier()));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Session flush failed');
    })());
  }
  async stat(id, options = {}) {
    this.check(options.signal); checkedId(id);
    return this.track((async () => {
      let record;
      try { record = await this.snapshot(id); }
      catch (error) { if (error instanceof SessionPersistenceNotFoundError) return undefined; throw error; }
      options.signal?.throwIfAborted();
      const bytes = JSON.stringify(record);
      return { header: clone(record.header), revision: SessionPersistenceRevision(digest(bytes)), eventCount: record.events.length, sizeBytes: Buffer.byteLength(bytes) };
    })());
  }
  async list(options = {}) {
    this.check(options.signal);
    return this.track((async () => {
      let names;
      try { names = await readdir(this.#root); }
      catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
      const ids = new Set(this.#writers.keys());
      for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        options.signal?.throwIfAborted();
        const file = join(this.#root, name);
        if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error('Session file exceeds local 64 MiB limit');
        const data = JSON.parse(await readFile(file, 'utf8'));
        if (this.paths(data.header?.id).file !== file) throw new Error('Session storage filename does not match identity');
        ids.add(data.header.id);
      }
      // Do not reopen service admission after a concurrent close: this read was
      // already admitted and teardown joins it through the enclosing operation.
      const snapshots = [];
      for (const id of ids) {
        options.signal?.throwIfAborted();
        let record;
        try { record = await this.snapshot(id); }
        catch (error) { if (error instanceof SessionPersistenceNotFoundError) continue; throw error; }
        const bytes = JSON.stringify(record);
        snapshots.push({ header: clone(record.header), revision: SessionPersistenceRevision(digest(bytes)), eventCount: record.events.length, sizeBytes: Buffer.byteLength(bytes) });
      }
      return snapshots;
    })());
  }
  async persist(handle, record, lease) {
    await this.assertLease(lease);
    handle.assertRoutedSuccess();
    if (record.inheritedEventCount > record.events.length) throw new Error('Inherited session prefix has not been appended');
    const encoded = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) throw new Error('Session exceeds local 64 MiB limit');
    const { file } = this.paths(handle.id);
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      const output = await open(temp, 'wx', 0o600);
      try { await output.writeFile(encoded); await output.sync(); }
      finally { await output.close(); }
      await this.assertLease(lease);
      handle.assertRoutedSuccess();
      await rename(temp, file);
      const directory = await open(this.#root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      handle.assertRoutedSuccess();
    } finally { await rm(temp, { force: true }); }
  }
  closed(handle) {
    if (this.#writers.get(handle.id) === handle) this.#writers.delete(handle.id);
    this.#handles.delete(handle);
  }
  close() {
    if (this.#closeTask) return this.#closeTask;
    this.#accepting = false;
    this.#closeTask = (async () => {
      // All admitted acquisition/read/barrier operations settle before taking
      // the final handle set. A failed acquisition retains its rollback lease.
      await Promise.allSettled([...this.#operations]);
      const results = await Promise.allSettled([
        ...[...this.#handles].map(handle => handle.close()),
        ...[...this.#reservations].map(lease => this.release(lease)),
      ]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Session storage cleanup failed');
    })().catch(error => { this.#closeTask = undefined; throw error; });
    return this.#closeTask;
  }
}

class FileHandle {
  #store;
  #record;
  #lease;
  #materialized;
  #pending = Promise.resolve();
  #closing = false;
  #closed = false;
  #closeTask;
  #routedFailure;
  constructor(store, record, access, lease, materialized) {
    this.#store = store; this.#record = record; this.#lease = lease; this.#materialized = materialized;
    this.id = record.header.id; this.header = freeze(clone(record.header));
    this.inheritedEventCount = record.inheritedEventCount; this.access = access;
    Object.freeze(this);
  }
  #check(operation, write, signal) {
    signal?.throwIfAborted();
    if (this.#closing || this.#closed) throw new SessionHandleClosedError(this.id, operation);
    if (write && this.access !== 'write') throw new SessionReadOnlyError(this.id, operation);
  }
  #queue(fn, routed = false) {
    const task = this.#pending.then(async () => {
      try { return await fn(); }
      catch (error) {
        // Latch at the original rejection, before any waiting barrier advances.
        if (routed) this.#routedFailure ??= error;
        throw error;
      }
    });
    this.#pending = task.then(noop, noop);
    return task;
  }
  assertRoutedSuccess() { if (this.#routedFailure) throw this.#routedFailure; }
  async snapshot(reader) {
    if (reader !== this) await this.#pending;
    this.assertRoutedSuccess();
    return this.#record;
  }
  async read(offset = 0, length, options = {}) {
    this.#check('read', false, options.signal);
    if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) throw new TypeError('Invalid session read range');
    return this.#queue(async () => {
      const record = await this.#store.snapshot(this.id, this);
      options.signal?.throwIfAborted();
      if (!isDeepStrictEqual(record.header, this.#record.header)
        || record.events.length < this.#record.events.length
        || !isDeepStrictEqual(record.events.slice(0, this.#record.events.length), this.#record.events)) {
        throw new SessionPersistenceCorruptionError('Session history was replaced or moved backwards', {});
      }
      this.#record = record;
      return { eventState: 'detached', events: clone(record.events.slice(offset, length === undefined ? undefined : offset + length)) };
    });
  }
  #append(events, options, routed) {
    this.#check('append', true, options.signal);
    const batch = materializeAppendBatch(events);
    return this.#queue(async () => {
      options.signal?.throwIfAborted(); this.assertRoutedSuccess();
      await this.#store.assertLease(this.#lease);
      validateStoredEvents(this.#record.header, batch, { kind: 'cordis-harness-json', path: this.#store.paths(this.id).file });
      assertContiguous(this.id, batch, this.#record.events.length);
      const next = freeze({ ...this.#record, events: [...this.#record.events, ...batch] });
      if (Buffer.byteLength(JSON.stringify(next)) + 1 > MAX_FILE_BYTES) throw new Error('Session exceeds local 64 MiB limit');
      this.#record = next;
    }, routed);
  }
  async append(events, options = {}) { return this.#append(events, options, false); }
  route(event) {
    try { void this.#append([event], {}, true).catch(noop); }
    catch (error) { this.#routedFailure ??= error; }
  }
  async flush(options = {}) {
    this.#check('flush', true, options.signal);
    return this.#queue(async () => {
      options.signal?.throwIfAborted(); this.assertRoutedSuccess();
      await this.#store.persist(this, this.#record, this.#lease);
      this.#materialized = true;
    });
  }
  barrier() { return this.#closing ? this.close() : this.flush(); }
  close() {
    if (this.#closed) return this.#closeTask;
    if (this.#closeTask) return this.#closeTask;
    this.#closing = true;
    this.#closeTask = this.#queue(async () => {
      this.assertRoutedSuccess();
      if (this.access === 'write') {
        if (this.#materialized || this.#record.events.length) {
          await this.#store.persist(this, this.#record, this.#lease);
          this.#materialized = true;
        }
        await this.#store.release(this.#lease);
      }
      this.#store.closed(this); this.#closed = true;
    }).catch(error => { this.#closeTask = undefined; throw error; });
    return this.#closeTask;
  }
  [Symbol.asyncDispose]() { return this.close(); }
}
