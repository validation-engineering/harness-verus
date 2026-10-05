#!/usr/bin/env node
// Keep the original Web/headless compositions, with two additional Loader entries.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import './official-extensions-register.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
process.env.DSH_HOME ??= resolve(root, '.cordis-harness/official-extensions');
const { initProfile, PROFILE_TEMPLATES } = await import('../official-runtime/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
const profiles = resolve(process.env.DSH_HOME, 'profiles');
await mkdir(profiles, { recursive: true });
for (const profile of ['web', 'headless']) {
  const directory = resolve(profiles, profile);
  try { await mkdir(directory); }
  catch (error) { if (error.code === 'EEXIST') continue; throw error; }
  initProfile(directory, PROFILE_TEMPLATES[profile].bundles);
  const insert = [
    { id: 'cordis-greeting', name: pathToFileURL(resolve(root, 'examples/official/greeting.mjs')).href },
    { id: 'cordis-rust-text-analysis', name: pathToFileURL(resolve(root, 'examples/official/rust-text-analysis.mjs')).href },
  ];
  await writeFile(resolve(directory, 'cordis.patch.yml'), JSON.stringify([{ insert }], null, 2) + '\n', { mode: 0o600 });
}
const entry = new URL('../official-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url);
const args = process.argv.slice(2);
process.argv = [process.execPath, fileURLToPath(entry), ...(args.length ? args : ['web'])];
console.error(`[cordis-harness] Official Harness with JS/Rust extension plugins; data: ${process.env.DSH_HOME}`);
const { runCli } = await import(entry.href);
await runCli();
