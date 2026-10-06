import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRustModules, projectRoot } from '../../scripts/verify-rust-modules.mjs';
import { publishNativeModule } from '../../src/native-module-artifacts.mjs';

/** Additional official profile rows; the default text tool remains installed.
 * Publish exact bytes before returning the ordinary cordis:rust-module recipe.
 */
export async function createNativePolicyEntries({ revision = 'v1', policy = { revision: 'policy-v1', prefix: '[policy] ', uppercase: false } } = {}) {
  assert(['v1', 'v2'].includes(revision), 'The policy example requires a successful v1 or v2 build');
  const { artifacts } = await verifyRustModules();
  const published = await publishNativeModule({ libraryPath: artifacts[revision].path,
    directory: resolve(projectRoot, '.cache/rust-modules/policy-published'),
    plugins: [{ id: 'policy-analysis', factory: 'harness.dynamic-policy-text-analysis', config: {} }],
  });
  return [
    { id: 'text-policy', name: new URL('./text-policy.mjs', import.meta.url).href, config: policy },
    { id: 'rust-policy', name: 'cordis:rust-module', inject: ['textPolicy'], config: published.config },
    { id: 'rust-policy-tool', name: new URL('./rust-policy-text-analysis.mjs', import.meta.url).href },
  ];
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'Usage: node examples/official/native-policy-profile.mjs');
  console.log(JSON.stringify([{ insert: await createNativePolicyEntries() }], null, 2));
}
