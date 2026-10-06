import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createNativeBuildWatcher } from '../src/native-build-watch.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'cordis-native-watch-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src', 'lib.rs'), 'v1');
  return cwd;
}
function make(t, cwd, overrides = {}) {
  const watcher = createNativeBuildWatcher({ cwd, watchPaths: ['src'], intervalMs: 10,
    build: async () => 'artifact', apply: async () => {}, ...overrides });
  t.after(() => watcher.close());
  return watcher;
}
async function until(predicate, description) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.fail(`Timed out: ${description}`);
}

test('start builds once, polls content changes, and keeps only bounded immutable diagnostics', async t => {
  const cwd = await fixture(t);
  let generation = 0;
  const watcher = make(t, cwd, { apply: async () => { generation++; } });
  assert.equal((await watcher.start()).status, 'completed');
  assert.equal(generation, 1);
  await delay(35);
  assert.equal(watcher.snapshot().attempts, 1);
  await writeFile(join(cwd, 'src', 'lib.rs'), 'v2');
  await until(() => generation === 2, 'second source generation');
  const state = watcher.snapshot();
  assert.equal(state.observedFingerprint, state.appliedFingerprint);
  assert.equal(state.appliedCount, 2);
  assert(Object.isFrozen(state));
  assert(Object.isFrozen(state.lastOutcome));
  assert.equal(await watcher.start(), await watcher.start());
});

test('nested source changes are observed; target and .git subtrees do not rebuild', async t => {
  const cwd = await fixture(t);
  await mkdir(join(cwd, 'src', 'nested'));
  await mkdir(join(cwd, 'src', 'target'));
  await mkdir(join(cwd, 'src', '.git'));
  const watcher = make(t, cwd);
  await watcher.start();
  await writeFile(join(cwd, 'src', 'target', 'artifact'), 'compiled');
  await writeFile(join(cwd, 'src', '.git', 'index'), 'index');
  await delay(40);
  assert.equal(watcher.snapshot().attempts, 1);
  await writeFile(join(cwd, 'src', 'nested', 'module.rs'), 'changed');
  await until(() => watcher.snapshot().appliedCount === 2, 'nested file build');
});

test('source changes during a build discard the candidate and coalesce into one newer build', async t => {
  const cwd = await fixture(t);
  const entered = deferred(), release = deferred();
  const events = [], applied = [];
  let builds = 0;
  const watcher = make(t, cwd, {
    build: async () => { const value = await readFile(join(cwd, 'src', 'lib.rs'), 'utf8'); if (++builds === 1) { entered.resolve(); await release.promise; } return value; },
    apply: async ({ buildResult }) => { applied.push(buildResult); },
    onEvent: event => events.push(event),
  });
  const started = watcher.start();
  await entered.promise;
  await writeFile(join(cwd, 'src', 'lib.rs'), 'v2');
  await writeFile(join(cwd, 'src', 'lib.rs'), 'v3');
  release.resolve();
  const result = await started;
  assert.equal(result.status, 'completed');
  assert.equal(result.superseded, 1);
  assert.equal(builds, 2);
  assert.deepEqual(applied, ['v3']);
  assert(events.some(event => event.status === 'superseded'));
});

test('failed builds preserve the applied generation and recover on the next source change', async t => {
  const cwd = await fixture(t);
  let installed;
  const watcher = make(t, cwd, {
    build: async () => { const value = await readFile(join(cwd, 'src', 'lib.rs'), 'utf8'); if (value === 'bad') throw new Error('x'.repeat(10000)); return value; },
    apply: async ({ buildResult }) => { installed = buildResult; },
  });
  await watcher.start();
  await writeFile(join(cwd, 'src', 'lib.rs'), 'bad');
  const failed = await watcher.buildNow();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.phase, 'build');
  assert.equal(installed, 'v1');
  assert.equal(watcher.snapshot().lastFailure.message.length, 2048);
  const count = watcher.snapshot().attempts;
  await delay(35);
  assert.equal(watcher.snapshot().attempts, count, 'unchanged failed source is not rebuilt in a tight loop');
  await writeFile(join(cwd, 'src', 'lib.rs'), 'fixed');
  await until(() => installed === 'fixed', 'recovery after correction');
  assert.equal(watcher.snapshot().lastFailure, null);
});

