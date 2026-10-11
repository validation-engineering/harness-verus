#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmCommand } from './npm-command.mjs';
import { runtimeDirectories } from './runtime-packages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--core-release', 'Usage: package-release.mjs --core-release DIRECTORY');
const coreRoot = resolve(args[1]);
const sources = await json(join(root, 'sources.lock.json'));
const registry = await json(join(coreRoot, 'npm-registry.json'));
assert.equal(registry.schema, 'cordis-verus.npm-registry/v1');
assert.equal(registry.sourceCommit, sources.cordis.baseCommit, 'Core release must match the imported source commit');
assert.equal(sources.cordis.workingTreeDirty, false, 'Import a committed core snapshot before packaging');
const names = Object.keys(runtimeDirectories).sort();
assert.deepEqual(registry.packages.map(item => item.name).sort(), names);
const targets = ['darwin-arm64-napi8', 'darwin-x64-napi8', 'linux-x64-gnu-napi8', 'win32-x64-napi8'];
assert.deepEqual(Object.keys(registry.targets).sort(), targets);
assert.match(registry.nativeManifestSha256, /^[a-f0-9]{64}$/);
for (const target of targets) {
  const receipt = await json(join(coreRoot, `npm-installation-${target}.json`));
  assert.equal(receipt.target, target);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.offlineReinstall, 'passed');
  assert.equal(receipt.sourceCommit, registry.sourceCommit);
  assert.equal(receipt.nativeManifestSha256, registry.nativeManifestSha256);
  assert.deepEqual(receipt.packages, registry.packages);
}
for (const item of registry.packages) {
  assert.equal(basename(item.file), item.file);
  const bytes = await readFile(join(coreRoot, item.file));
  assert.equal(bytes.length, item.bytes);
  assert.equal(digest(bytes), item.sha256);
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, item.integrity);
}
run(process.execPath, ['scripts/record-official-validation.mjs', '--check']);
run(process.execPath, ['scripts/record-validation.mjs', '--check']);
assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all']), '', 'Commit the validated application snapshot before packaging');
const sourceCommit = run('git', ['rev-parse', 'HEAD']);
const official = await json(join(root, 'docs/official-validation-report.json'));
const compact = await json(join(root, 'docs/validation-report.json'));
const build = await json(join(root, 'dist/build-report.json'));
const manifest = await json(join(root, 'package.json'));
const local = await json(join(root, '.vendor/cordis/provenance/package-report.json'));
const runtime = { sourceCommit: registry.sourceCommit, nativeManifestSha256: registry.nativeManifestSha256, packages: {} };
for (const item of registry.packages) {
  assert.equal(local.packages.find(entry => entry.name === item.name)?.version, item.version);
  const directory = runtimeDirectories[item.name];
  const files = {};
  for (const file of local.packages.find(entry => entry.name === item.name).files) {
    if (file.startsWith('native/')) continue; // Universal native manifest is checked separately.
    const expected = local.sourceHashes[`packages/${directory}/${file}`] ?? local.sourceHashes[file];
    assert.match(expected ?? '', /^[a-f0-9]{64}$/);
    files[file] = expected;
  }
  runtime.packages[item.name] = { version: item.version, files };
  manifest.dependencies[item.name] = item.version;
}
delete manifest.private;
delete manifest.devDependencies;
manifest.publishConfig = { access: 'public', registry: 'https://registry.npmjs.org/' };
manifest.scripts = { start: 'node bin/harness-verus.mjs', demo: 'node bin/harness-verus.mjs demo' };
const include = ['bin', 'src', 'plugins', 'examples', 'dist', 'third-party', 'harness.config.json',
  'scripts/official.mjs', 'scripts/official-register.mjs', 'scripts/verify-published.mjs',
  'LICENSE', 'NOTICE', 'README.md', 'README.zh-CN.md'];
manifest.files = [...include, 'release-manifest.json'];
const lock = await json(join(root, 'package-lock.json'));
lock.packages[''] = { name: manifest.name, version: manifest.version, license: manifest.license,
  dependencies: manifest.dependencies, bin: manifest.bin, engines: manifest.engines };
