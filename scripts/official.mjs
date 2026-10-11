#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { dataDirectory, publishedDistribution } from '../src/distribution.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
if (publishedDistribution) {
  await (await import('./verify-published.mjs')).verifyPublished();
} else {
  const verified = spawnSync(process.execPath, [resolve(root, 'scripts/verify-official.mjs')], { stdio: 'inherit' });
  if (verified.error) throw verified.error;
  if (verified.status !== 0) process.exit(verified.status ?? 1);
}
process.env.DSH_HOME ??= resolve(dataDirectory, 'official');
const args = process.argv.slice(2);
const entry = new URL(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js'));
process.argv = [process.execPath, fileURLToPath(entry), ...(args.length ? args : ['web'])];
await import('./official-register.mjs');
console.error(`[harness-verus] Official DeepSeek Harness; Rust/Verus Cordis host; data: ${process.env.DSH_HOME}`);
const { runCli } = await import(entry.href);
await runCli();
