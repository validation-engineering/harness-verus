import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Context } from '@validation-engineering/cordis-compat-deepseek';
import { SessionStore, SessionId } from '../dist/upstream/plugins.mjs';
import FileSessions from '../src/plugins/file-sessions.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const fileFor = (root, id) => path.join(root, createHash('sha256').update(id).digest('hex') + '.json');
async function directory(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cordis-file-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function setup(t, root) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  const fiber = await ctx.plugin(FileSessions, { root });
  t.after(() => ctx.fiber.dispose());
  return { ctx, fiber, store: ctx.sessionPersistence };
}
function fixture(ctx, raw = 'session') {
  const session = ctx.sessions.create(SessionId(raw));
  const events = [
    session.append('turn/start', { turn: 1 }),
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  return { session, header: session.header, events };
}

test('official storage interface creates, appends, flushes and exposes fresh detached reads', async t => {
  const root = await directory(t);
  const { ctx, store } = await setup(t, root);
  const { header, events } = fixture(ctx);
  const handle = await store.create(header);
  assert(Object.isFrozen(handle.header));
  assert.equal(handle.record, undefined);
  assert.throws(() => { handle.header.id = 'changed'; }, TypeError);
  assert.equal((await store.stat(header.id)).eventCount, 0);
  const reader = await store.open(header.id, 'read');
  await handle.append([events[0]]);
  assert.equal((await reader.read()).events.length, 1);
  const detached = await reader.read(); detached.events[0].data.turn = 99;
  assert.equal((await handle.read()).events[0].data.turn, 1);
  await handle.append([events[1]]);
  await store.flush();
  assert.equal((await reader.read(1)).events[0].type, 'turn/end');
  assert.equal((await reader.read(100)).events.length, 0);
  assert.equal((await store.list())[0].eventCount, 2);
  const disk = JSON.parse(await readFile(fileFor(root, header.id), 'utf8'));
  assert.deepEqual(disk.events, events);
  await assert.rejects(reader.append([]), { name: 'SessionReadOnlyError' });
  await assert.rejects(reader.flush(), { name: 'SessionReadOnlyError' });
  await Promise.all([handle.close(), reader.close()]);
  await assert.rejects(handle.read(), { name: 'SessionHandleClosedError' });
  await assert.rejects(handle.append([]), { name: 'SessionHandleClosedError' });
  await handle.close();
});

test('independent runtime instances obey one writer lease and see flushed snapshots', async t => {
  const root = await directory(t);
  const first = await setup(t, root);
  const second = await setup(t, root);
  const { header, events } = fixture(first.ctx, 'shared');
  const writer = await first.store.create(header);
  await assert.rejects(second.store.create(header), { name: 'SessionAlreadyOwnedError' });
  await assert.rejects(second.store.open(header.id, 'write'), { name: 'SessionAlreadyOwnedError' });
  await writer.append(events); await writer.flush();
  const reader = await second.store.open(header.id, 'read');
  assert.deepEqual((await reader.read()).events, events);
  await writer.close();
  await assert.rejects(second.store.create(header), { name: 'SessionAlreadyExistsError' });
  const reopened = await second.store.open(header.id, 'write');
  assert.deepEqual((await reopened.read()).events, events);
  await Promise.all([reader.close(), reopened.close()]);
});

test('invalid sequence is rejected without changing the previously accepted prefix', async t => {
  const root = await directory(t); const { ctx, store } = await setup(t, root);
  const { header, events } = fixture(ctx); const handle = await store.create(header);
  await assert.rejects(handle.append([events[1]]), /append seq mismatch/);
  assert.deepEqual((await handle.read()).events, []);
  await handle.append(events); await handle.flush();
  await assert.rejects(handle.append([events[0]]), /append seq mismatch/);
  assert.deepEqual((await handle.read()).events, events);
  await handle.close();
});

test('empty unflushed create disappears on close, while flush materializes it', async t => {
  const root = await directory(t); const { ctx, store } = await setup(t, root);
  const { header } = fixture(ctx, 'empty');
  await (await store.create(header)).close();
  assert.equal(await store.stat(header.id), undefined);
  const durable = await store.create(header); await durable.flush(); await durable.close();
  assert.equal((await store.stat(header.id)).eventCount, 0);
});

test('store flush joins a concurrently closing writer', async t => {
  const root = await directory(t); const { ctx, store } = await setup(t, root);
  const { header, events } = fixture(ctx); const handle = await store.create(header);
  await handle.append(events);
  const close = handle.close();
  await Promise.all([close, store.flush()]);
  assert.equal((await store.stat(header.id)).eventCount, 2);
  assert(!(await readdir(root)).some(name => name.endsWith('.lock')));
});

test('teardown joins an in-flight creation and releases its acquired lease', async t => {
  const root = await directory(t); const { ctx, store, fiber } = await setup(t, root);
  const { header } = fixture(ctx);
  const creating = store.create(header);
  const closing = fiber.dispose();
  const [created, closed] = await Promise.allSettled([creating, closing]);
  assert.equal(closed.status, 'fulfilled');
  if (created.status === 'fulfilled') await assert.rejects(created.value.append([]), { name: 'SessionHandleClosedError' });
  else assert.match(created.reason.message, /closing/);
  assert(!(await readdir(root)).some(name => name.endsWith('.lock')));
});

test('cancellation while acquiring a writer never leaves a lease', async t => {
  const root = await directory(t); const { ctx, store } = await setup(t, root);
  const { header } = fixture(ctx); const abort = new AbortController();
  const opening = store.create(header, { signal: abort.signal });
  abort.abort(new Error('cancel acquisition'));
  await assert.rejects(opening, /cancel acquisition/);
  assert(!(await readdir(root)).some(name => name.endsWith('.lock')));
});

test('malformed headers, disk corruption and future formats fail closed', async t => {
  const root = await directory(t); const { ctx, store } = await setup(t, root);
  const { header, events } = fixture(ctx);
  for (const changed of [{ isSeeded: 'yes' }, { origin: 'invalid' }, { delegationDepth: -1 }, { parentSession: 42 }, { agentPreset: false }]) {
    await assert.rejects(store.create({ ...header, ...changed }), TypeError);
  }
  const handle = await store.create(header); await handle.append(events); await handle.close();
  const file = fileFor(root, header.id); const original = await readFile(file, 'utf8');
  const future = JSON.parse(original); future.header.version = 999;
  await writeFile(file, JSON.stringify(future));
  await assert.rejects(store.open(header.id, 'read'), { name: 'SessionFormatUnsupportedError' });
  await writeFile(file, JSON.stringify({ format: 'cordis-harness.sessions/v1', header: { id: header.id, version: 999 }, futureBody: [] }));
  await assert.rejects(store.open(header.id, 'read'), { name: 'SessionFormatUnsupportedError' });
  const corrupt = JSON.parse(original); corrupt.header.isSeeded = 'yes';
  await writeFile(file, JSON.stringify(corrupt));
  await assert.rejects(store.open(header.id, 'read'), { name: 'SessionPersistenceCorruptionError' });
  await writeFile(file, '{');
  await assert.rejects(store.open(header.id, 'read'), { name: 'SessionPersistenceCorruptionError' });
  await writeFile(file, original);
});

test('a real rename failure retains write ownership and retry closes only after durability', async t => {
  const root = await directory(t); const { ctx, store } = await setup(t, root);
  const { header, events } = fixture(ctx); const handle = await store.create(header);
  await handle.append(events);
  const file = fileFor(root, header.id); await mkdir(file);
  try {
    await assert.rejects(handle.flush());
    await assert.rejects(handle.close());
    assert((await readdir(root)).some(name => name.endsWith('.lock')));
    await assert.rejects(store.open(header.id, 'write'), { name: 'SessionAlreadyOwnedError' });
    await assert.rejects(handle.append([]), { name: 'SessionHandleClosedError' });
  } finally {
    await rm(file, { recursive: true, force: true });
    await handle.close();
  }
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).events, events);
  assert(!(await readdir(root)).some(name => name.endsWith('.lock')));
});

