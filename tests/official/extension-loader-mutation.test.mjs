import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';

// The normal gate uses the installed native facade. An explicit Node preload
// also permits a development-source run before repackaging; it must still expose
// the native snapshot API below. No official implementation is copied here.
if (!process.execArgv.some(arg => arg === '--import' || arg.startsWith('--import='))) {
  await import('../../scripts/official-register.mjs');
}
const { Context } = await import('@deepseek-ai/cordis');
const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader');
const { default: Include } = await import('@deepseek-ai/cordis-plugin-include');

test('official Include patches await child withdrawal and allow reactivation', { timeout: 15000 }, async () => {
  assert.equal(typeof Context.prototype.snapshot, 'function', 'This regression requires the native facade');
  const directory = await mkdtemp(join(tmpdir(), 'cordis-include-mutation-'));
  const filename = join(directory, 'plugins.json');
  const path = pathToFileURL(filename).href;
  const ctx = new Context();
  const registrations = new Set();
  let activations = 0;
  let cleanups = 0;
  try {
    await writeFile(filename, JSON.stringify([{ id: 'probe', name: 'cordis:mutation-probe' }]));
    await ctx.plugin(Loader);
    ctx.loader.builtins.include = Include;
    // Only the leaf is a test fixture. The real Include reads and patches its
    // JSON file, and the real Loader invokes the actual child Fiber lifecycle.
    ctx.loader.builtins['mutation-probe'] = {
      name: 'mutation-probe',
      apply(child) {
        const token = ++activations;
        child.effect(() => {
          registrations.add(token);
          return async () => {
            await nextTurn();
            registrations.delete(token);
            cleanups++;
          };
        });
      },
    };
    await ctx.loader.root.update([{ id: 'include', name: 'cordis:include', config: { path, patches: [] } }]);
    await ctx.loader.await();
    const include = ctx.loader.resolve('include');
    const initial = ctx.loader.resolve('include:probe').fiber;
    await initial.await();
    assert.deepEqual([...registrations], [1]);
    assert.equal(initial.state, 2);

    async function patch(disabled) {
      // Match the app-boot reconciliation boundary: update the Include entry,
      // await pre-existing Fibers, then drain all official Loader tasks.
      const previous = [...ctx.loader.entries()].map(entry => entry.fiber).filter(Boolean);
      await include.update({ config: { path, patches: [{ id: 'probe', disabled }] } });
      await Promise.all(previous.map(fiber => fiber.await()));
      await ctx.loader.await();
    }

    await patch(true);
    assert.equal(ctx.loader.resolve('include:probe').disabled, true);
    assert.equal(cleanups, 1, 'Disabled options alone must not masquerade as a completed withdrawal');
    assert.equal(registrations.size, 0, 'The asynchronous registration inverse must finish before reconciliation returns');
    assert.equal(initial.uid, null);
    assert(!ctx.snapshot().plugins.some(plugin => String(plugin.id) === String(initial.id)));

    await patch(false);
    const resumed = ctx.loader.resolve('include:probe').fiber;
    await resumed.await();
    assert.equal(ctx.loader.resolve('include:probe').disabled, false);
    assert.notEqual(resumed, initial);
    assert.equal(resumed.state, 2);
    assert.deepEqual([...registrations], [2]);
    assert.equal(cleanups, 1);
  } finally {
    try { await ctx.dispose(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  assert.equal(registrations.size, 0);
  assert.equal(cleanups, activations);
  assert.equal(ctx.snapshot().plugins.length, 0);
});
