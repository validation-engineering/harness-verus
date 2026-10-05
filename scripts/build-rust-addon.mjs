#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { addonEvidenceRelativePath, addonRelativePath, addonSources, approvedCoreSources,
  coreSources, factoryName, projectRoot, runtimeEnvironment, sha256, verifyRustAddon } from './verify-rust-addon.mjs';

assert(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--offline',
  'Usage: node scripts/build-rust-addon.mjs [--offline]');
const offline = process.argv.includes('--offline');
const coreRoot = await realpath(path.join(projectRoot, '../cordis-verus'));
const reportPath = path.join(projectRoot, addonEvidenceRelativePath);
await rm(reportPath, { force: true });
const approved = await approvedCoreSources();
assert.deepEqual(await coreSources(coreRoot), approved, 'Sibling cordis-verus native sources differ from the approved runtime');
const before = await addonSources();
const toolchain = JSON.parse(await readFile(path.join(coreRoot, 'toolchain.lock.json'), 'utf8')).rust.channel;
const output = path.join(projectRoot, addonRelativePath);
await mkdir(path.dirname(output), { recursive: true });
const args = ['build', '--release', '--locked', '--manifest-path', 'native/text-analysis/Cargo.toml', '--message-format=json-render-diagnostics'];
if (offline) args.push('--offline');
const environment = { ...process.env, RUSTUP_TOOLCHAIN: toolchain, CARGO_TARGET_DIR: path.join(projectRoot, '.cache/rust-addon/target') };
const result = spawnSync('cargo', args, { cwd: projectRoot, env: environment, encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 });
if (result.error) throw result.error;
assert.equal(result.status, 0, `Cargo addon build failed (${result.status})`);
const extension = { darwin: '.dylib', linux: '.so', win32: '.dll' }[process.platform];
assert(extension, 'Unsupported addon platform');
const artifacts = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  .filter(item => item.reason === 'compiler-artifact' && item.target?.name === 'cordis_harness_text_analysis' && item.target.kind.includes('cdylib'));
const candidates = artifacts.flatMap(item => item.filenames).filter(file => file.endsWith(extension));
assert.equal(candidates.length, 1, 'Cargo must report exactly one loadable text-analysis artifact');
assert.equal(artifacts[0].profile?.opt_level, '3', 'The addon must use optimization level 3');
assert.equal(artifacts[0].profile.debug_assertions, true, 'Keep Rust debug assertions enabled');
assert.equal(artifacts[0].profile.overflow_checks, true, 'Keep Rust overflow checks enabled');
await copyFile(candidates[0], output);
const binding = createRequire(import.meta.url)(output);
assert.equal(JSON.parse(binding.bindingInfo()).abi, 1);
const driver = binding.createDriver();
const factories = JSON.parse(driver.rustInfo()).factories;
assert.deepEqual(factories.map(factory => factory.name), [factoryName]);
assert.deepEqual(await addonSources(), before, 'Addon source changed during compilation');
assert.deepEqual(await coreSources(coreRoot), approved, 'Core source changed during compilation');
const evidence = { schema: 'cordis-harness.rust-addon/v1', builtAt: new Date().toISOString(),
  factory: factoryName, environment: runtimeEnvironment(), rustToolchain: toolchain,
  command: ['cargo', ...args], compilerProfile: artifacts[0].profile, inputs: before, coreSources: approved,
  artifact: { path: addonRelativePath, sha256: await sha256(output) }, factoryDescriptors: factories };
await writeFile(reportPath, JSON.stringify(evidence, null, 2) + '\n');
try { await verifyRustAddon(); } catch (error) { await rm(reportPath, { force: true }); throw error; }
console.log(`Built ${factoryName} at ${addonRelativePath}; no upstream source was modified.`);
