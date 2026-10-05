#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const runtimeRoot = path.join(projectRoot, 'official-runtime');
export const evidencePath = path.join(projectRoot, '.cache/official/install-manifest.json');
export const runtimeNames = ['@cordis-verus/compat-cordis', '@cordis-verus/compat-harness', '@cordis-verus/compat-loader'];
export const officialVersion = '0.2.0-rc.2';
export const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
export const json = async file => JSON.parse(await readFile(file, 'utf8'));
const posix = file => file.split(path.sep).join('/');
const environment = () => ({ platform: process.platform, architecture: process.arch,
  node: process.version, nodeApi: process.versions.napi, nodeModuleAbi: process.versions.modules });

export function assertEnvironment() {
  assert(!Object.hasOwn(process.env, 'CORDIS_NATIVE_BINDING'), 'Unset CORDIS_NATIVE_BINDING: official evidence requires the packaged native binary');
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert(major > 22 || (major === 22 && minor >= 22), 'Official runtime requires Node >=22.22.0');
}

export async function approvedArchives() {
  assertEnvironment();
  const sources = await json(path.join(projectRoot, 'sources.lock.json'));
  const manifest = await json(path.join(runtimeRoot, 'package.json'));
  assert.equal(manifest.private, true);
  assert.equal(manifest.dependencies?.['@deepseek-ai/dsh'], officialVersion, 'Official release must be exactly pinned');
  const archives = [];
  for (const name of runtimeNames) {
    const entry = sources.cordis.archives.find(item => item.name === name);
    assert(entry && entry.file.startsWith('.vendor/cordis/') && !entry.file.split('/').includes('..'), `Missing local runtime archive: ${name}`);
    assert.equal(manifest.dependencies[name], `file:../${entry.file}`, `Unexpected runtime source: ${name}`);
    const file = path.join(projectRoot, entry.file);
    assert((await lstat(file)).isFile(), `Runtime archive is not a regular file: ${name}`);
    assert.equal(await hash(file), entry.sha256, `Runtime archive differs from sources.lock.json: ${name}`);
    archives.push({ ...entry, resolved: `file:../${entry.file}`,
      integrity: `sha512-${createHash('sha512').update(await readFile(file)).digest('base64')}` });
  }
  return archives;
}

export function checkRuntimeLock(lock, archives) {
  assert.equal(lock.lockfileVersion, 3, 'Expected npm lockfile v3');
  assert.equal(lock.packages?.[''].dependencies?.['@deepseek-ai/dsh'], officialVersion);
  assert.equal(lock.packages?.['node_modules/@deepseek-ai/dsh']?.version, officialVersion);
  for (const item of archives) {
    const entry = lock.packages?.[`node_modules/${item.name}`];
    assert(entry && !entry.link, `Missing extracted runtime lock entry: ${item.name}`);
    assert.equal(entry.version, item.version);
    assert.equal(entry.resolved, item.resolved);
    assert.equal(entry.integrity, item.integrity, `Stale local runtime lock: ${item.name}; reinstall with --refresh-runtime-lock`);
    assert.equal(lock.packages[''].dependencies[item.name], item.resolved);
  }
}

// npm can omit peer-only packages through user config. A fresh baseline must
// never bless an incomplete required tree merely because npm ci exited zero.
export function checkRequiredPackages(lock, files) {
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    const file = `${name.replace(/^node_modules\//, '')}/package.json`;
    assert(files[file] || entry.optional === true, `Required locked package is missing: ${name}`);
  }
}

async function fileInventory(directory) {
  assert(!(await lstat(directory)).isSymbolicLink(), 'node_modules must be a real installation directory');
  const base = await realpath(directory);
  const files = {};
  async function visit(at) {
    for (const name of (await readdir(at)).sort()) {
      const file = path.join(at, name), entry = await lstat(file), relative = posix(path.relative(directory, file));
      if (entry.isSymbolicLink()) {
        assert((await realpath(file)).startsWith(base + path.sep), `Dependency symlink escapes installation: ${relative}`);
        files[relative] = { link: await readlink(file) };
      } else if (entry.isDirectory()) await visit(file);
      else {
        assert(entry.isFile(), `Non-file dependency content: ${relative}`);
        files[relative] = { sha256: await hash(file), bytes: entry.size, executable: !!(entry.mode & 0o111) };
      }
    }
  }
  await visit(directory);
  return files;
}

