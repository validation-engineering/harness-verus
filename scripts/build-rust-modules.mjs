#!/usr/bin/env node
import assert from 'node:assert/strict';
import { publishNativeModule } from '../src/native-module-artifacts.mjs';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedCoreSources, coreSources, runtimeEnvironment, sha256 } from './verify-rust-addon.mjs';
import { moduleArtifactRelativePaths, moduleEvidenceRelativePath, moduleFactoryName, moduleServiceName,
  moduleSources, projectRoot, verifyRustModules } from './verify-rust-modules.mjs';

export async function buildRustModules({ offline = false } = {}) {
  const coreRoot = await realpath(path.join(projectRoot, '../cordis-verus'));
  const reportPath = path.join(projectRoot, moduleEvidenceRelativePath);
  await rm(reportPath, { force: true });
  const approved = await approvedCoreSources();
  assert.deepEqual(await coreSources(coreRoot), approved, 'Sibling Cordis sources differ from the approved native runtime');
  const before = await moduleSources();
  const toolchain = JSON.parse(await readFile(path.join(coreRoot, 'toolchain.lock.json'), 'utf8')).rust.channel;
  const environment = { ...process.env, RUSTUP_TOOLCHAIN: toolchain,
    CARGO_TARGET_DIR: path.join(projectRoot, '.cache/rust-modules/target') };
  const manifest = 'native/dynamic-text-analysis/Cargo.toml';
  const metadataArgs = ['metadata', '--format-version=1', '--locked', '--manifest-path', manifest];
  if (offline) metadataArgs.push('--offline');
  const metadataResult = spawnSync('cargo', metadataArgs, { cwd: projectRoot, env: environment, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 });
  if (metadataResult.error) throw metadataResult.error;
  assert.equal(metadataResult.status, 0, 'Cargo dependency metadata failed');
  const metadata = JSON.parse(metadataResult.stdout);
  const sdkPackages = metadata.packages.filter(item => item.name === 'cordis-plugin-api');
  assert.equal(sdkPackages.length, 1, 'Exactly one native SDK must be resolved');
  assert.equal(await realpath(sdkPackages[0].manifest_path),
    await realpath(path.join(coreRoot, 'crates/cordis-plugin-api/Cargo.toml')),
    'Cargo resolved a different SDK than the approved sibling source');
  const dependencies = metadata.packages.map(item => item.name).sort();
  assert(dependencies.includes('cordis-plugin-api'), 'Native module must depend on the versioned SDK');
  assert(!dependencies.some(name => ['cordis', 'cordis-node', 'cordis-driver', 'cordis-kernel', 'napi', 'napi-derive'].includes(name)),
    'Native module unexpectedly embeds a second Cordis host');
  const args = ['build', '--release', '--examples', '--locked', '--manifest-path', manifest, '--message-format=json-render-diagnostics'];
  if (offline) args.push('--offline');
  const result = spawnSync('cargo', args, { cwd: projectRoot, env: environment, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Cargo native module build failed (${result.status})`);
  const extension = { darwin: '.dylib', linux: '.so', win32: '.dll' }[process.platform];
  assert(extension, 'Unsupported native module platform');
  const records = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const artifacts = {};
  for (const [revision, relative] of Object.entries(moduleArtifactRelativePaths)) {
    const emitted = records.filter(item => item.reason === 'compiler-artifact'
      && item.target?.name === `dynamic_text_${revision}` && item.target.crate_types?.includes('cdylib'));
    const candidates = emitted.flatMap(item => item.filenames).filter(file => file.endsWith(extension));
    assert.equal(emitted.length, 1, `Cargo must report exactly one ${revision} cdylib target`);
    assert.equal(candidates.length, 1, `Cargo must report exactly one ${revision} library path`);
    assert.equal(emitted[0].profile.opt_level, '3');
    assert.equal(emitted[0].profile.debug_assertions, true);
    assert.equal(emitted[0].profile.overflow_checks, true);
    const output = path.join(projectRoot, relative);
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(candidates[0], output);
    const published = await publishNativeModule({ libraryPath: output, directory: path.join(projectRoot, '.cache/rust-modules/published'),
      plugins: [{ id: 'analysis', factory: moduleFactoryName }] });
    artifacts[revision] = { path: relative, sha256: await sha256(output), revision, compilerProfile: emitted[0].profile,
      published: { manifestPath: path.relative(projectRoot, published.manifestPath), manifestSha256: published.manifestSha256 } };
  }
  assert.deepEqual(await moduleSources(), before, 'Native module source changed during compilation');
  assert.deepEqual(await coreSources(coreRoot), approved, 'Core source changed during native module compilation');
  const evidence = { schema: 'cordis-harness.rust-modules/v1', abi: 1, builtAt: new Date().toISOString(),
    factory: moduleFactoryName, service: moduleServiceName, environment: runtimeEnvironment(), rustToolchain: toolchain,
    command: ['cargo', ...args], inputs: before, coreSources: approved, dependencies, artifacts };
  await writeFile(reportPath, JSON.stringify(evidence, null, 2) + '\n');
  try { await verifyRustModules(); } catch (error) { await rm(reportPath, { force: true }); throw error; }
  console.log(`Built ${moduleFactoryName} v1/v2/fail using only the native plugin SDK; upstream source is unchanged.`);
  return verifyRustModules();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--offline',
    'Usage: node scripts/build-rust-modules.mjs [--offline]');
  await buildRustModules({ offline: process.argv.includes('--offline') });
}
