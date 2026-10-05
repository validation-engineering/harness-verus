// Explicit, source-verified addon selection for the official extensions example.
import assert from 'node:assert/strict';
import { isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { verifyOfficial } from './verify-official.mjs';
import { verifyRustAddon } from './verify-rust-addon.mjs';

if (isMainThread) {
  // Keep the ordinary installed-artifact gate unchanged and reject ambient overrides.
  await verifyOfficial();
}
const verified = await verifyRustAddon();
if (!isMainThread) {
  assert.equal(process.env.CORDIS_NATIVE_BINDING, verified.addonPath,
    'An extension Worker must inherit the same verified addon');
}
process.env.CORDIS_NATIVE_BINDING = verified.addonPath;
if (!process.execArgv.some((value, index, args) => value === import.meta.url || value === '--import' && args[index + 1] === fileURLToPath(import.meta.url))) {
  process.execArgv.push('--import', import.meta.url);
}
await import('./official-register.mjs');
