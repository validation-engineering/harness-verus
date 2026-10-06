import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRustModules, projectRoot } from '../../scripts/verify-rust-modules.mjs';
import { publishNativeModule } from '../../src/native-module-artifacts.mjs';

export async function createNativeJsPipelineEntries({ revision = 'v1', pipeline = { revision: 'js-pipeline-v1' } } = {}) {
  assert(['v1', 'v2'].includes(revision), 'The JS pipeline example requires a successful v1 or v2 build');
  const { artifacts } = await verifyRustModules();
  const published = await publishNativeModule({ libraryPath: artifacts[revision].path,
    directory: resolve(projectRoot, '.cache/rust-modules/js-pipeline-published'),
    plugins: [{ id: 'js-text-pipeline', factory: 'harness.dynamic-js-text-pipeline', config: {} }],
  });
  return [
    { id: 'text-pipeline', name: new URL('./text-pipeline.mjs', import.meta.url).href, config: pipeline },
    { id: 'rust-js-pipeline', name: 'cordis:rust-module', inject: ['textPipeline'], config: published.config },
    { id: 'rust-js-pipeline-tool', name: new URL('./rust-js-text-pipeline.mjs', import.meta.url).href },
  ];
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'Usage: node examples/official/native-js-pipeline-profile.mjs');
  console.log(JSON.stringify([{ insert: await createNativeJsPipelineEntries() }], null, 2));
}