// Shared read-only inspection. Only install-official calls this to create evidence,
// after a successful real npm ci; this verifier has no refresh/write mode.
export async function inspectInstallation() {
  const archives = await approvedArchives();
  const sources = await json(path.join(projectRoot, 'sources.lock.json'));
  const lockPath = path.join(runtimeRoot, 'package-lock.json'), lock = await json(lockPath);
  checkRuntimeLock(lock, archives);
  const modules = path.join(runtimeRoot, 'node_modules');
  const files = await fileInventory(modules);
  checkRequiredPackages(lock, files);
  const reportPath = path.join(projectRoot, '.vendor/cordis/provenance/package-report.json');
  assert.equal(await hash(reportPath), sources.cordis.packageReportSha256, 'Core package report differs from approved sources');
  const report = await json(reportPath);
  for (const name of runtimeNames) {
    const expected = report.packages.find(item => item.name === name);
    assert(expected, `Missing core distribution report: ${name}`);
    assert(!(await lstat(path.join(modules, name))).isSymbolicLink(), `Linked runtime package: ${name}`);
    assert.equal((await json(path.join(modules, name, 'package.json'))).version, archives.find(item => item.name === name).version);
    const actual = Object.keys(files).filter(file => file.startsWith(name + '/')).map(file => file.slice(name.length + 1));
    assert.deepEqual(actual.sort(), [...expected.files].sort(), `Unexpected runtime files: ${name}`);
    for (const file of expected.files) {
      const key = `packages/${name.split('/').at(-1)}/${file}`;
      const digest = report.sourceHashes[key] ?? (['LICENSE', 'NOTICE'].includes(file) ? report.sourceHashes[file] : undefined);
      assert(digest, `Missing core source hash: ${key}`);
      assert.equal(files[`${name}/${file}`]?.sha256, digest, `Runtime bytes differ from tested core: ${name}/${file}`);
    }
  }
  const officialPackages = {};
  for (const [name, entry] of Object.entries(lock.packages)) {
    assert(!entry.link, `Linked package in official lock: ${name}`);
    if (entry.resolved?.startsWith('file:')) assert(runtimeNames.some(item => name === `node_modules/${item}`), `Unexpected local dependency: ${name}`);
    const relative = name.replace(/^node_modules\//, '');
    if (!name || !files[`${relative}/package.json`]) continue; // Only optional absence passed checkRequiredPackages above.
    const manifest = await json(path.join(modules, relative, 'package.json'));
    assert.equal(manifest.version, entry.version, `Installed version differs from lock: ${name}`);
    if (manifest.name?.startsWith('@deepseek-ai/')) officialPackages[relative] = manifest.version;
  }
  assert.equal(officialPackages['@deepseek-ai/dsh'], officialVersion);
  const required = ['@deepseek-ai/dsh/lib/bin.js', '@deepseek-ai/dsh-base/cordis.patch.yml',
    '@deepseek-ai/dsh-web-app/cordis.patch.yml', '@deepseek-ai/dsh-web-frontend/dist/index.html',
    ...['standard', 'ptc', 'minimal', 'cordis'].map(name => `@deepseek-ai/dsh-web-app/presets/${name}.patch.yml`)];
  for (const file of required) assert(files[file]?.bytes > 0 && files[file].sha256, `Missing official CLI/default Web asset: ${file}`);
  const { selectNativeArtifact } = await import(pathToFileURL(path.join(modules, '@cordis-verus/compat-cordis/native-artifacts.js')).href);
  const selected = selectNativeArtifact();
  assert.equal(await hash(selected.path), sources.cordis.nativeArtifactSha256, 'Selected native binary differs from approved core');
  assert.equal(selected.entry.target, sources.cordis.nativeTarget);
  const platform = `${process.platform}-${process.arch}`;
  const requiredNativePrefixes = [`@deepseek-ai/node-addon-system-${platform}/`,
    `node-pty/prebuilds/${platform}/`, `@koromix/koffi-${platform}/`,
    `node-addon-require-builtin-${platform}`, `@img/sharp-${platform}/`];
  const native = Object.fromEntries(Object.entries(files).filter(([file]) => /\.(node|dylib|so|wasm)$/.test(file)));
  for (const prefix of requiredNativePrefixes) assert(Object.keys(native).some(file => file.startsWith(prefix)), `Missing native optional dependency for ${platform}: ${prefix}; install with optional dependencies enabled`);
  if (process.platform !== 'win32') {
    const helper = `node-pty/prebuilds/${platform}/spawn-helper`;
    assert(files[helper]?.bytes > 0 && files[helper].executable, `Missing/non-executable native spawn helper: ${helper}`);
    native[helper] = files[helper];
  }
  return { schema: 'cordis-harness.official-install/v1', environment: environment(),
    packageJsonSha256: await hash(path.join(runtimeRoot, 'package.json')), packageLockSha256: await hash(lockPath),
    sourceLockSha256: await hash(path.join(projectRoot, 'sources.lock.json')), packageReportSha256: await hash(reportPath),
    officialVersion, officialPackages, archives, nativeTarget: selected.entry.target,
    nativeEvidence: 'Packaged asset presence and integrity; not application execution acceptance', native, files };
}

export async function verifyOfficial() {
  assertEnvironment();
  let evidence;
  try { evidence = await json(evidencePath); }
  catch (cause) { throw new Error('Missing official installation evidence; run node scripts/install-official.mjs', { cause }); }
  const { installedAt, command, ...expected } = evidence;
  assert(Number.isFinite(Date.parse(installedAt)), 'Invalid installation timestamp');
  assert.deepEqual(command?.slice(0, 5), ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  const actual = await inspectInstallation();
  const { files: expectedFiles, ...expectedMetadata } = expected;
  const { files: actualFiles, ...actualMetadata } = actual;
  assert(expectedFiles && typeof expectedFiles === 'object', 'Missing installed file evidence');
  assert.equal(Object.keys(actualFiles).length, Object.keys(expectedFiles).length, 'Installed file set changed; reinstall the official runtime');
  for (const [file, entry] of Object.entries(expectedFiles)) assert.deepEqual(actualFiles[file], entry, `Official installation changed: ${file}`);
  assert.deepEqual(actualMetadata, expectedMetadata, 'Official installation metadata changed; inspect changes and reinstall with install-official.mjs');
  return actual;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/verify-official.mjs');
  const evidence = await verifyOfficial();
  console.log(`Verified unmodified official dsh ${officialVersion}: ${Object.keys(evidence.officialPackages).length} official packages, ${Object.keys(evidence.files).length} installed files, native ${evidence.nativeTarget}. Application execution is validated separately.`);
}
