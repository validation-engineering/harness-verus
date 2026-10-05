import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function runNpm(root, args, env) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `npm ${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
}

// A local development package may change while its version and file: URL stay
// identical. Never accept the old lock/cache identity for newly approved bytes.
// Callers must still validate the installed file manifest after this returns.
export async function installArtifacts({ root, archives, refresh = false, offline = true, env = process.env }) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert(Array.isArray(archives) && archives.length > 0, 'No pinned runtime archives');
  assert.equal(new Set(archives.map(item => item.name)).size, archives.length, 'Duplicate pinned runtime archive');
  const expected = new Map();
  for (const item of archives) {
    assert(item.file && !path.isAbsolute(item.file) && !item.file.split(/[\\/]/).includes('..'), `Nonlocal artifact path: ${item.file}`);
    assert.equal(manifest.dependencies?.[item.name], `file:${item.file}`, `Manifest does not select pinned artifact: ${item.name}`);
    const location = path.join(root, item.file);
    assert((await lstat(location)).isFile(), `Artifact must be an ordinary file: ${item.file}`);
    const bytes = await readFile(location);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, `Archive differs from approved snapshot: ${item.name}`);
    expected.set(item.name, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  }
  const lockPath = path.join(root, 'package-lock.json');
  let original;
  try { original = await readFile(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function verifyLock() {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    assert.equal(lock.lockfileVersion, 3, 'Expected npm lockfile v3');
    for (const item of archives) {
      const entry = lock.packages?.[`node_modules/${item.name}`];
      assert(entry && !entry.link, `Missing extracted-package lock entry: ${item.name}`);
      assert.equal(entry.version, item.version, `Wrong locked artifact version: ${item.name}`);
      assert.equal(entry.resolved, `file:${item.file}`, `Wrong locked artifact path: ${item.name}`);
      assert.equal(entry.integrity, expected.get(item.name), `Stale artifact integrity: ${item.name}; use --refresh-lock after reviewing the new snapshot`);
      assert.equal(lock.packages[''].dependencies?.[item.name], manifest.dependencies[item.name], `Wrong root artifact dependency: ${item.name}`);
    }
  }
  const common = ['--ignore-scripts', '--no-audit', '--no-fund'];
  if (offline) common.push('--offline');
  if (!original || refresh) {
    try {
      if (original) {
        const lock = JSON.parse(original);
        for (const item of archives) delete lock.packages[`node_modules/${item.name}`];
        await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
      }
      runNpm(root, ['install', '--package-lock-only', ...common], env);
      // Assert the actual new archive identity before trusting npm ci or any
      // existing node_modules/.package-lock.json and content-addressed cache.
      await verifyLock();
    } catch (error) {
      if (original) await writeFile(lockPath, original);
      else await rm(lockPath, { force: true });
      throw error;
    }
  } else await verifyLock();
  runNpm(root, ['ci', ...common], env);
  await verifyLock();
  for (const item of archives) {
    const actual = createHash('sha512').update(await readFile(path.join(root, item.file))).digest('base64');
    assert.equal(`sha512-${actual}`, expected.get(item.name), `Archive changed during installation: ${item.name}`);
  }
}
