#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { approvedArchives, checkRuntimeLock, evidencePath, inspectInstallation, json, runtimeNames, runtimeRoot } from './verify-official.mjs';

const flags = new Set(process.argv.slice(2));
assert(flags.size === process.argv.length - 2 && [...flags].every(flag => ['--offline', '--refresh-runtime-lock'].includes(flag)), 'Usage: node scripts/install-official.mjs [--offline] [--refresh-runtime-lock]');
const common = ['--ignore-scripts', '--no-audit', '--no-fund', '--include=optional', '--include=peer'];
if (flags.has('--offline')) common.push('--offline');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(args) {
  const result = spawnSync(npm, args, { cwd: runtimeRoot, stdio: 'inherit', timeout: 180000,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Official npm ${args[0]} failed`);
}
const archives = await approvedArchives();
const lockPath = path.join(runtimeRoot, 'package-lock.json');
const original = await readFile(lockPath);
if (flags.has('--refresh-runtime-lock')) {
  try {
    const prior = JSON.parse(original), next = structuredClone(prior);
    for (const name of runtimeNames) delete next.packages[`node_modules/${name}`];
    await writeFile(lockPath, JSON.stringify(next, null, 2) + '\n');
    run(['install', '--package-lock-only', ...common]);
    const refreshed = await json(lockPath);
    checkRuntimeLock(refreshed, archives);
    // Preserve every registry resolution and all unrelated metadata. Refreshing a
    // same-version local tarball is not authorization to upgrade official plugins.
    for (const name of runtimeNames) {
      delete prior.packages[`node_modules/${name}`];
      delete refreshed.packages[`node_modules/${name}`];
    }
    assert.deepEqual(refreshed, prior, 'Runtime lock refresh changed another dependency; restoring the previous lock');
  } catch (error) {
    await writeFile(lockPath, original);
    throw error;
  }
} else checkRuntimeLock(JSON.parse(original), archives);
const frozenLock = await readFile(lockPath);
await rm(evidencePath, { force: true });
run(['ci', ...common]);
assert.deepEqual(await readFile(lockPath), frozenLock, 'npm ci changed the approved lock');
const manifest = await inspectInstallation();
await mkdir(path.dirname(evidencePath), { recursive: true });
const temporary = `${evidencePath}.${process.pid}.tmp`;
try {
  await writeFile(temporary, JSON.stringify({ installedAt: new Date().toISOString(), command: ['npm', 'ci', ...common], ...manifest }, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, evidencePath);
} finally { await rm(temporary, { force: true }); }
console.log(`Installed official dsh ${manifest.officialVersion}; recorded ${Object.keys(manifest.files).length} files and verified the approved Cordis runtime. No application was started.`);
