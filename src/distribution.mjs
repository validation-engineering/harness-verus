import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const publishedDistribution = packageManifest.private !== true;
// A global/npm-exec installation must never store sessions in its package files.
export const dataDirectory = resolve(process.env.HARNESS_VERUS_HOME ??
  (publishedDistribution ? resolve(homedir(), '.harness-verus') : resolve(projectRoot, '.cordis-harness')));