test('apply failure is reported without uncontrolled retries and explicit buildNow retries it', async t => {
  const cwd = await fixture(t);
  let fail = true;
  const watcher = make(t, cwd, { apply: async () => { if (fail) throw new Error('candidate rejected by verifier'); } });
  const result = await watcher.start();
  assert.equal(result.status, 'failed');
  assert.equal(result.phase, 'apply');
  await delay(35);
  assert.equal(watcher.snapshot().attempts, 1);
  fail = false;
  assert.equal((await watcher.buildNow()).status, 'completed');
  assert.equal(watcher.snapshot().appliedCount, 1);
});

test('concurrent forced requests coalesce while builds and applies stay serialized', async t => {
  const cwd = await fixture(t);
  const entered = deferred(), release = deferred();
  let concurrent = 0, highest = 0, builds = 0;
  const watcher = make(t, cwd, {
    build: async () => {
      highest = Math.max(highest, ++concurrent);
      if (++builds === 1) { entered.resolve(); await release.promise; }
      await delay(1); concurrent--; return builds;
    },
    apply: async () => { highest = Math.max(highest, ++concurrent); await delay(3); concurrent--; },
  });
  const first = watcher.buildNow();
  await entered.promise;
  const second = watcher.buildNow();
  const third = watcher.buildNow();
  release.resolve();
  assert((await Promise.all([first, second, third])).every(result => result.status === 'completed'));
  assert.equal(builds, 2);
  assert.equal(highest, 1);
});

test('close during a build drains it and never applies its candidate', async t => {
  const cwd = await fixture(t);
  const entered = deferred(), release = deferred();
  let applied = 0, stopped = false;
  const watcher = make(t, cwd, { build: async () => { entered.resolve(); await release.promise; }, apply: async () => { applied++; } });
  const started = watcher.start();
  await entered.promise;
  const closing = watcher.close().then(() => { stopped = true; });
  await delay(10);
  assert.equal(stopped, false);
  release.resolve();
  await closing;
  assert.equal((await started).status, 'closed');
  assert.equal(applied, 0);
  assert.equal(watcher.snapshot().closed, true);
  assert.equal((await watcher.buildNow()).status, 'closed');
});

test('close waits for an apply that already began', async t => {
  const cwd = await fixture(t);
  const entered = deferred(), release = deferred();
  let stopped = false;
  const watcher = make(t, cwd, { apply: async () => { entered.resolve(); await release.promise; } });
  const started = watcher.start();
  await entered.promise;
  const closing = watcher.close().then(() => { stopped = true; });
  await delay(10);
  assert.equal(stopped, false);
  release.resolve();
  await closing;
  await started;
  assert.equal(watcher.snapshot().appliedCount, 1);
  assert.equal(watcher.snapshot().phase, 'closed');
});

test('sync and async observer failures are contained without changing build success', async t => {
  const cwd = await fixture(t);
  let events = 0;
  const watcher = make(t, cwd, { onEvent: () => { if (++events === 1) throw new Error('sync observer'); return Promise.reject(new Error('async observer')); } });
  assert.equal((await watcher.buildNow()).status, 'completed');
  assert.equal(watcher.snapshot().observerFailure.message, 'sync observer');
  assert.equal((await watcher.buildNow()).status, 'completed');
  await delay(0);
  assert.equal(watcher.snapshot().observerFailure.message, 'async observer');
});

test('real build command uses cwd and literal argv without shell expansion, with bounded output', async t => {
  const cwd = await fixture(t);
  const argument = '$(touch should-not-exist); quoted spaces';
  const watcher = createNativeBuildWatcher({ cwd, watchPaths: ['src'], command: { file: process.execPath, args: ['-e',
    "require('fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(1))); process.stdout.write('x'.repeat(100000)); process.stderr.write('y'.repeat(100000));", argument] },
    apply: async ({ buildResult }) => { assert.equal(buildResult.code, 0); assert.equal(buildResult.stdout.length, 16384); assert.equal(buildResult.stderr.length, 16384); } });
  t.after(() => watcher.close());
  assert.equal((await watcher.buildNow()).status, 'completed');
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'argv.json'), 'utf8')), [argument]);
  await assert.rejects(readFile(join(cwd, 'should-not-exist')), { code: 'ENOENT' });
});

