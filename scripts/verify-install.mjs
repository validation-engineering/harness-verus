#!/usr/bin/env node
import '@cordis-verus/compat-harness/register';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
assert(process.argv.length <= 3 && (!process.argv[2] || process.argv[2] === '--installed-only'), 'Usage: verify-install.mjs [--installed-only]');
assert(!process.env.CORDIS_NATIVE_BINDING, 'Installation evidence requires the installed native artifact, without CORDIS_NATIVE_BINDING');
const lock = await json(path.join(root, 'sources.lock.json'));
const installed = await realpath(path.join(root, 'node_modules'));
const names = lock.cordis.archives.map(item => item.name);
for (const item of lock.cordis.archives) {
  assert.equal(await hash(path.join(root, item.file)), item.sha256, `Archive differs from source lock: ${item.name}`);
  const location = path.join(installed, item.name);
  assert.equal((await lstat(location)).isSymbolicLink(), false, `Linked runtime package: ${item.name}`);
  assert((await realpath(location)).startsWith(installed + path.sep), `Runtime outside project: ${item.name}`);
  assert.equal((await json(path.join(location, 'package.json'))).version, item.version);
}
// Exact installed bytes must match the independently tested distribution sources.
const reportPath = path.join(root, '.vendor/cordis/provenance/package-report.json');
assert.equal(await hash(reportPath), lock.cordis.packageReportSha256, 'Package evidence differs from source lock');
const report = await json(reportPath);
async function installedFiles(directory) {
  const files = [];
  async function visit(at) {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      assert(!entry.isSymbolicLink(), `Linked runtime content: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else { assert(entry.isFile()); files.push(path.relative(directory, file).split(path.sep).join('/')); }
    }
  }
  await visit(directory);
  return files.sort();
}
for (const item of report.packages) {
  assert.deepEqual(await installedFiles(path.join(installed, item.name)), [...item.files].sort(), `Unexpected runtime package content: ${item.name}`);
  for (const file of item.files) {
  const source = `packages/${item.name.split('/').at(-1)}/${file}`;
  const expected = report.sourceHashes[source] ?? (['LICENSE', 'NOTICE'].includes(file) ? report.sourceHashes[file] : undefined);
  assert(expected, `No distribution source hash for ${item.name}/${file}`);
  assert.equal(await hash(path.join(installed, item.name, file)), expected, `Installed package changed: ${item.name}/${file}`);
}
}
const packageLock = await json(path.join(root, 'package-lock.json'));
for (const [name, entry] of Object.entries(packageLock.packages)) {
  assert(!entry.link, `Linked dependency in npm lock: ${name}`);
  if (entry.resolved?.startsWith('file:')) assert(!path.isAbsolute(entry.resolved.slice(5)) && !entry.resolved.includes('../'), `External file dependency: ${name}`);
  assert(!/(^|\/)node_modules\/(?:@deepseek-ai\/cordis|cordis|@cordisjs\/core)$/.test(name), `Upstream JS scheduler is installed: ${name}`);
}
const facade = await import('@cordis-verus/compat-harness');
const routed = await import('@deepseek-ai/cordis');
const require = createRequire(import.meta.url);
assert.equal(facade.Context, routed.Context, 'Official imports resolve to another runtime');
assert.equal(facade.Context, require('@cordis-verus/compat-harness').Context);
assert.equal(facade.Context, require('@deepseek-ai/cordis').Context);
const { selectNativeArtifact } = await import('@cordis-verus/compat-cordis/native-artifacts');
const selected = selectNativeArtifact();
assert((await realpath(selected.path)).startsWith(installed + path.sep));
assert.equal(await hash(selected.path), lock.cordis.nativeArtifactSha256);
const ctx = new facade.Context();
try { assert.equal(ctx.snapshot().profile, 'harness'); } finally { await ctx.dispose(); }
if (process.argv[2] !== '--installed-only') {
  const build = await json(path.join(root, 'dist/build-report.json'));
  assert.equal(build.schema, 'cordis-harness.build/v1');
  assert.equal(build.status, 'passed');
  for (const name of ['package.json', 'package-lock.json', 'sources.lock.json', 'scripts/build.mjs', 'src/upstream.ts', lock.deepseekHarness.snapshotFile]) {
    assert.match(build.inputs?.[name] ?? '', /^[a-f0-9]{64}$/, `Incomplete build evidence: input ${name}`);
  }
  for (const name of ['dist/upstream/plugins.mjs', 'dist/package.json', 'dist/THIRD-PARTY-NOTICES.txt']) {
    assert.match(build.outputs?.[name] ?? '', /^[a-f0-9]{64}$/, `Incomplete build evidence: output ${name}`);
  }
  assert.equal(build.runtimeSourceFingerprint, lock.cordis.sourceFingerprint);
  for (const [name, expected] of Object.entries({ ...build.inputs, ...build.outputs })) assert.equal(await hash(path.join(root, name)), expected, `Stale build: ${name}`);
}
console.log(`Verified ${names.length} extracted runtime packages, native ${selected.entry.target}, unique Harness Context${process.argv[2] ? '' : ', and build input/output hashes'}.`);
