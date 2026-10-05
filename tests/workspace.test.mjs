import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context } from '@cordis-verus/compat-harness';
import { ToolRuntime, SystemPrompt } from '../dist/upstream/plugins.mjs';
import * as workspacePlugin from '../src/plugins/workspace.mjs';
import { createWorkspace } from '../src/plugins/workspace.mjs';
import * as hello from '../plugins/hello.mjs';

async function fixture(t, config = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'cordis-harness-workspace-'));
  const root = path.join(parent, 'workspace');
  await mkdir(root);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const workspace = await createWorkspace({ root, ...config });
  t.after(() => workspace.close());
  return { parent, root, workspace };
}

test('workspace config rejects missing roots and ambiguous limits or write authorization', async t => {
  const { root } = await fixture(t);
  await assert.rejects(createWorkspace(), /root is required/);
  await assert.rejects(createWorkspace({ root, allowWrite: 'yes' }), /must be a boolean/);
  await assert.rejects(createWorkspace({ root, maxReadBytes: 3 }), /maxReadBytes/);
  await assert.rejects(createWorkspace({ root, maxWriteBytes: -1 }), /maxWriteBytes/);
});

test('list has stable order and explicit entry pagination', async t => {
  const { root, workspace } = await fixture(t);
  await Promise.all(['c.txt', 'a.txt', 'b.txt'].map(name => writeFile(path.join(root, name), name)));
  const first = await workspace.list({ path: '.', limit: 2 });
  assert.deepEqual(first, { path: '.', total: 3, next: 2, entries: [
    { name: 'a.txt', type: 'file' }, { name: 'b.txt', type: 'file' },
  ] });
  const last = await workspace.list({ offset: first.next, limit: 2 });
  assert.deepEqual(last.entries, [{ name: 'c.txt', type: 'file' }]);
  assert.equal(last.next, null);
  await assert.rejects(workspace.list({ offset: 4 }), /offset/);
});

test('list bounds payload bytes and returns a continuation rather than dropping entries', async t => {
  const { root, workspace } = await fixture(t, { maxReadBytes: 80 });
  await Promise.all(['alpha.txt', 'beta.txt', 'gamma.txt'].map(name => writeFile(path.join(root, name), '')));
  let next = 0;
  const names = [];
  do {
    const page = await workspace.list({ offset: next });
    assert.ok(page.entries.reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)), 0) <= 80);
    names.push(...page.entries.map(entry => entry.name));
    next = page.next;
  } while (next !== null);
  assert.deepEqual(names, ['alpha.txt', 'beta.txt', 'gamma.txt']);
});

test('UTF-8 pagination preserves every character including BOM and line endings', async t => {
  const { root, workspace } = await fixture(t, { maxReadBytes: 5 });
  const source = '\ufeffA你好😀\r\nend';
  await writeFile(path.join(root, 'text.txt'), source);
  let next = 0;
  const pages = [];
  do {
    const page = await workspace.read({ path: './text.txt', offset: next });
    assert.equal(page.total, Buffer.byteLength(source));
    assert.equal(page.path, 'text.txt');
    assert.equal(page.offset, next);
    assert.ok(Buffer.byteLength(page.content) <= 5);
    if (page.next !== null) assert.equal(page.next, next + Buffer.byteLength(page.content));
    pages.push(page.content);
    next = page.next;
  } while (next !== null);
  assert.equal(pages.join(''), source);
});

test('empty and exact-end pages return null continuation', async t => {
  const { root, workspace } = await fixture(t);
  await writeFile(path.join(root, 'empty.txt'), '');
  assert.deepEqual(await workspace.read({ path: 'empty.txt' }), {
    path: 'empty.txt', total: 0, offset: 0, next: null, content: '',
  });
  await writeFile(path.join(root, 'four.txt'), 'four');
  assert.equal((await workspace.read({ path: 'four.txt', offset: 4 })).next, null);
});

test('malformed UTF-8, binary NUL and mid-character offsets fail explicitly', async t => {
  const { root, workspace } = await fixture(t, { maxReadBytes: 4 });
  await writeFile(path.join(root, 'bad.txt'), Buffer.from([0xff, 0x61]));
  await writeFile(path.join(root, 'nul.txt'), 'a\0b');
  await writeFile(path.join(root, 'cut.txt'), Buffer.from([0xe4, 0xbd]));
  await writeFile(path.join(root, 'unicode.txt'), '你好吗');
  await assert.rejects(workspace.read({ path: 'bad.txt' }), /UTF-8/);
  await assert.rejects(workspace.read({ path: 'cut.txt' }), /UTF-8/);
  await assert.rejects(workspace.read({ path: 'nul.txt' }), /NUL/);
  await assert.rejects(workspace.read({ path: 'unicode.txt', offset: 1 }), /UTF-8/);
  await assert.rejects(workspace.read({ path: 'unicode.txt', offset: 10 }), /offset/);
  await assert.rejects(workspace.read({ path: 'unicode.txt', limit: 5 }), /limit/);
  await assert.rejects(workspace.read({ path: '.' }), /regular file/);
});

test('all operations reject absolute paths and parent traversal before filesystem access', async t => {
  const { root, workspace } = await fixture(t, { allowWrite: true });
  for (const invalid of [root, '../secret', 'sub/../secret', 'C:/secret', 'C:\\secret', 'sub\\secret']) {
    await assert.rejects(workspace.list({ path: invalid }), /absolute|traversal|backslashes/);
    await assert.rejects(workspace.read({ path: invalid }), /absolute|traversal|backslashes/);
    await assert.rejects(workspace.write({ path: invalid, content: 'x' }), /absolute|traversal|backslashes/);
  }
});

