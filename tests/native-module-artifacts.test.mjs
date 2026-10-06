import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { publishNativeModule, readNativeModule } from '../src/native-module-artifacts.mjs';

const extension = { darwin: '.dylib', linux: '.so', win32: '.dll' }[process.platform];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plugin = config => ({ id: 'analysis', factory: 'harness.dynamic-text-analysis', config });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cordis-native-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryPath = join(root, `plugin${extension}`), directory = join(root, 'published');
  await writeFile(libraryPath, 'trusted fixture library bytes');
  const publish = (plugins = [plugin({ value: 1 })]) => publishNativeModule({ libraryPath, directory, plugins });
  return { root, libraryPath, directory, publish };
}
async function alteredManifest(published, mutate) {
  const manifest = JSON.parse(await readFile(published.manifestPath, 'utf8'));
  mutate(manifest);
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`), sha256 = hash(bytes);
  const path = join(dirname(published.manifestPath), `${sha256}.json`);
  await writeFile(path, bytes);
  return path;
}

test('publishes content-addressed immutable library and recipes independently of source changes', async t => {
  const f = await fixture(t), plugins = [plugin({ nested: { value: 1 } })];
  const pending = f.publish(plugins);
  plugins[0].config.nested.value = 99;
  const published = await pending;
  assert.equal(basename(published.manifestPath), `${published.manifestSha256}.json`);
  assert.equal(basename(published.config.path), `${published.config.sha256}${extension}`);
  assert.equal(published.config.plugins[0].config.nested.value, 1);
  assert.equal(Object.isFrozen(published.config.plugins[0].config.nested), true);
  assert.equal((await lstat(published.config.path)).mode & 0o222, 0);
  await writeFile(f.libraryPath, 'source changed after publication');
  assert.equal(await readFile(published.config.path, 'utf8'), 'trusted fixture library bytes');
  assert.deepEqual(await readNativeModule(published.manifestPath, { sha256: published.manifestSha256 }), published);
  await rm(f.libraryPath);
  assert.deepEqual(await readNativeModule(published.manifestPath), published);
});

test('repeated and concurrent publications reuse verified bytes and canonical configuration keys', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => f.publish([plugin({ b: 2, a: 1 })])));
  assert(results.every(item => item.manifestPath === results[0].manifestPath));
  const equivalent = await f.publish([plugin({ a: 1, b: 2 })]);
  assert.equal(equivalent.manifestSha256, results[0].manifestSha256);
  const changed = await f.publish([plugin({ a: 1, b: 3 })]);
  assert.notEqual(changed.manifestSha256, equivalent.manifestSha256);
  assert.equal(changed.config.path, equivalent.config.path);
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith('.json')).length, 2);
  assert.equal((await readdir(join(f.directory, 'images'))).length, 1);
  assert(!(await readdir(f.directory)).some(name => name.endsWith('.tmp')));
});

test('empty plugin groups are a valid captured configuration', async t => {
  const f = await fixture(t), published = await f.publish([]);
  assert.deepEqual(published.config.plugins, []);
  assert.deepEqual((await readNativeModule(published.manifestPath)).config.plugins, []);
});

test('tampered library is rejected on read and cannot be overwritten by republishing', async t => {
  const f = await fixture(t), published = await f.publish();
  await chmod(published.config.path, 0o600); await writeFile(published.config.path, 'tampered');
  await assert.rejects(readNativeModule(published.manifestPath), /library digest differs/);
  await assert.rejects(f.publish(), /different bytes/);
  assert.equal(await readFile(published.config.path, 'utf8'), 'tampered');
});

test('tampered manifest and incorrect digest pins fail without replacing files', async t => {
  const f = await fixture(t), published = await f.publish();
  await assert.rejects(readNativeModule(published.manifestPath, { sha256: '0'.repeat(64) }), /manifest digest differs/);
  await assert.rejects(readNativeModule(published.manifestPath, { sha256: 'not-a-digest' }), /lowercase hexadecimal/);
  await chmod(published.manifestPath, 0o600); await writeFile(published.manifestPath, '{}');
  await assert.rejects(readNativeModule(published.manifestPath), /filename does not match/);
  await assert.rejects(f.publish(), /different bytes/);
  assert.equal(await readFile(published.manifestPath, 'utf8'), '{}');
});

test('manifest validates exact fields, host target, ABI and relative image identity', async t => {
  const f = await fixture(t), published = await f.publish();
  for (const [mutate, expected] of [
    [value => { value.extra = true; }, /invalid fields/],
    [value => { delete value.plugins; }, /invalid fields/],
    [value => { value.schema = 'unknown'; }, /schema or ABI/],
    [value => { value.abi = 2; }, /schema or ABI/],
    [value => { value.platform = 'other'; }, /platform or architecture/],
    [value => { value.architecture = 'other'; }, /platform or architecture/],
    [value => { value.artifact.extra = 1; }, /invalid fields/],
    [value => { value.artifact.path = '../plugin.dylib'; }, /relative content-addressed/],
    [value => { value.artifact.path = f.libraryPath; }, /relative content-addressed/],
    [value => { value.artifact.path = `images\\${value.artifact.sha256}${extension}`; }, /relative content-addressed/],
    [value => { value.artifact.sha256 = 'BAD'; }, /lowercase hexadecimal/],
    [value => { value.plugins = [plugin({}), plugin({})]; }, /unique ids/],
    [value => { value.plugins[0].unknown = true; }, /unique ids/],
  ]) {
    await assert.rejects(readNativeModule(await alteredManifest(published, mutate)), expected);
  }
});

test('rejects symlink libraries, manifests and image directories', async t => {
  const f = await fixture(t), published = await f.publish();
  const linkedDirectory = join(f.root, 'linked-directory'); await symlink(f.directory, linkedDirectory);
  await assert.rejects(publishNativeModule({ libraryPath: f.libraryPath, directory: linkedDirectory, plugins: [] }), /directory must not be a symlink/);
  await assert.rejects(readNativeModule(join(linkedDirectory, basename(published.manifestPath))), /directory must not be a symlink/);
  const linkedSource = join(f.root, `linked${extension}`);
  await symlink(f.libraryPath, linkedSource);
  await assert.rejects(publishNativeModule({ libraryPath: linkedSource, directory: f.directory, plugins: [] }), /non-symlink/);
  const external = join(f.root, 'saved-image'); await copyFile(published.config.path, external);
  await rm(published.config.path); await symlink(external, published.config.path);
  await assert.rejects(readNativeModule(published.manifestPath), /non-symlink/);
  await assert.rejects(f.publish(), /non-symlink/);
  await rm(join(f.directory, 'images'), { recursive: true });
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await copyFile(external, join(outside, basename(published.config.path)));
  await symlink(outside, join(f.directory, 'images'));
  await assert.rejects(readNativeModule(published.manifestPath), /directory must not be a symlink/);
  await assert.rejects(f.publish(), /directory must not be a symlink/);
  const manifestCopy = join(f.root, 'manifest-copy'); await copyFile(published.manifestPath, manifestCopy);
  await rm(published.manifestPath); await symlink(manifestCopy, published.manifestPath);
  await assert.rejects(readNativeModule(published.manifestPath), /non-symlink/);
});

test('rejects non-files and finite JSON violations before publication', async t => {
  const f = await fixture(t), cycle = {}; cycle.self = cycle;
  const accessor = {}; Object.defineProperty(accessor, 'value', { enumerable: true, get() { throw new Error('must not execute'); } });
  for (const config of [undefined, NaN, Infinity, 1n, () => {}, cycle, new Date(), accessor, Array(2)]) {
    await assert.rejects(f.publish([plugin(config)]), /JSON|accessors/);
  }
  let deep = {}; for (let i = 0; i < 66; i++) deep = { next: deep };
  await assert.rejects(f.publish([plugin(deep)]), /depth 64/);
  await assert.rejects(f.publish({}), /must be an array/);
  await assert.rejects(f.publish([plugin({}), plugin({})]), /unique ids/);
  await assert.rejects(publishNativeModule({ libraryPath: f.root, directory: f.directory, plugins: [] }), /extension/);
  const fakeLibrary = join(f.root, `directory${extension}`); await mkdir(fakeLibrary);
  await assert.rejects(publishNativeModule({ libraryPath: fakeLibrary, directory: f.directory, plugins: [] }), /regular non-symlink/);
  await writeFile(f.libraryPath, '');
  await assert.rejects(f.publish(), /must not be empty/);
});

test('manifest byte limit and reader JSON validation fail closed', async t => {
  const f = await fixture(t), published = await f.publish();
  await assert.rejects(f.publish([plugin({ text: 'x'.repeat(1024 * 1024) })]), /manifest exceeds/);
  for (const [bytes, expected] of [
    [Buffer.alloc(1024 * 1024 + 1), /exceeds/],
    [Buffer.from('{invalid'), /valid UTF-8 JSON/],
    [Buffer.from([0xff]), /valid UTF-8 JSON/],
    [Buffer.from((await readFile(published.manifestPath, 'utf8')).replace('"value":1', '"value":1e400')), /finite JSON/],
  ]) {
    const file = join(f.directory, `${hash(bytes)}.json`); await writeFile(file, bytes);
    await assert.rejects(readNativeModule(file), expected);
  }
});


test('migration is an explicit captured recipe policy and invalid state policies are rejected', async t => {
  const f = await fixture(t);
  const original = { ...plugin({}), state: 'migrate' };
  const published = await f.publish([original]);
  original.state = 'changed';
  assert.equal(published.config.plugins[0].state, 'migrate');
  assert.deepEqual(await readNativeModule(published.manifestPath), published);
  const cold = await f.publish([plugin({})]);
  assert.notEqual(cold.manifestSha256, published.manifestSha256);
  for (const state of [null, true, 'automatic', {}, 1]) {
    await assert.rejects(f.publish([{ ...plugin({}), state }]), { code: 'NATIVE_ARTIFACT_CONFIG' });
  }
});
