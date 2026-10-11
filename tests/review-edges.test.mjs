import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHarness } from '../src/app.mjs';
import { FiberState } from '@validation-engineering/cordis-compat-deepseek';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('reload reports startup plus cleanup failure instead of awaiting an unreachable disposal', async t => {
  const root = await mkdtemp(tmpdir() + '/cordis-review-reload-');
  const marker = `__cordisReview${Date.now()}`;
  globalThis[marker] = { permitCleanup: false };
  await writeFile(root + '/plugin.mjs', `
export const name = 'review-failure';
export function apply(ctx, config) {
  if (config.fail) {
    globalThis[${JSON.stringify(marker)}].fiber = ctx.fiber;
    ctx.effect(() => () => {
      if (!globalThis[${JSON.stringify(marker)}].permitCleanup) throw new Error('review cleanup failed');
    });
    throw new Error('review startup failed');
  }
  ctx.on('review/probe', () => 'active');
}
`);
  const app = await createHarness({ base: root, workspace: root, sessionDirectory: root + '/sessions',
    provider: { type: 'scripted', model: 'demo' },
    plugins: [{ id: 'review', module: './plugin.mjs', config: { fail: false } }],
  });
  let outcome;
  const operation = app.reloadPlugin('review', { fail: true }).then(
    value => { outcome = { value }; }, error => { outcome = { error }; },
  );
  t.after(async () => {
    try {
      const capture = globalThis[marker];
      capture.permitCleanup = true;
      if (capture.fiber && app.ctx.snapshot().plugins.some(node => node.id === capture.fiber.id && node.cleanupFailed)) {
        await capture.fiber.retryCleanup();
      }
      await operation;
      await app.close();
    } finally { delete globalThis[marker]; await rm(root, { recursive: true, force: true }); }
  });
  // Observe the actual cleanup state, then yield after its completion callbacks.
  // The deadline bounds a broken test; it is not application cleanup policy.
  const deadline = Date.now() + 2000;
  while (!outcome && !app.ctx.snapshot().plugins.some(node => node.cleanupFailed) && Date.now() < deadline) await tick();
  await tick();
  assert.ok(outcome?.error, 'reload must reject once startup and inverse failure have been observed');
  const messages = error => [error.message, ...(error instanceof AggregateError ? error.errors.flatMap(messages) : []), ...(error.cause instanceof Error ? [messages(error.cause)] : [])].join(' | ');
  assert.match(messages(outcome.error), /startup failed/);
  assert.match(messages(outcome.error), /cleanup failed/);
  assert.equal(app.plugins().find(entry => entry.id === 'review').cleanupBlocked, true);
  assert.equal(app.ctx.bail('review/probe'), undefined, 'old instance is not restored while newcomer still owns resources');
  await assert.rejects(app.unloadPlugin('review'), /cleanup is blocked/);
  await assert.rejects(app.retryPluginCleanup('review'), /cleanup|executor/i);
  assert.equal(app.plugins().find(entry => entry.id === 'review').cleanupBlocked, true);
  globalThis[marker].permitCleanup = true;
  await app.retryPluginCleanup('review');
  assert.equal(app.plugins().some(entry => entry.id === 'review'), false);
  assert.equal(app.ctx.snapshot().plugins.some(node => node.cleanupFailed), false);
  await app.loadPlugin({ id: 'review', module: './plugin.mjs', config: { fail: false } });
  assert.equal(app.ctx.bail('review/probe'), 'active');
});


test('missing services and an ordinary failed startup remove their rejected Fibers', async t => {
  const root = await mkdtemp(tmpdir() + '/cordis-review-startup-');
  const marker = `__cordisStartup${Date.now()}`;
  globalThis[marker] = { cleanup: 0 };
  await writeFile(root + '/pending.mjs', `export const inject=['absent']; export function apply(){throw new Error('must not run')}`);
  await writeFile(root + '/rejected.mjs', `export function apply(ctx){ctx.effect(()=>()=>{globalThis[${JSON.stringify(marker)}].cleanup++});throw new Error('ordinary setup failure')}`);
  const app = await createHarness({ base: root, workspace: root, sessionDirectory: root + '/sessions',
    provider: { type: 'scripted', model: 'demo' }, plugins: [],
  });
  t.after(async () => { try { await app.close(); } finally { delete globalThis[marker]; await rm(root, { recursive: true, force: true }); } });
  const baseline = app.ctx.snapshot().plugins.length;
  await assert.rejects(app.loadPlugin({ id: 'pending', module: './pending.mjs' }), /required services/);
  assert.equal(app.ctx.snapshot().plugins.length, baseline);
  assert.equal(app.plugins().length, 0);
  await assert.rejects(app.loadPlugin({ id: 'rejected', module: './rejected.mjs' }), /ordinary setup failure/);
  assert.equal(globalThis[marker].cleanup, 1);
  assert.equal(app.ctx.snapshot().plugins.length, baseline);
  assert.equal(app.plugins().length, 0);
});


