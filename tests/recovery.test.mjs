import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runRecoveryCase, expectedStages } from '../src/recovery-case.mjs';
import { createRecoveryBundle } from '../scripts/reproduce-recovery.mjs';
import { json, saveJson, verifyRecoveryBundle } from '../scripts/recovery-evidence.mjs';

test('real Harness update retains the file provider, settles failure, then recovers on the first explicit retry', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'harness-recovery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await runRecoveryCase({ directory });
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.stages.map(stage => stage.name), expectedStages);
  const failed = report.stages.find(stage => stage.name === 'update-failed');
  assert.match(JSON.stringify(failed.error), /EISDIR/);
  const provider = failed.snapshot.plugins.find(node => node.id === failed.provider);
  assert(provider.blockers.some(blocker => blocker.code === 'CommittedConsumers'
    && blocker.consumers.some(item => item.id === failed.consumer && item.generation === failed.generation)));
  assert.equal(report.stages.find(stage => stage.name === 'retry-succeeded').cleanupAttempts, 2);
  assert.equal(report.stages.find(stage => stage.name === 'retry-succeeded').oneShotReleases, 1);
  assert.deepEqual((await json(path.join(directory, 'report.json'))).stages, report.stages);
  assert.deepEqual(await json(path.join(directory, 'checkpoint-v1.json')), { version: 'v1', flushed: true });
  assert.deepEqual(await json(path.join(directory, 'checkpoint-v2.json')), { version: 'v2', flushed: true });
});

test('portable review bundle binds the real case, source closure and runtime tarballs', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'harness-recovery-bundle-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { project } = await createRecoveryBundle({ directory: path.join(temporary, 'package') });
  const manifest = await verifyRecoveryBundle(project);
  assert(!Object.keys(manifest.files).some(name => name.startsWith('node_modules/')));
  assert(manifest.files['.cache/upstream/deepseek-harness/packages/core/agent-loop/src/index.ts']);

  await t.test('rejects a changed cleanup plugin', async () => {
    const file = path.join(project, 'examples/recovery/file-journal.mjs');
    const before = await readFile(file);
    try {
      await writeFile(file, Buffer.concat([before, Buffer.from('\n// altered inverse\n')]));
      await assert.rejects(verifyRecoveryBundle(project), /Recovery bundle content changed/);
    } finally { await writeFile(file, before); }
  });
  await t.test('rejects missing native runtime distribution', async () => {
    const file = path.join(project, '.vendor/cordis/cordis-verus-compat-cordis-0.1.0.tgz');
    const before = await readFile(file);
    try { await rm(file); await assert.rejects(verifyRecoveryBundle(project), /missing or unrecorded files/); }
    finally { await writeFile(file, before); }
  });
  await t.test('rejects traversal before following an evidence path', async () => {
    const file = path.join(project, 'recovery-bundle.json');
    const changed = structuredClone(manifest);
    changed.files['../outside'] = '0'.repeat(64);
    try { await saveJson(file, changed); await assert.rejects(verifyRecoveryBundle(project), /Nonlocal evidence path/); }
    finally { await saveJson(file, manifest); }
  });
  await t.test('rejects an unrecorded configuration file', async () => {
    const file = path.join(project, '.npmrc');
    try { await writeFile(file, 'ignore-scripts=false\n'); await assert.rejects(verifyRecoveryBundle(project), /missing or unrecorded files/); }
    finally { await rm(file); }
  });
  await t.test('rejects a source directory replaced with a symlink', async () => {
    const external = path.join(temporary, 'external');
    await mkdir(external);
    await symlink(external, path.join(project, 'injected'), 'dir');
    try { await assert.rejects(verifyRecoveryBundle(project), /must not contain symlinks/); }
    finally { await rm(path.join(project, 'injected')); }
  });
  await verifyRecoveryBundle(project);
});
