#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const addonRelativePath = '.cache/rust-addon/text-analysis.node';
export const addonEvidenceRelativePath = '.cache/rust-addon/build.json';
export const factoryName = 'harness.text-analysis';
export const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export const runtimeEnvironment = () => ({ platform: process.platform, architecture: process.arch,
  node: process.version, nodeApi: process.versions.napi, nodeModuleAbi: process.versions.modules });

async function inventory(root, directories, fixed, accept) {
  const files = [...fixed];
  async function visit(relative) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const file = `${relative}/${name}`, stat = await lstat(path.join(root, file));
      assert(!stat.isSymbolicLink(), `Source symlink is not supported: ${file}`);
      if (stat.isDirectory()) await visit(file);
      else { assert(stat.isFile(), `Source is not a regular file: ${file}`); if (accept(file)) files.push(file); }
    }
  }
  for (const directory of directories) await visit(directory);
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, await sha256(path.join(root, file))])));
}
export async function addonSources(root = projectRoot) {
  return inventory(root, ['native/text-analysis/src'], ['native/text-analysis/Cargo.toml',
    'native/text-analysis/Cargo.lock', 'native/text-analysis/build.rs',
    'scripts/build-rust-addon.mjs', 'scripts/verify-rust-addon.mjs'], () => true);
}
export async function coreSources(root) {
  return inventory(root, ['cordis-kernel', 'cordis-driver', 'cordis', 'cordis-node'].map(name => `crates/${name}`),
    ['Cargo.toml', 'Cargo.lock', 'toolchain.lock.json', 'scripts/build-node.sh', 'scripts/build-node.mjs',
      'scripts/toolchain-env.sh', 'scripts/write-native-manifest.mjs',
      'packages/compat-cordis/native-artifacts.js', 'packages/compat-cordis/package.json'], file => /\.(rs|toml)$/.test(file));
}
export async function approvedCoreSources(root = projectRoot) {
  const sources = await json(path.join(root, 'sources.lock.json'));
  const reportPath = path.join(root, '.vendor/cordis/provenance/package-report.json');
  assert.equal(await sha256(reportPath), sources.cordis.packageReportSha256, 'Core package report differs from approved sources');
  const report = await json(reportPath);
  assert.equal(report.status, 'passed', 'Core distribution must have passed its recorded checks');
  assert(Object.keys(report.nativeSourceHashes ?? {}).length > 0, 'Missing approved native source hashes');
  return report.nativeSourceHashes;
}
export async function verifyRustAddon({ root = projectRoot } = {}) {
  const evidence = await json(path.join(root, addonEvidenceRelativePath));
  assert.equal(evidence.schema, 'cordis-harness.rust-addon/v1');
  assert.equal(evidence.artifact.path, addonRelativePath);
  assert.equal(evidence.factory, factoryName);
  assert.deepEqual(evidence.environment, runtimeEnvironment(), 'Rust addon was built for another Node environment');
  assert.deepEqual(evidence.inputs, await addonSources(root), 'Rust addon sources changed; rebuild the addon');
  assert.deepEqual(evidence.coreSources, await approvedCoreSources(root), 'Rust addon core differs from approved runtime; rebuild from its matching core');
  const distribution = await json(path.join(root, '.vendor/cordis/provenance/package-report.json'));
  const runtime = distribution.packages.find(item => item.name === '@cordis-verus/compat-cordis');
  assert(runtime?.files?.length, 'Missing Cordis runtime file evidence');
  for (const file of runtime.files) {
    const expected = distribution.sourceHashes[`packages/compat-cordis/${file}`]
      ?? (['LICENSE', 'NOTICE'].includes(file) ? distribution.sourceHashes[file] : undefined);
    assert(expected, `Missing Cordis runtime source hash: ${file}`);
    assert.equal(await sha256(path.join(root, 'official-runtime/node_modules/@cordis-verus/compat-cordis', file)), expected,
      `Installed Cordis runtime differs from addon provenance: ${file}`);
  }
  const addonPath = path.join(root, addonRelativePath);
  assert((await lstat(addonPath)).isFile(), 'Rust addon must be a regular file');
  assert.equal(await sha256(addonPath), evidence.artifact.sha256, 'Rust addon bytes differ from build evidence');
  const manifestSha256 = await sha256(path.join(root, addonEvidenceRelativePath));
  const coreSourceDigest = createHash('sha256').update(JSON.stringify(evidence.coreSources)).digest('hex');
  return { path: addonPath, addonPath, manifestSha256, coreSourceDigest, evidence };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/verify-rust-addon.mjs');
  const { evidence } = await verifyRustAddon();
  console.log(`Verified ${evidence.factory}: ${evidence.environment.platform}-${evidence.environment.architecture}, source-bound addon; execution acceptance is separate.`);
}