test('live routing is visible to an immediately queued durability barrier', async t => {
  const root = await directory(t); const { ctx, store } = await setup(t, root);
  const session = ctx.sessions.create(SessionId('live'));
  const handle = await store.create(session.header);
  session.append('turn/start', { turn: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await store.flush();
  assert.deepEqual(JSON.parse(await readFile(fileFor(root, session.id), 'utf8')).events, session.snapshotEvents());
  await handle.close();
});

test('routed append failure rejects immediate flush and every close attempt without releasing ownership', async t => {
  const root = await directory(t);
  // The failed lifecycle deliberately cannot claim quiescent disposal. Isolate
  // that retained domain; process exit is not presented as successful cleanup.
  const source = `
    import assert from 'node:assert/strict';
    import {readdir} from 'node:fs/promises';
    import {Context} from '@validation-engineering/cordis-compat-deepseek';
    import {SessionStore,SessionId} from './dist/upstream/plugins.mjs';
    import FileSessions from './src/plugins/file-sessions.mjs';
    const ctx=new Context();await ctx.plugin(SessionStore);await ctx.plugin(FileSessions,{root:process.argv[1]});
    const session=ctx.sessions.create(SessionId('failed-live'));
    const handle=await ctx.sessionPersistence.create(session.header);
    session.append('test/unknown-required',{value:1});
    await assert.rejects(ctx.sessionPersistence.flush(),/Session flush failed/);
    await assert.rejects(handle.close(),/unknown to this harness/);
    await assert.rejects(handle.close(),/unknown to this harness/);
    assert((await readdir(process.argv[1])).some(name=>name.endsWith('.lock')));
    console.log(JSON.stringify({flushRejected:true,closeRejected:true,leaseRetained:true}));
    process.exit(0);
  `;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', '@validation-engineering/cordis-compat-deepseek/register', '--input-type=module', '-e', source, root,
  ], { cwd: project, timeout: 15000 });
  assert.deepEqual(JSON.parse(stdout), { flushRejected: true, closeRejected: true, leaseRetained: true });
});


