import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installArtifacts } from '../scripts/install-artifacts.mjs';
import { npmCommand } from '../scripts/npm-command.mjs';

const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
test('same-version local archives refresh their real npm lock and installed bytes', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'cordis-harness-refresh-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'consumer');
  const vendor = path.join(root, '.vendor/cordis');
  await mkdir(vendor, { recursive: true });
  const env = { ...process.env, npm_config_cache: path.join(temporary, 'npm-cache') };
  for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'CORDIS_NATIVE_BINDING']) delete env[name];
  const names = ['@fixture/core', '@fixture/harness', '@fixture/loader'];
  const archives = names.map(name => ({ name, version: '0.1.0', file: `.vendor/cordis/fixture-${name.split('/').at(-1)}-0.1.0.tgz` }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'same-version-artifact-consumer', version: '0.0.0', private: true,
    dependencies: Object.fromEntries(archives.map(item => [item.name, `file:${item.file}`])),
  }));
  function npm(args, cwd) {
    const [command, ...prefix] = npmCommand(env);
    const result = spawnSync(command, [...prefix, ...args], { cwd, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
  }
  async function pack(generation) {
    for (const item of archives) {
      const source = path.join(temporary, `source-${item.name.split('/').at(-1)}`);
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, 'package.json'), JSON.stringify({
        name: item.name, version: item.version, main: 'index.js',
        ...(item.name === '@fixture/core' ? {} : { peerDependencies: { '@fixture/core': '0.1.0' } }),
      }));
      await writeFile(path.join(source, 'index.js'), `module.exports = ${JSON.stringify(`${item.name}:${generation}`)};\n`);
      await writeFile(path.join(source, 'generation.txt'), generation);
      npm(['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', vendor], source);
      item.sha256 = digest(await readFile(path.join(root, item.file)));
    }
  }
  async function verify(generation) {
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json')));
    for (const item of archives) {
      const expected = `sha512-${digest(await readFile(path.join(root, item.file)), 'sha512', 'base64')}`;
      assert.equal(lock.packages[`node_modules/${item.name}`].integrity, expected);
      assert.equal(await readFile(path.join(root, 'node_modules', item.name, 'generation.txt'), 'utf8'), generation);
      assert.equal(await readFile(path.join(root, 'node_modules', item.name, 'index.js'), 'utf8'), `module.exports = ${JSON.stringify(`${item.name}:${generation}`)};\n`);
    }
    return lock;
  }
  await pack('old');
  await installArtifacts({ root, archives, env });
  const old = await verify('old');
  const originalLock = await readFile(path.join(root, 'package-lock.json'));
  // Preserve the old package paths, semantic versions, extracted installation,
  // hidden lock and npm cache. Only replace the three tarballs in place.
  await pack('new');
  await t.test('rejects replacement bytes without an explicit lock refresh', async () => {
    await assert.rejects(installArtifacts({ root, archives, env }), /Stale artifact integrity/);
    assert.deepEqual(await readFile(path.join(root, 'package-lock.json')), originalLock);
    assert.equal(await readFile(path.join(root, 'node_modules/@fixture/core/generation.txt'), 'utf8'), 'old');
  });
  await t.test('refreshes integrity and installs the new bytes despite old cache and node_modules', async () => {
    await installArtifacts({ root, archives, refresh: true, env });
    const updated = await verify('new');
    for (const item of archives) assert.notEqual(updated.packages[`node_modules/${item.name}`].integrity, old.packages[`node_modules/${item.name}`].integrity);
  });
  await t.test('a subsequent offline clean install keeps the new package bytes', async () => {
    await installArtifacts({ root, archives, env });
    await verify('new');
  });
  await t.test('rejects an archive that differs from the approved snapshot before changing the lock', async () => {
    const before = await readFile(path.join(root, 'package-lock.json'));
    const wrong = archives.map(item => ({ ...item, sha256: '0'.repeat(64) }));
    await assert.rejects(installArtifacts({ root, archives: wrong, refresh: true, env }), /Archive differs from approved snapshot/);
    assert.deepEqual(await readFile(path.join(root, 'package-lock.json')), before);
  });
  await t.test('a failed lock refresh preserves the previous lock instead of recording partial success', async () => {
    // The isolated cache contains only our local fixtures. A missing dependency
    // makes actual npm --offline fail before it can install or run any package.
    const manifestPath = path.join(root, 'package.json');
    const originalManifest = await readFile(manifestPath);
    const changed = JSON.parse(originalManifest);
    changed.dependencies['@cordis-fixture/missing-install-dependency'] = '99.0.0';
    const before = await readFile(path.join(root, 'package-lock.json'));
    try {
      await writeFile(manifestPath, JSON.stringify(changed));
      await assert.rejects(installArtifacts({ root, archives, refresh: true, env }), /ENOTCACHED/);
      assert.deepEqual(await readFile(path.join(root, 'package-lock.json')), before);
      await verify('new');
    } finally { await writeFile(manifestPath, originalManifest); }
  });
});