for (const [key, entry] of Object.entries(lock.packages)) if (key && entry.dev === true) delete lock.packages[key];
for (const item of registry.packages) {
  const entry = lock.packages[`node_modules/${item.name}`];
  assert.equal(entry.version, item.version);
  entry.resolved = `https://registry.npmjs.org/${item.name}/-/${item.name.split('/')[1]}-${item.version}.tgz`;
  entry.integrity = item.integrity;
}
assert(!JSON.stringify(lock).includes('file:'), 'Published shrinkwrap cannot refer to local tarballs');
const stage = await mkdtemp(join(tmpdir(), 'harness-release-package-'));
const output = join(root, 'target/npm-release');
await mkdir(output, { recursive: true });
try {
  // Copy only recorded source/build files. Ignored local files (including user
  // configuration or credentials inside an example directory) never enter npm.
  const inputs = { ...official.sourceHashes, ...build.outputs,
    'dist/build-report.json': compact.buildReportSha256 };
  for (const [name, expected] of Object.entries(inputs)) {
    if (!include.some(entry => name === entry || name.startsWith(entry + '/'))) continue;
    assert(!name.split(/[\\/]/).some(part => !part || part === '..' || part === '.'), `Unsafe release input: ${name}`);
    const source = join(root, name);
    assert((await lstat(source)).isFile(), `Release input must be a regular file: ${name}`);
    assert.equal(digest(await readFile(source)), expected, `Release source changed: ${name}`);
    await mkdir(dirname(join(stage, name)), { recursive: true });
    await cp(source, join(stage, name));
    assert.equal(digest(await readFile(join(stage, name))), expected, `Release source changed during copy: ${name}`);
  }
  await save(join(stage, 'package.json'), manifest);
  await save(join(stage, 'npm-shrinkwrap.json'), lock);
  const files = {};
  async function visit(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const file = join(directory, name), relative = prefix + name, stat = await lstat(file);
      assert(!stat.isSymbolicLink(), `Linked release input: ${relative}`);
      if (stat.isDirectory()) await visit(file, relative + '/');
      else { assert(stat.isFile()); files[relative] = digest(await readFile(file)); }
    }
  }
  await visit(stage);
  const release = { schema: 'harness-verus.release/v1', name: manifest.name, version: manifest.version,
    sourceCommit, officialVersion: manifest.dependencies['@deepseek-ai/dsh'], runtime, files,
    evidence: { officialSourceFingerprint: official.sourceFingerprint, compactSourceFingerprint: compact.sourceFingerprint,
      environment: official.environment, paidModelRequests: false,
      applicationInstallation: 'pending; check-release.mjs records the exact installed archive separately',
      hostCallbacksFormallyVerified: false } };
  await save(join(stage, 'release-manifest.json'), release);
  const [npm, ...prefix] = npmCommand();
  const [packed] = JSON.parse(run(npm, [...prefix, 'pack', '--json', '--ignore-scripts', '--pack-destination', output], stage));
  assert.deepEqual(packed.files.map(entry => entry.path).sort(), [...Object.keys(files), 'release-manifest.json'].sort(), 'npm changed the intended file set');
  const archive = await readFile(join(output, packed.filename));
  const candidate = { schema: 'harness-verus.npm-candidate/v1', name: manifest.name, version: manifest.version,
    file: packed.filename, sha256: digest(archive), integrity: packed.integrity, bytes: archive.length,
    sourceCommit, coreCommit: registry.sourceCommit, acceptedCoreTargets: targets,
    applicationInstallation: 'pending', compilerRequiredByConsumer: false };
  assert.equal(run('git', ['rev-parse', 'HEAD']), sourceCommit, 'Application commit changed during packaging');
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=all']), '', 'Application source changed during packaging');
  await save(join(output, 'candidate.json'), candidate);
  console.log(JSON.stringify(candidate, null, 2));
} finally { await rm(stage, { recursive: true, force: true }); }
