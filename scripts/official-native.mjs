#!/usr/bin/env node
// The official compositions and business plugins stay unchanged.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyOfficial } from './verify-official.mjs';
import { verifyRustModules } from './verify-rust-modules.mjs';
import { installNativeWatchShutdown } from '../src/native-watch-shutdown.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), watchIndex = args.indexOf('--watch'), watch = watchIndex >= 0;
if (watch) args.splice(watchIndex, 1);
if (args.includes('--help') && watch) {
  console.log('Usage: npm run official:rust:watch -- [web] [--port 3080] [--no-open]\nRuns the official Web/standard app with a native Rust tool. Builds source changes offline, then persists verified updates through ConfigEditor.');
} else {
  await verifyOfficial();
  const { published } = await verifyRustModules();
  await import('./official-register.mjs');
  process.env.DSH_HOME ??= resolve(root, '.cordis-harness/official-native');
  const { initProfile, PROFILE_TEMPLATES, loadLayeredEnv, loadProfileDirectory, composeEntries, readProfilePatches, loadOverlayPatches } = await import('../official-runtime/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
  const profiles = resolve(process.env.DSH_HOME, 'profiles');
  await mkdir(profiles, { recursive: true });
  for (const profile of ['web', 'headless']) {
    const directory = resolve(profiles, profile);
    try { await mkdir(directory); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    initProfile(directory, PROFILE_TEMPLATES[profile].bundles);
    await writeFile(resolve(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'rust-module', name: 'cordis:rust-module', config: published.v1.config },
      { id: 'rust-dynamic-tool', name: pathToFileURL(resolve(root, 'examples/official/rust-dynamic-text-analysis.mjs')).href },
    ] }], null, 2) + '\n', { mode: 0o600 });
  }
  // Inspect only the profile this invocation selects. Existing user profiles
  // are never silently rewritten just to insert our optional native example.
  let selected = watch || !args.length ? 'web' : undefined;
  const patches = [];
  if (!watch && args[0] !== 'plugin') {
    let index = 0;
    if (args[0] && !args[0].startsWith('-')) { selected = args[0]; index++; }
    for (; index < args.length; index++) {
      const value = args[index];
      if (value === '--profile') { selected = args[++index]; continue; }
      if (value.startsWith('--profile=')) { selected = value.slice('--profile='.length); continue; }
      if (value === '--patch') { if (args[index + 1]) patches.push(args[++index]); continue; }
      if (value.startsWith('--patch=')) { patches.push(value.slice('--patch='.length)); continue; }
      if (value === '--from-default-profile') { index++; continue; }
      if (['--dump-config', '--dump-config-schema', '--dump-default-config'].includes(value)) continue;
      break; // Remaining arguments belong to the official app, not its launcher.
    }
  }
  if (['web', 'headless'].includes(selected)) {
    const directory = resolve(profiles, selected);
    const installAnchor = fileURLToPath(new URL('../official-runtime/node_modules/@deepseek-ai/dsh/package.json', import.meta.url));
    const loaded = loadProfileDirectory('dsh', directory, installAnchor);
    const overlays = patches.flatMap(path => loadOverlayPatches('dsh', resolve(path)));
    const composed = composeEntries([readProfilePatches('dsh', { dir: directory, patchPath: loaded.patchPath,
      installAnchor, home: resolve(process.env.DSH_HOME), overlays, telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED }, loaded)]);
    const flatten = rows => rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])]);
    const rows = flatten(composed), native = rows.filter(row => row.id === 'rust-module'), tool = rows.filter(row => row.id === 'rust-dynamic-tool');
    if (native.length !== 1 || native[0].name !== 'cordis:rust-module' || tool.length !== 1 || typeof tool[0].name !== 'string' || !tool[0].name) {
      throw new Error(`Native Rust profile ${selected} is missing or replaces the required rust-module / rust-dynamic-tool entries. `
        + 'Use a new dedicated DSH_HOME directory, or explicitly insert rust-module (name: cordis:rust-module, verified immutable artifact config) '
        + 'and rust-dynamic-tool (the official Rust tool bridge) into this profile. Existing user configuration has not been overwritten.');
    }
  }
  if (!watch) {
    const entry = new URL('../official-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url);
    process.argv = [process.execPath, fileURLToPath(entry), ...(args.length ? args : ['web'])];
    const { runCli } = await import(entry.href);
    await runCli();
  } else {
    if (args[0] === 'web') args.shift();
    assert(!args[0] || args[0].startsWith('-'), 'Build watching currently runs the official Web profile');
    const { runProfile } = await import('../official-runtime/node_modules/@deepseek-ai/dsh/lib/profile-boot.js');
    const { watchOfficialRustModule } = await import('../src/official-native-modules.mjs');
    const priorSignals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));
    const profile = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'web', patchFiles: [], args: args.length ? args : ['--no-open'] });
    // App argument parsing may request appExit during boot. runProfile returns
    // that stopped context; it must not gain a build timer or launch Cargo.
    if (profile.ctx.fiber.state !== 2 || profile.ctx.get('loader') === undefined) {
      await profile.shutdown.shutdown(process.exitCode ?? 0);
    } else {
      // This launcher owns its build child: drain it before starting the official
      // bounded shutdown. Remove only the handlers installed by this runProfile.
      for (const [signal, before] of priorSignals) for (const listener of process.listeners(signal)) {
        if (!before.has(listener)) process.removeListener(signal, listener);
      }
      const watcher = watchOfficialRustModule(profile.ctx.root, {
        entryId: 'include:rust-module', readyEntries: ['include:rust-dynamic-tool'], cwd: root,
        watchPaths: ['native/dynamic-text-analysis/src', 'native/dynamic-text-analysis/examples',
          'native/dynamic-text-analysis/Cargo.toml', 'native/dynamic-text-analysis/Cargo.lock'],
        command: { file: process.execPath, args: ['scripts/build-rust-modules.mjs', '--offline'] },
        artifact: async () => (await verifyRustModules()).published.v1,
        onEvent(outcome) {
          if (outcome.status === 'completed') console.error('[cordis-harness] Verified Rust generation active; the official process and Driver remain resident.');
          else if (outcome.status === 'failed') console.error(`[cordis-harness] Native update failed in ${outcome.phase}: ${outcome.error?.message ?? 'unknown error'}`);
        },
      });
      const close = installNativeWatchShutdown(profile.shutdown, watcher, { onError(error) {
        process.exitCode = 1;
        console.error(`[cordis-harness] Native watcher shutdown failed: ${error?.message ?? error}`);
      } });
      process.once('SIGINT', () => { void close(130); });
      process.once('SIGTERM', () => { void close(0); });
      await watcher.start();
    }
  }
}
