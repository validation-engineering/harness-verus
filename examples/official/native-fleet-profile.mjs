import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRustModules, projectRoot } from '../../scripts/verify-rust-modules.mjs';
import { publishNativeModule } from '../../src/native-module-artifacts.mjs';

export async function createNativeFleetEntries({ revision = 'v1', audit = { label: 'text-fleet' }, workers = ['notes', 'code'], migration = false } = {}) {
  assert.equal(typeof migration, 'boolean', 'migration must be a boolean');
  assert(['v1', 'v2'].includes(revision), 'The fleet example requires a successful v1 or v2 build');
  const { artifacts } = await verifyRustModules();
  const published = await publishNativeModule({ libraryPath: artifacts[revision].path,
    directory: resolve(projectRoot, '.cache/rust-modules/fleet-published'),
    plugins: [{ id: 'text-fleet', factory: 'harness.dynamic-text-fleet', config: {}, ...(migration ? { state: 'migrate' } : {}) }],
  });
  return [
    { id: 'text-fleet-audit', name: new URL('./text-fleet-audit.mjs', import.meta.url).href, config: audit },
    { id: 'rust-text-fleet', name: 'cordis:rust-module', inject: ['textFleetAudit'], config: published.config },
    { id: 'rust-text-fleet-tools', name: new URL('./rust-text-fleet.mjs', import.meta.url).href, config: { workers } },
  ];
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--migrate'), 'Usage: node examples/official/native-fleet-profile.mjs [--migrate]');
  console.log(JSON.stringify([{ insert: await createNativeFleetEntries({ migration: process.argv[2] === '--migrate' }) }], null, 2));
}