test('a read handle refuses a replaced or older disk history', async t => {
  const root = await directory(t); const { ctx, store } = await setup(t, root);
  const { header, events } = fixture(ctx); const handle = await store.create(header);
  await handle.append(events); await handle.close();
  const reader = await store.open(header.id, 'read');
  assert.equal((await reader.read()).events.length, 2);
  const file = fileFor(root, header.id); const original = await readFile(file, 'utf8');
  const older = JSON.parse(original); older.events.pop();
  try {
    await writeFile(file, JSON.stringify(older));
    await assert.rejects(reader.read(), { name: 'SessionPersistenceCorruptionError' });
  } finally { await writeFile(file, original); await reader.close(); }
});

test('lost lease ownership remains lost and close cannot remove another owner', async t => {
  const root = await directory(t);
  const source = `
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import {readFile,writeFile,readdir} from 'node:fs/promises';
    import path from 'node:path';
    import {Context} from '@validation-engineering/cordis-compat-deepseek';
    import {SessionStore,SessionId} from './dist/upstream/plugins.mjs';
    import FileSessions from './src/plugins/file-sessions.mjs';
    const root=process.argv[1],ctx=new Context();await ctx.plugin(SessionStore);await ctx.plugin(FileSessions,{root});
    const session=ctx.sessions.create(SessionId('ownership'));
    const handle=await ctx.sessionPersistence.create(session.header);
    const owner=path.join(root,createHash('sha256').update(session.id).digest('hex')+'.lock','owner.json');
    const original=await readFile(owner,'utf8');
    await writeFile(owner,JSON.stringify({token:'replacement-owner'}));
    await assert.rejects(handle.flush(),{name:'SessionOwnershipLostError'});
    await assert.rejects(handle.close(),{name:'SessionOwnershipLostError'});
    assert.equal(JSON.parse(await readFile(owner,'utf8')).token,'replacement-owner');
    await writeFile(owner,original);
    await assert.rejects(handle.close(),{name:'SessionOwnershipLostError'});
    assert((await readdir(root)).some(name=>name.endsWith('.lock')));
    console.log('ownership-retained-with-failure');process.exit(0);
  `;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', '@validation-engineering/cordis-compat-deepseek/register', '--input-type=module', '-e', source, root,
  ], { cwd: project, timeout: 15000 });
  assert.equal(stdout.trim(), 'ownership-retained-with-failure');
});
