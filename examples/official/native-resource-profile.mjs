import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRustModules, projectRoot } from '../../scripts/verify-rust-modules.mjs';
import { publishNativeModule } from '../../src/native-module-artifacts.mjs';

/** Optional official recipes; preserves the ordinary and policy text tools. */
export async function createNativeResourceEntries({ revision = 'v1', audit = { label: 'text-resources' } } = {}) {
  assert(['v1', 'v2'].includes(revision), 'The resource example requires a successful v1 or v2 build');
  const { artifacts } = await verifyRustModules();
  const published = await publishNativeModule({ libraryPath: artifacts[revision].path,
    directory: resolve(projectRoot, '.cache/rust-modules/resource-published'),
    plugins: [{ id: 'text-resources', factory: 'harness.dynamic-text-resources', config: {} }],
  });
  return [
    { id: 'text-resource-audit', name: new URL('./text-resource-audit.mjs', import.meta.url).href, config: audit },
    { id: 'rust-resources', name: 'cordis:rust-module', inject: ['textResourceAudit'], config: published.config },
    { id: 'rust-resource-tool', name: new URL('./rust-resource-text-analysis.mjs', import.meta.url).href },
  ];
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'Usage: node examples/official/native-resource-profile.mjs');
  console.log(JSON.stringify([{ insert: await createNativeResourceEntries() }], null, 2));
}
