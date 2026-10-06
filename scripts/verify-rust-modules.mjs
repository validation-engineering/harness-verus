#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readNativeModule } from '../src/native-module-artifacts.mjs';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedCoreSources, projectRoot, runtimeEnvironment, sha256 } from './verify-rust-addon.mjs';

export { projectRoot };
export const moduleFactoryName = 'harness.dynamic-text-analysis';
export const moduleServiceName = 'rustDynamicText';
export const moduleEvidenceRelativePath = '.cache/rust-modules/build.json';
const extension = { darwin: '.dylib', linux: '.so', win32: '.dll' }[process.platform];
export const moduleArtifactRelativePaths = Object.fromEntries(['v1', 'v2', 'fail']
  .map(revision => [revision, `.cache/rust-modules/dynamic-text-analysis-${revision}${extension ?? '.unsupported'}`]));
const json = async file => JSON.parse(await readFile(file, 'utf8'));

export async function moduleSources(root = projectRoot) {
  const files = ['native/dynamic-text-analysis/Cargo.toml', 'native/dynamic-text-analysis/Cargo.lock',
    'src/native-module-artifacts.mjs', 'scripts/build-rust-modules.mjs', 'scripts/verify-rust-modules.mjs', 'scripts/verify-rust-addon.mjs'];
  async function visit(relative) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const file = `${relative}/${name}`, stat = await lstat(path.join(root, file));
      assert(!stat.isSymbolicLink(), `Native module source symlink is not supported: ${file}`);
      if (stat.isDirectory()) await visit(file);
      else { assert(stat.isFile(), `Native module source is not a file: ${file}`); files.push(file); }
    }
  }
  await visit('native/dynamic-text-analysis/src');
  await visit('native/dynamic-text-analysis/examples');
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, await sha256(path.join(root, file))])));
}

export async function verifyRustModules({ root = projectRoot, runtime = 'official' } = {}) {
  assert(['official', 'slim'].includes(runtime), 'Native module runtime must be official or slim');
  assert(extension, 'Unsupported native module platform');
  const evidencePath = path.join(root, moduleEvidenceRelativePath);
  const evidence = await json(evidencePath);
  assert.equal(evidence.schema, 'cordis-harness.rust-modules/v1');
  assert.equal(evidence.abi, 1);
  assert.equal(evidence.factory, moduleFactoryName);
  assert.equal(evidence.service, moduleServiceName);
  assert.deepEqual(evidence.environment, runtimeEnvironment(), 'Native modules were built for another runtime environment');
  assert.deepEqual(evidence.inputs, await moduleSources(root), 'Native module sources changed; rebuild the libraries');
  assert.deepEqual(evidence.coreSources, await approvedCoreSources(root), 'Native module SDK differs from the approved runtime');
  assert.deepEqual(Object.keys(evidence.artifacts).sort(), ['fail', 'v1', 'v2']);
  assert(evidence.dependencies.includes('cordis-plugin-api'), 'Native module must use the versioned SDK');
  assert(!evidence.dependencies.some(name => ['cordis', 'cordis-node', 'cordis-driver', 'cordis-kernel', 'napi', 'napi-derive'].includes(name)),
    'A dynamic module must not embed a second Driver or Node binding');
  const distribution = await json(path.join(root, '.vendor/cordis/provenance/package-report.json'));
  const installed = runtime === 'official' ? 'official-runtime/node_modules' : 'node_modules';
  for (const name of ['compat-cordis', 'compat-harness', 'compat-loader']) {
    const compat = distribution.packages.find(item => item.name === `@cordis-verus/${name}`);
    assert(compat?.files?.length, `Missing approved ${name} runtime file evidence`);
    for (const file of compat.files) {
      const expected = distribution.sourceHashes[`packages/${name}/${file}`]
        ?? (['LICENSE', 'NOTICE'].includes(file) ? distribution.sourceHashes[file] : undefined);
      assert(expected, `Missing approved runtime hash: ${name}/${file}`);
      assert.equal(await sha256(path.join(root, installed, `@cordis-verus/${name}`, file)), expected,
        `Installed Cordis runtime differs from native module provenance: ${name}/${file}`);
    }
  }
  const artifacts = {}, published = {};
  for (const [revision, relative] of Object.entries(moduleArtifactRelativePaths)) {
    const entry = evidence.artifacts[revision];
    assert.equal(entry.path, relative);
    assert.equal(entry.revision, revision);
    assert.equal(entry.compilerProfile.opt_level, '3');
    assert.equal(entry.compilerProfile.debug_assertions, true);
    assert.equal(entry.compilerProfile.overflow_checks, true);
    const file = path.join(root, relative), stat = await lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), `Native module must be a regular file: ${relative}`);
    assert.equal(await sha256(file), entry.sha256, `Native module bytes differ from build evidence: ${revision}`);
    artifacts[revision] = { path: file, sha256: entry.sha256 };
    assert.match(entry.published?.manifestPath ?? '', /^\.cache\/rust-modules\/published\/[a-f0-9]{64}\.json$/);
    published[revision] = await readNativeModule(path.join(root, entry.published.manifestPath), { sha256: entry.published.manifestSha256 });
    assert.equal(published[revision].config.sha256, entry.sha256);
    assert.deepEqual(published[revision].config.plugins, [{ id: 'analysis', factory: moduleFactoryName }]);
  }
  return { artifacts, published, evidence, manifestSha256: await sha256(evidencePath),
    coreSourceDigest: createHash('sha256').update(JSON.stringify(evidence.coreSources)).digest('hex') };
}

// Verification is explicit and read-only; building unapproved inputs is never an
// implicit fallback when a caller requests artifacts.
export const ensureRustModules = verifyRustModules;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--slim',
    'Usage: node scripts/verify-rust-modules.mjs [--slim]');
  const { evidence } = await verifyRustModules({ runtime: process.argv.includes('--slim') ? 'slim' : 'official' });
  console.log(`Verified ${evidence.factory} v1/v2/fail: ${evidence.environment.platform}-${evidence.environment.architecture}; execution acceptance is separate.`);
}
