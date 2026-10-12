#!/usr/bin/env node
import assert from 'node:assert/strict';
import { verifyCoreReview } from './core-review.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const digest = value => createHash('sha256').update(value).digest('hex');
export const sha256 = async file => digest(await readFile(file));
export const json = async file => JSON.parse(await readFile(file, 'utf8'));
export const saveJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

export function relativeFile(name) {
  assert(typeof name === 'string' && name.length > 0 && !/[\\:\x00-\x1f]/.test(name)
    && !path.posix.isAbsolute(name) && name.split('/').every(part => part && part !== '.' && part !== '..'),
  `Nonlocal evidence path: ${name}`);
  return name;
}

export async function regularFiles(root, directories, fixed = []) {
  const files = fixed.map(relativeFile);
  async function visit(name) {
    const stat = await lstat(path.join(root, relativeFile(name)));
    assert(!stat.isSymbolicLink(), `Evidence must not contain symlinks: ${name}`);
    if (stat.isDirectory()) {
      for (const child of (await readdir(path.join(root, name))).sort()) await visit(`${name}/${child}`);
    } else { assert(stat.isFile(), `Evidence must be a regular file: ${name}`); files.push(name); }
  }
  for (const directory of directories) await visit(directory);
  return [...new Set(files)].sort();
}

export async function hashFiles(root, names) {
  const hashes = {};
  for (const name of [...new Set(names)].sort()) {
    relativeFile(name);
    // Check ancestors as well as the leaf before reading anything outside root.
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const stat = await lstat(path.join(root, ...parts.slice(0, i)));
      assert(i === parts.length ? stat.isFile() : stat.isDirectory(), `Nonregular evidence path: ${name}`);
    }
    hashes[name] = await sha256(path.join(root, name));
  }
  return hashes;
}

export async function outputDirectory(root, kind, requested) {
  if (requested) {
    const directory = path.resolve(requested);
    await mkdir(directory, { recursive: true });
    assert.deepEqual(await readdir(directory), [], 'Use a new empty output directory');
    return directory;
  }
  const parent = path.join(root, '.cordis-harness', kind);
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, 'run-'));
}

export function runCommand(root, command, args, { timeout = 120000 } = {}) {
  // Do not inherit model credentials, Node injection hooks or native overrides.
  // npm may use its normal user cache; the report states whether --offline was used.
  const env = Object.fromEntries(['HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
    .filter(name => process.env[name]).map(name => [name, process.env[name]]));
  env.PATH = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)
    .filter(entry => entry && !entry.includes('node_modules') && !path.resolve(entry).startsWith(path.resolve(projectRoot) + path.sep))]
    .join(path.delimiter);
  env.COPYFILE_DISABLE = '1';
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  return { command, args, status: result.status, signal: result.signal, error: result.error?.message,
    stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
export function requireSuccess(run) {
  assert.equal(run.error, undefined, run.error);
  assert.equal(run.status, 0, `${run.command} ${run.args.join(' ')}\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.signal, null);
  return run;
}

export async function verifyRecoveryBundle(root) {
  assert((await lstat(path.join(root, 'recovery-bundle.json'))).isFile(), 'Bundle manifest must be a regular file');
  const manifest = await json(path.join(root, 'recovery-bundle.json'));
  assert.equal(manifest.schema, 'cordis-harness.recovery-bundle/v1');
  assert.equal(manifest.environment.platform, process.platform, 'Bundle is for another operating system');
  assert.equal(manifest.environment.architecture, process.arch, 'Bundle is for another architecture');
  const names = Object.keys(manifest.files);
  for (const name of names) {
    relativeFile(name);
    assert(!['node_modules', '.cordis-harness', 'recovery-bundle.json'].includes(name.split('/')[0]), `Invalid bundle input: ${name}`);
    assert.match(manifest.files[name], /^[a-f0-9]{64}$/, `Invalid file hash: ${name}`);
  }
  for (const name of ['package.json', 'package-lock.json', 'sources.lock.json', 'dist/build-report.json',
    'src/app.mjs', 'src/plugin-manager.mjs', 'src/recovery-case.mjs', 'src/recovery-contract.mjs',
    'examples/recovery/file-journal.mjs', 'examples/recovery/wait-probe.mjs', 'scripts/core-review.mjs',
    'scripts/run-recovery-case.mjs', 'scripts/recovery-evidence.mjs', 'scripts/verify-install.mjs']) {
    assert(manifest.files[name], `Incomplete recovery bundle: ${name}`);
  }
  const entries = (await readdir(root)).filter(name => !['node_modules', '.cordis-harness', 'recovery-bundle.json'].includes(name));
  assert.deepEqual(await regularFiles(root, entries), names.sort(), 'Bundle contains missing or unrecorded files');
  assert.deepEqual(await hashFiles(root, names), manifest.files, 'Recovery bundle content changed');
  const lock = await json(path.join(root, 'sources.lock.json'));
  await verifyCoreReview(root, lock);
  for (const item of lock.cordis.archives) assert.equal(manifest.files[item.file], item.sha256, `Runtime archive is not bound: ${item.name}`);
  const build = await json(path.join(root, 'dist/build-report.json'));
  for (const [name, hash] of Object.entries({ ...build.inputs, ...build.outputs })) {
    relativeFile(name);
    if (!name.startsWith('node_modules/')) assert.equal(manifest.files[name], hash, `Unbound build file: ${name}`);
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/recovery-evidence.mjs');
  const manifest = await verifyRecoveryBundle(projectRoot);
  console.log(`Verified ${Object.keys(manifest.files).length} bundled files. Hash consistency only; this is not a signature or a new Verus run.`);
}
