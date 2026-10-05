#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const verified = spawnSync(process.execPath, [resolve(root, 'scripts/verify-official.mjs')], { stdio: 'inherit' });
if (verified.error) throw verified.error;
if (verified.status !== 0) process.exit(verified.status ?? 1);
process.env.DSH_HOME ??= resolve(root, '.cordis-harness/official');
const args = process.argv.slice(2);
const entry = new URL('../official-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url);
process.argv = [process.execPath, fileURLToPath(entry), ...(args.length ? args : ['web'])];
await import('./official-register.mjs');
console.error(`[cordis-harness] Official DeepSeek Harness; Rust/Verus Cordis host; data: ${process.env.DSH_HOME}`);
const { runCli } = await import(entry.href);
await runCli();