test('a nonzero command exit and a missing executable both prevent apply', async t => {
  const cwd = await fixture(t);
  for (const command of [{ file: process.execPath, args: ['-e', "process.stderr.write('compile error'); process.exit(4)"] }, { file: join(cwd, 'missing-compiler'), args: [] }]) {
    let applied = false;
    const watcher = createNativeBuildWatcher({ cwd, watchPaths: ['src'], command, apply: async () => { applied = true; } });
    t.after(() => watcher.close());
    const result = await watcher.buildNow();
    assert.equal(result.status, 'failed');
    assert.equal(result.phase, 'build');
    assert.equal(applied, false);
    assert.equal(watcher.snapshot().appliedCount, 0);
  }
});

test('missing explicit source paths and symlink identity are fingerprinted without following links', async t => {
  const cwd = await fixture(t);
  const external = join(cwd, 'external.rs');
  await writeFile(external, 'outside explicit roots');
  await symlink(external, join(cwd, 'src', 'external-link'));
  const watcher = make(t, cwd, { watchPaths: ['src', 'optional.rs'] });
  await watcher.start();
  await writeFile(external, 'outside edits do not traverse the symlink');
  await delay(35);
  assert.equal(watcher.snapshot().attempts, 1);
  await writeFile(join(cwd, 'optional.rs'), 'new source');
  await until(() => watcher.snapshot().appliedCount === 2, 'new explicit source');
  await rm(join(cwd, 'optional.rs'));
  await until(() => watcher.snapshot().appliedCount === 3, 'removed explicit source');
});

test('required host authority and command arguments are validated before starting work', () => {
  const base = { cwd: '/tmp', watchPaths: ['src'], build: async () => {}, apply: async () => {} };
  assert.throws(() => createNativeBuildWatcher({ ...base, cwd: undefined }), /explicit build cwd/);
  assert.throws(() => createNativeBuildWatcher({ ...base, watchPaths: [] }), /watchPaths/);
  assert.throws(() => createNativeBuildWatcher({ ...base, apply: undefined }), /apply callback/);
  assert.throws(() => createNativeBuildWatcher({ ...base, command: { file: 'node' } }), /exactly one/);
  assert.throws(() => createNativeBuildWatcher({ ...base, build: undefined, command: { file: 'node', args: ['ok', 1] } }), /args/);
});

test('source edits during apply wait for it to settle before building the next generation', async t => {
  const cwd = await fixture(t);
  const entered = deferred(), release = deferred();
  const sequence = [];
  let applies = 0;
  const watcher = make(t, cwd, {
    build: async () => { const value = await readFile(join(cwd, 'src', 'lib.rs'), 'utf8'); sequence.push(`build:${value}`); return value; },
    apply: async ({ buildResult }) => {
      sequence.push(`apply:${buildResult}`);
      if (++applies === 1) { entered.resolve(); await release.promise; }
      sequence.push(`done:${buildResult}`);
    },
  });
  const started = watcher.start();
  await entered.promise;
  await writeFile(join(cwd, 'src', 'lib.rs'), 'v2');
  await delay(20);
  assert.deepEqual(sequence, ['build:v1', 'apply:v1']);
  release.resolve();
  assert.equal((await started).status, 'completed');
  assert.deepEqual(sequence, ['build:v1', 'apply:v1', 'done:v1', 'build:v2', 'apply:v2', 'done:v2']);
});

test('an actual compiler subprocess leaves host timers responsive', async t => {
  const cwd = await fixture(t);
  let applied = false, ticked = false;
  const watcher = createNativeBuildWatcher({ cwd, watchPaths: ['src'],
    command: { file: process.execPath, args: ['-e', 'setTimeout(() => {}, 80)'] },
    apply: async () => { applied = true; },
  });
  t.after(() => watcher.close());
  const building = watcher.buildNow();
  await delay(10);
  ticked = true;
  assert.equal(applied, false);
  assert.equal((await building).status, 'completed');
  assert.equal(ticked, true);
});