test('symlink file and parent escapes are rejected; listing does not follow links', async t => {
  const { root, parent, workspace } = await fixture(t, { allowWrite: true });
  const outside = path.join(parent, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'unchanged');
  await symlink(outside, path.join(root, 'escape'));
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'secret.txt'));
  const listed = await workspace.list();
  assert.ok(listed.entries.every(entry => entry.type === 'symlink'));
  for (const target of ['secret.txt', 'escape/secret.txt']) {
    await assert.rejects(workspace.read({ path: target }), /symbolic links/);
    await assert.rejects(workspace.write({ path: target, content: 'modified' }), /symbolic links/);
  }
  await assert.rejects(workspace.list({ path: 'escape' }), /symbolic links/);
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'unchanged');
});

test('workspace_write is disabled by default', async t => {
  const { root, workspace } = await fixture(t);
  await assert.rejects(workspace.write({ path: 'new.txt', content: 'x' }), /writes are disabled/);
  assert.deepEqual(await readdir(root), []);
});

test('authorized writes atomically create or replace complete text without leftover temporary files', async t => {
  const { root, workspace } = await fixture(t, { allowWrite: true });
  assert.deepEqual(await workspace.write({ path: 'result.txt', content: '你好' }), { path: 'result.txt', bytes: 6 });
  await workspace.write({ path: 'result.txt', content: 'replacement' });
  assert.equal(await readFile(path.join(root, 'result.txt'), 'utf8'), 'replacement');
  assert.deepEqual(await readdir(root), ['result.txt']);
  await assert.rejects(workspace.write({ path: 'missing/result.txt', content: 'x' }), /ENOENT/);
  await assert.rejects(workspace.write({ path: '.', content: 'x' }), /file path/);
});

test('oversized, binary and malformed Unicode writes preserve previous contents', async t => {
  const { root, workspace } = await fixture(t, { allowWrite: true, maxWriteBytes: 6 });
  await writeFile(path.join(root, 'text.txt'), 'old');
  await assert.rejects(workspace.write({ path: 'text.txt', content: '你好啊' }), /maxWriteBytes/);
  await assert.rejects(workspace.write({ path: 'text.txt', content: '\ud800' }), /surrogate/);
  await assert.rejects(workspace.write({ path: 'text.txt', content: 'a\0' }), /NUL/);
  assert.equal(await readFile(path.join(root, 'text.txt'), 'utf8'), 'old');
  assert.deepEqual(await readdir(root), ['text.txt']);
});

test('caller cancellation prevents a write and disposal waits for admitted work', async t => {
  const { root, workspace } = await fixture(t, { allowWrite: true });
  await writeFile(path.join(root, 'text.txt'), 'old');
  const aborted = AbortSignal.abort(new Error('caller cancelled'));
  await assert.rejects(workspace.write({ path: 'text.txt', content: 'new' }, aborted), /caller cancelled/);
  const pending = workspace.write({ path: 'text.txt', content: 'new' });
  const rejected = assert.rejects(pending, /disposed/);
  await workspace.close();
  await rejected;
  assert.equal(await readFile(path.join(root, 'text.txt'), 'utf8'), 'old');
  assert.deepEqual(await readdir(root), ['text.txt']);
  await assert.rejects(workspace.read({ path: 'text.txt' }), /disposed/);
  await workspace.close();
});

async function runtime(t) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  let id = 0;
  return { ctx, call: (name, args, signal = new AbortController().signal) => ctx.tools.execute({
    callId: `workspace-test-${++id}`, name, arguments: args, signal,
  }) };
}

test('official ToolRuntime executes workspace tools and removes them with their Cordis Fiber', async t => {
  const { root } = await fixture(t);
  const { ctx, call } = await runtime(t);
  await writeFile(path.join(root, 'input.txt'), 'official pipeline');
  const fiber = await ctx.plugin(workspacePlugin, { root, allowWrite: true });
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), ['workspace_list', 'workspace_read', 'workspace_write']);
  const read = await call('workspace_read', { path: 'input.txt' });
  assert.equal(read.isError, false);
  assert.equal(read.value.content, 'official pipeline');
  assert.equal(JSON.parse(read.content[0].text).total, 17);
  const write = await call('workspace_write', { path: 'output.txt', content: 'saved' });
  assert.equal(write.isError, false);
  assert.equal(await readFile(path.join(root, 'output.txt'), 'utf8'), 'saved');
  const invalid = await call('workspace_read', { path: 42 });
  assert.equal(invalid.isError, true);
  const denied = await call('workspace_read', { path: '../outside' });
  assert.equal(denied.isError, true);
  const escapedRead = ctx.tools.get('workspace_read');
  await fiber.dispose();
  await assert.rejects(escapedRead.execute({ path: 'input.txt' }, { signal: new AbortController().signal }), /disposed/);
  assert.deepEqual(ctx.tools.schemas(), []);
  assert.equal((await call('workspace_read', { path: 'input.txt' })).isError, true);
  const reloaded = await ctx.plugin(workspacePlugin, { root });
  assert.equal((await call('workspace_read', { path: 'input.txt' })).isError, false);
  assert.equal((await call('workspace_write', { path: 'output.txt', content: 'denied' })).isError, true);
  await reloaded.dispose();
});

test('hello example uses the public plugin API and supports clean unload/reload', async t => {
  const { ctx, call } = await runtime(t);
  const first = await ctx.plugin(hello, { prefix: '你好' });
  assert.deepEqual((await call('hello', { name: 'Cordis' })).value, { greeting: '你好, Cordis!' });
  await first.dispose();
  assert.equal((await call('hello', { name: 'Cordis' })).isError, true);
  const second = await ctx.plugin(hello, { prefix: 'Welcome' });
  assert.deepEqual((await call('hello', { name: 'Cordis' })).value, { greeting: 'Welcome, Cordis!' });
  await second.dispose();
});
