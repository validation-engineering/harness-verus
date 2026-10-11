// Trusted, repository-owned ProcessDomain adapter. Official package bytes stay intact.
import './official-register.mjs';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createHost({ directory, entry }) {
  const inHostScope = AsyncLocalStorage.snapshot();
  const roots = new Set();
  let profile, overlayDirectory, startupError, bootAttempted = false, closing;
  const inside = path => { const rel = relative(directory, path); return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  const ready = (async () => {
    const recipe = JSON.parse(await readFile(resolve(directory, entry), 'utf8'));
    assert.equal(recipe.schemaVersion, 1, 'harness.json needs schemaVersion: 1');
    assert.deepEqual(Object.keys(recipe).sort(), ['plugins', 'schemaVersion']);
    assert(Array.isArray(recipe.plugins), 'harness.json plugins must be an array');
    const ids = new Set();
    const rows = [];
    for (const item of recipe.plugins) {
      assert(item && typeof item === 'object' && !Array.isArray(item));
      assert(Object.keys(item).every(key => ['id', 'name', 'config'].includes(key)), 'Plugin fields are id, name and config');
      assert(typeof item.id === 'string' && /^[a-z][a-z0-9-]*$/.test(item.id) && !ids.has(item.id), 'Plugin IDs must be unique lowercase names');
      ids.add(item.id);
      assert(typeof item.name === 'string' && item.name.startsWith('./'), 'Plugin names must be relative ./ paths within the captured bundle');
      const module = resolve(directory, item.name);
      assert(inside(module) && (await stat(module)).isFile(), 'Plugin entry must be a file within the captured bundle');
      rows.push({ ...item, name: pathToFileURL(module).href });
    }
    const { RegistryService } = await import('@validation-engineering/cordis-compat-deepseek');
    const original = RegistryService.prototype.plugin;
    RegistryService.prototype.plugin = function (...args) {
      roots.add(this.ctx.root);
      return Reflect.apply(original, this, args);
    };
    const [{ runProfile }, { loadLayeredEnv }] = await Promise.all([
      import('@deepseek-ai/dsh/lib/profile-boot.js'),
      import('@deepseek-ai/dsh-app-boot'),
    ]);
    overlayDirectory = await mkdtemp(resolve(tmpdir(), 'cordis-official-overlay-'));
    const overlay = resolve(overlayDirectory, 'plugins.json');
    await writeFile(overlay, JSON.stringify(rows.map(row => ({ insert: [row] }))), { mode: 0o600 });
    const args = JSON.parse(process.env.CORDIS_HARNESS_PROCESS_WEB_ARGS ?? '["--no-open","--port","3080"]');
    assert(Array.isArray(args) && args.every(value => typeof value === 'string'));
    bootAttempted = true;
    profile = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'web', patchFiles: [overlay], args });
    await profile.ctx.loader.await();
    assert.equal(roots.size, 1, 'Official Web must own one native Context graph');
    assert(roots.has(profile.ctx.root));
    const entries = [...profile.ctx.loader.entries()];
    for (const id of ids) assert(entries.some(row => row.options.id === id && row.fiber?.state === 2), `Candidate plugin ${id} did not activate`);
    const inactive = entries.filter(row => !row.disabled && row.fiber?.state !== 2);
    assert.equal(inactive.length, 0, `Enabled Loader entries must be active: ${inactive.map(row => row.id).join(', ')}`);
    assert(profile.ctx.get('webServer')?.port > 0, 'Official Web did not listen');
  })().catch(error => { startupError = error; throw error; });
  ready.catch(() => {});
  function diagnostics() {
    const ctx = profile?.ctx;
    const entries = ctx ? [...ctx.loader.entries()].map(row => ({ id: row.id, name: row.options.name, active: row.fiber?.state === 2, disabled: !!row.disabled })) : [];
    return { pid: process.pid, profile: 'web', rootContexts: roots.size, origin: ctx ? `http://127.0.0.1:${ctx.get('webServer').port}` : null, entries };
  }
  async function close() {
    await ready.catch(() => {});
    if (profile) {
      // This is the official disposer (including proxy cleanup), not a parallel
      // Cordis shutdown. Its failure/timeout exits without our success ack.
      await profile.shutdown.shutdown(0);
    } else if (bootAttempted && startupError instanceof AggregateError) {
      throw new Error('Official startup reported combined startup/cleanup failure', { cause: startupError });
    }
    for (const ctx of roots) {
      assert.equal([...ctx.registry.values()].flatMap(runtime => [...runtime.fibers]).length, 0, 'Official cleanup left registered fibers');
      const snapshot = ctx.snapshot();
      assert(snapshot.plugins.length <= 1 && snapshot.plugins.every(row => row.parent === null && row.state === 'Active' && !row.retired && !row.cleanupFailed && row.pendingAction === null && row.error === null), 'Official cleanup left native resources');
    }
    if (overlayDirectory) await rm(overlayDirectory, { recursive: true, force: true });
  }
  return {
    ready,
    diagnostics: () => inHostScope(diagnostics),
    call(service, method, args) {
      assert(service === 'supervisor' && method === 'status' && args.length === 0, 'Only supervisor.status is exposed over process IPC; use official HTTP APIs for the application');
      return inHostScope(diagnostics);
    },
    close: () => closing ??= inHostScope(close),
  };
}
