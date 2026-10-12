import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, assertRevision, watchOfficialRustModule } from './native-loader-fixture.mjs';
import { publishNativeModule } from '../../src/native-module-artifacts.mjs';
import { approvedCoreSources, coreSources, projectRoot } from '../../scripts/verify-rust-addon.mjs';

const execute = promisify(execFile);
async function until(check, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { if (check()) return; await delay(25); }
  assert.fail(`Timed out waiting for ${label}`);
}

test('real source edits compile and replace an official Rust tool; compiler errors retain the last working generation', { timeout: 180000 }, async () => {
  const f = await fixture();
  let watcher;
  try {
    const coreRoot = await realpath(resolve(projectRoot, '../cordis-verus'));
    const approved = await approvedCoreSources();
    assert.deepEqual(await coreSources(coreRoot), approved, 'Only the approved sibling SDK may be compiled');
    const sdk = join(coreRoot, 'crates/cordis-plugin-api');
    const rust = JSON.parse(await readFile(join(coreRoot, 'toolchain.lock.json'), 'utf8')).rust.channel;
    const cargo = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
    const directory = join(f.directory, 'independent-native-crate');
    await mkdir(join(directory, 'src'), { recursive: true });
    const target = join(projectRoot, '.cache/native-build-reload/target');
    const environment = { ...process.env, RUSTUP_TOOLCHAIN: rust, CARGO_TARGET_DIR: target, CARGO_NET_OFFLINE: 'true' };
    // Keep the package/dependency identities from the approved demonstration's
    // lock. This independent cdylib target contains no resident Cordis host.
    await writeFile(join(directory, 'Cargo.toml'), `[package]\nname = "cordis-harness-dynamic-text-analysis"\nversion = "0.1.0"\nedition = "2021"\nrust-version = ${JSON.stringify(rust)}\npublish = false\n\n[lib]\nname = "cordis_harness_watch_fixture"\ncrate-type = ["cdylib"]\n\n[dependencies]\ncordis-plugin-api = { path = ${JSON.stringify(sdk)}, version = "=0.2.0" }\nserde_json = "1"\n\n[profile.release]\ndebug-assertions = true\noverflow-checks = true\n`);
    await copyFile(join(projectRoot, 'native/dynamic-text-analysis/Cargo.lock'), join(directory, 'Cargo.lock'));
    for (const source of ['resources.rs', 'reverse_resources.rs', 'fleet.rs']) {
      await copyFile(join(projectRoot, 'native/dynamic-text-analysis/src', source), join(directory, 'src', source));
    }
    const implementation = await readFile(join(projectRoot, 'native/dynamic-text-analysis/src/lib.rs'), 'utf8');
    const source = join(directory, 'src/lib.rs');
    const version = revision => `${implementation}\nfn watched_module() -> cordis_plugin_api::Module { module(${JSON.stringify(revision)}, false) }\ncordis_plugin_api::export_plugin!(watched_module);\n`;
    await writeFile(source, version('v1'));
    const { stdout } = await execute(cargo, ['metadata', '--format-version=1', '--offline', '--locked'],
      { cwd: directory, env: environment, maxBuffer: 8 * 1024 * 1024 });
    const metadata = JSON.parse(stdout);
    const sdkPackages = metadata.packages.filter(item => item.name === 'cordis-plugin-api');
    assert.equal(sdkPackages.length, 1);
    assert.equal(await realpath(sdkPackages[0].manifest_path), await realpath(join(sdk, 'Cargo.toml')));
    assert(!metadata.packages.some(item => ['cordis', 'cordis-node', 'cordis-kernel', 'cordis-driver', 'napi', 'napi-derive'].includes(item.name)),
      'The watched crate must not compile a second Driver or Node addon');
    const events = [];
    let verifiedArtifacts = 0;
    watcher = watchOfficialRustModule(f.ctx, { entryId: f.entry.id, readyEntries: f.readyEntries,
      cwd: directory, watchPaths: ['src', 'Cargo.toml', 'Cargo.lock'], intervalMs: 30,
      command: { file: cargo, args: ['build', '--release', '--offline', '--locked', '--message-format=json-render-diagnostics'], env: environment },
      artifact: async ({ buildResult }) => {
        // The bounded command output may begin in a truncated earlier record;
        // require the final target's actual Cargo artifact record, not a guessed path.
        const records = buildResult.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const emitted = records.filter(item => item.reason === 'compiler-artifact' && item.target?.name === 'cordis_harness_watch_fixture');
        assert.equal(emitted.length, 1, 'Successful Cargo output must identify the real watched cdylib');
        assert(emitted[0].target.crate_types.includes('cdylib'));
        assert.equal(emitted[0].profile.opt_level, '3');
        assert.equal(emitted[0].profile.debug_assertions, true);
        assert.equal(emitted[0].profile.overflow_checks, true);
        const extension = { darwin: '.dylib', linux: '.so', win32: '.dll' }[process.platform];
        const images = emitted[0].filenames.filter(file => file.endsWith(extension));
        assert.equal(images.length, 1);
        const published = await publishNativeModule({ libraryPath: images[0], directory: join(f.directory, 'watched-artifacts'),
          plugins: [{ id: 'analysis', factory: 'harness.dynamic-text-analysis', config: {} }] });
        verifiedArtifacts++;
        return published;
      },
      onEvent: event => events.push(event),
    });
    assert.equal((await watcher.start()).status, 'completed', JSON.stringify(watcher.snapshot()));
    await assertRevision(f, 'v1');
    await writeFile(source, version('v2'));
    await until(() => events.filter(event => event.status === 'completed').length === 2, 'source-driven v2 compilation and Loader update');
    await assertRevision(f, 'v2');
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    assert.equal(process.pid, f.pid);
    const priorConfig = structuredClone(f.entry.options.config), priorFiber = f.entry.fiber, priorGeneration = priorFiber._generation;
    await writeFile(source, version('v2') + '\nthis is deliberately invalid Rust syntax\n');
    await until(() => events.some(event => event.status === 'failed' && event.phase === 'build'), 'a real compiler rejection');
    assert.equal(watcher.snapshot().lastFailure.code, 'BUILD_FAILED');
    assert.equal(verifiedArtifacts, 2, 'Failed compilation cannot publish or apply a new library');
    assert.equal(f.entry.fiber, priorFiber);
    assert.equal(f.entry.fiber._generation, priorGeneration);
    assert.deepEqual(f.entry.options.config, priorConfig);
    await assertRevision(f, 'v2');
    await writeFile(source, version('v3'));
    await until(() => events.filter(event => event.status === 'completed').length === 3, 'source correction and v3 recovery');
    await assertRevision(f, 'v3');
    assert.equal(verifiedArtifacts, 3);
    assert.equal(f.ctx.fiber._domain.driver, f.driver);
    assert.equal(process.pid, f.pid);
    assert.deepEqual(await coreSources(coreRoot), approved, 'Watching a plugin must not modify the approved host or SDK');
  } finally { await watcher?.close(); await f.dispose(); }
});