test('an observed disposal error does not quarantine a Fiber that native already removed', async t => {
  const root = await mkdtemp(tmpdir() + '/cordis-review-removed-');
  await writeFile(root + '/plugin.mjs', `export const name='review-removed';export function apply(){}`);
  const app = await createHarness({ base: root, workspace: root, sessionDirectory: root + '/sessions',
    provider: { type: 'scripted', model: 'demo' }, plugins: [],
  });
  let observed = false;
  const stop = app.ctx.on('internal/status', fiber => {
    if (fiber.runtime?.name === 'review-removed' && fiber.state === FiberState.DISPOSED && !observed) {
      observed = true;
      throw new Error('review removal observer failed');
    }
  });
  t.after(async () => { stop(); try { await app.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const baseline = app.ctx.snapshot().plugins.length;
  await app.loadPlugin({ id: 'removable', module: './plugin.mjs' });
  await assert.rejects(app.unloadPlugin('removable'), /cleanup|executor/i);
  assert.equal(observed, true);
  assert.equal(app.ctx.snapshot().plugins.length, baseline, 'native confirms the Fiber was removed');
  assert.equal(app.plugins().some(entry => entry.id === 'removable'), false, 'removed Fibers must not remain as impossible cleanup retries');
  await app.loadPlugin({ id: 'removable', module: './plugin.mjs' });
  await app.unloadPlugin('removable');
});


test('explicit cleanup retry repairs failed owned children before their plugin entry', async t => {
  const root = await mkdtemp(tmpdir() + '/cordis-review-children-');
  const marker = `__cordisChildren${Date.now()}`;
  globalThis[marker] = { permitCleanup: false, attempts: 0 };
  await writeFile(root + '/plugin.mjs', `
export const name = 'review-parent';
export function apply(ctx) {
  globalThis[${JSON.stringify(marker)}].parent = ctx.fiber;
  ctx.plugin({ name: 'review-owned-child', apply(inner) {
    globalThis[${JSON.stringify(marker)}].child = inner.fiber;
    inner.effect(() => () => {
      const state = globalThis[${JSON.stringify(marker)}];
      state.attempts++;
      if (!state.permitCleanup) throw new Error('review child cleanup failed');
    });
  }});
}
`);
  const app = await createHarness({ base: root, workspace: root, sessionDirectory: root + '/sessions',
    provider: { type: 'scripted', model: 'demo' }, plugins: [],
  });
  t.after(async () => {
    try {
      const capture = globalThis[marker];
      capture.permitCleanup = true;
      await app.ctx.settle().catch(() => {});
      for (const fiber of [capture.child, capture.parent]) {
        if (fiber && app.ctx.snapshot().plugins.some(node => node.id === fiber.id && node.cleanupFailed)) await fiber.retryCleanup().catch(() => {});
      }
      await app.close();
    } finally { delete globalThis[marker]; await rm(root, { recursive: true, force: true }); }
  });
  const baseline = app.ctx.snapshot().plugins.length;
  await app.loadPlugin({ id: 'parent', module: './plugin.mjs' });
  await assert.rejects(app.unloadPlugin('parent'), /cleanup|executor/i);
  assert.equal(app.plugins().find(entry => entry.id === 'parent').cleanupBlocked, true);
  await assert.rejects(app.retryPluginCleanup('parent'), /cleanup|executor/i);
  assert.equal(app.plugins().find(entry => entry.id === 'parent').cleanupBlocked, true);
  const beforeRetry = globalThis[marker].attempts;
  globalThis[marker].permitCleanup = true;
  await app.retryPluginCleanup('parent');
  assert.ok(globalThis[marker].attempts > beforeRetry, 'the owned child inverse must really run again');
  assert.equal(app.plugins().length, 0);
  assert.equal(app.ctx.snapshot().plugins.length, baseline);
});
