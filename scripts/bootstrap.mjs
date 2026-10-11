#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installArtifacts } from './install-artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = async file => sha256(await readFile(file));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const exists = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
function safeRelative(name) {
  assert(typeof name === 'string' && name && !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'), `Unsafe source path: ${name}`);
  return name;
}
async function verifyHashes(base, entries) {
  assert(entries && Object.keys(entries).length, 'Missing source hashes');
  for (const [name, expected] of Object.entries(entries)) assert.equal(await hash(path.join(base, safeRelative(name))), expected, `Stale source: ${name}`);
}
async function snapshot(directory) {
  const result = {};
  async function visit(at) {
    for (const entry of (await readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(at, entry.name);
      const name = path.relative(directory, file).split(path.sep).join('/');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isSymbolicLink()) {
        const target = await readlink(file);
        const resolved = path.resolve(path.dirname(file), target);
        assert(resolved.startsWith(directory + path.sep), `Source symlink escapes snapshot: ${name}`);
        result[name] = { symlink: target };
      } else { assert(entry.isFile(), `Unsupported source entry: ${name}`); result[name] = { sha256: await hash(file) }; }
    }
  }
  await visit(directory);
  return result;
}

const args = process.argv.slice(2);
let source, upstreamSource, refresh = false, install = true, offline = true;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--cordis-source') source = args[++index];
  else if (arg === '--upstream-source') upstreamSource = args[++index];
  else if (arg === '--refresh-lock') refresh = true;
  else if (arg === '--no-install') install = false;
  else if (arg === '--online') offline = false;
  else if (arg === '--offline') offline = true;
  else throw new Error('Usage: bootstrap.mjs --cordis-source PATH [--upstream-source PATH] [--refresh-lock] [--no-install] [--offline|--online]');
}
assert(source, '--cordis-source is required: the current runtime snapshot is not a registry release');
source = path.resolve(source);
const sourceLock = await json(path.join(source, 'upstream.lock.json'));
const upstream = sourceLock.repositories.deepseekHarness;
upstreamSource = path.resolve(upstreamSource ?? path.join(source, upstream.path));
const git = (...args) => run('git', ['-C', source, ...args], root);
const officialGit = (...args) => run('git', ['-C', upstreamSource, ...args], root);
// This checks the complete source/build/package closure; it does not rerun proofs.
run('python3', ['scripts/record-development.py', '--check'], source);
const developmentPath = path.join(source, 'docs/development-report.json');
const packagePath = path.join(source, 'target/release-artifacts/npm/package-report.json');
const development = await json(developmentPath);
const packages = await json(packagePath);
assert.equal(development.status, 'passed');
assert.equal(packages.status, 'passed');
assert.equal(packages.testedTarget.platform, process.platform, 'Runtime artifact belongs to another platform');
assert.equal(packages.testedTarget.architecture, process.arch, 'Runtime artifact belongs to another architecture');
await verifyHashes(source, development.sha256);
await verifyHashes(source, packages.sourceHashes);
await verifyHashes(source, packages.nativeSourceHashes);
assert.equal(officialGit('rev-parse', 'HEAD'), upstream.revision);
assert.equal(officialGit('rev-parse', 'HEAD^{tree}'), upstream.tree);
assert.equal(officialGit('status', '--porcelain=v1', '--untracked-files=all'), '', 'Official source must remain unchanged');
const expectedNames = ['@validation-engineering/cordis', '@validation-engineering/cordis-compat-deepseek', '@validation-engineering/cordis-loader'];
assert.deepEqual(packages.packages.map(item => item.name).sort(), expectedNames);
const archiveRecords = [];
for (const item of packages.packages) {
  assert.match(item.filename, /^[a-zA-Z0-9_.-]+\.tgz$/);
  assert.equal(await hash(path.join(source, 'target/release-artifacts/npm', item.filename)), item.sha256, `Stale package: ${item.name}`);
  archiveRecords.push({ name: item.name, version: item.version, file: `.vendor/cordis/${item.filename}`, sha256: item.sha256 });
}
const cache = path.join(root, '.cache/upstream');
await mkdir(cache, { recursive: true });
const archive = path.join(cache, `deepseek-harness.stage-${process.pid}.tar`);
officialGit('archive', '--format=tar', `--output=${archive}`, upstream.revision);
const stage = path.join(cache, `deepseek-harness.stage-${process.pid}`);
await rm(stage, { recursive: true, force: true });
await mkdir(stage);
let staged;
try {
  run('tar', ['-xf', archive, '-C', stage], root);
  staged = await snapshot(stage);
  const snapshotBytes = JSON.stringify(staged, null, 2) + '\n';
  const candidate = {
    schema: 'cordis-harness.sources/v1',
    cordis: {
      repository: git('remote', 'get-url', 'origin'),
      baseCommit: git('rev-parse', 'HEAD'),
      workingTreeDirty: git('status', '--porcelain=v1', '--untracked-files=all') !== '',
      sourceIdentity: 'verified working-tree file hashes; baseCommit is metadata, not snapshot identity',
      sourceFingerprint: sha256(JSON.stringify(development.sha256)),
      developmentReportSha256: await hash(developmentPath),
      packageReportSha256: await hash(packagePath),
      developmentAcceptance: true, releaseAcceptance: false, paperCompletion: false,
      testedTarget: packages.testedTarget, nativeTarget: packages.nativeTarget,
      nativeArtifactSha256: packages.nativeArtifactSha256,
      archives: archiveRecords.sort((a, b) => a.name.localeCompare(b.name)),
    },
    deepseekHarness: {
      repository: upstream.url, revision: upstream.revision, tree: upstream.tree,
      archiveSha256: await hash(archive), snapshotSha256: sha256(snapshotBytes),
      sourceDirectory: '.cache/upstream/deepseek-harness',
      snapshotFile: '.cache/upstream/deepseek-harness.snapshot.json',
      unmodified: true,
    },
  };
  const lockPath = path.join(root, 'sources.lock.json');
  if (await exists(lockPath) && !refresh) assert.deepEqual(candidate, await json(lockPath), 'Snapshot differs from sources.lock.json; review the change before using --refresh-lock');
  const destination = path.join(cache, 'deepseek-harness');
  await rm(destination, { recursive: true, force: true });
  await rename(stage, destination);
  await rename(archive, path.join(cache, 'deepseek-harness.tar'));
  await writeFile(path.join(cache, 'deepseek-harness.snapshot.json'), snapshotBytes);
  const vendor = path.join(root, '.vendor/cordis');
  await mkdir(path.join(vendor, 'provenance'), { recursive: true });
  for (const item of archiveRecords) await copyFile(path.join(source, 'target/release-artifacts/npm', path.basename(item.file)), path.join(root, item.file));
  await copyFile(developmentPath, path.join(vendor, 'provenance/development-report.json'));
  await copyFile(packagePath, path.join(vendor, 'provenance/package-report.json'));
  await writeFile(lockPath, JSON.stringify(candidate, null, 2) + '\n');
  await mkdir(path.join(root, 'third-party'), { recursive: true });
  await copyFile(path.join(destination, 'LICENSE'), path.join(root, 'third-party/DeepSeek-Harness.LICENSE'));
  await copyFile(path.join(source, 'LICENSE'), path.join(root, 'third-party/Cordis-Verus.LICENSE'));
  await copyFile(path.join(source, 'NOTICE'), path.join(root, 'third-party/Cordis-Verus.NOTICE'));
  console.log(`Pinned runtime working-tree fingerprint ${candidate.cordis.sourceFingerprint.slice(0, 16)} and unchanged Harness ${upstream.revision.slice(0, 12)}.`);
} finally {
  await rm(stage, { recursive: true, force: true });
  await rm(archive, { force: true });
}
if (install) {
  await installArtifacts({ root, archives: archiveRecords, refresh, offline });
  // Lock integrity validates the tarballs; this separately validates every
  // installed runtime byte and the native artifact against the source report.
  run(process.execPath, ['scripts/verify-install.mjs', '--installed-only'], root);
}
