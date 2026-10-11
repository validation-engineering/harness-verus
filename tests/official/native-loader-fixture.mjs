import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyRustModules } from '../../scripts/verify-rust-modules.mjs';
import { publishNativeModule, readNativeModule } from '../../src/native-module-artifacts.mjs';

if (!process.execArgv.some(arg => arg === '--import' || arg.startsWith('--import='))) await import('../../scripts/official-register.mjs');
const { Context } = await import('@deepseek-ai/cordis');
const { default: Loader, EntryTree } = await import('@deepseek-ai/cordis-plugin-loader');
const { default: Timer } = await import('@deepseek-ai/cordis-plugin-timer');
const { default: Hmr } = await import('@deepseek-ai/dsh-hmr');
const { ConfigEditor } = await import('@deepseek-ai/dsh-config-editor');
const { mountRootInclude, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot');
const { default: Schema } = await import('@deepseek-ai/schemastery');
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools');
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const { SettingsForms } = await import('@deepseek-ai/dsh-settings');
const bridge = await import('../../examples/official/rust-dynamic-text-analysis.mjs');
const policyBridge = await import('../../examples/official/rust-policy-text-analysis.mjs');
const { createTextPolicyPlugin } = await import('../../examples/official/text-policy.mjs');
const { createNativePolicyEntries } = await import('../../examples/official/native-policy-profile.mjs');
const resourceBridge = await import('../../examples/official/rust-resource-text-analysis.mjs');
const { createTextResourceAudit } = await import('../../examples/official/text-resource-audit.mjs');
const { createNativeResourceEntries } = await import('../../examples/official/native-resource-profile.mjs');
const pipelineBridge = await import('../../examples/official/rust-js-text-pipeline.mjs');
const { createTextPipeline } = await import('../../examples/official/text-pipeline.mjs');
const { createNativeJsPipelineEntries } = await import('../../examples/official/native-js-pipeline-profile.mjs');
const fleetBridge = await import('../../examples/official/rust-text-fleet.mjs');
const { createTextFleetAudit } = await import('../../examples/official/text-fleet-audit.mjs');
const { createNativeFleetEntries } = await import('../../examples/official/native-fleet-profile.mjs');
const { LoaderTransactions } = await import('../../src/official-loader-api.mjs');
const { installOfficialRustModules, nativeModuleSpecifier, updateOfficialRustModule, watchOfficialRustModule } = await import('../../src/official-native-modules.mjs');
installOfficialRustModules({ EntryTree, Schema });

async function fixture({ migration = false, rejectFleetV2 = false, failFleetRollbackOnce = false, fleetHmr = false, fleet = false, fleetHooks, generatedFleet = false, workers = ['notes', 'code'], rejectV2 = false, policy, policyHooks, generatedPolicy = false, resources = false, resourceHooks, generatedResources = false, pipeline = false, pipelineHooks, generatedPipeline = false } = {}) {
  assert(!migration || fleet, 'The migration fixture uses the checkpoint-capable fleet factory');
  assert(!rejectFleetV2 || fleet, 'The fleet version guard requires the fleet factory');
  assert(!failFleetRollbackOnce || (migration && rejectFleetV2), 'Rollback failure requires migrating the guarded fleet');
  assert(!fleetHmr || (fleet && !generatedFleet), 'HMR uses an isolated fileURL wrapper around the real fleet bridge');
  assert(!fleet || (!pipeline && !resources && !policy && !rejectV2), 'The fleet fixture selects a separate opt-in factory');
  assert(!generatedFleet || (fleet && !fleetHooks), 'Generated fleet recipes load the actual provider without hooks');
  assert(!pipeline || (!resources && !policy && !rejectV2), 'The JS pipeline fixture selects a separate opt-in factory');
  assert(!generatedPipeline || pipeline, 'Generated pipeline fixtures require the pipeline factory');
  assert(!generatedPipeline || !pipelineHooks, 'Generated pipeline recipes must load the actual provider without hooks');
  assert(!resources || !policy, 'Policy and resource fixtures select separate opt-in factories');
  assert(!resources || !rejectV2, 'The version guard only observes the default text service');
  assert(!generatedResources || resources, 'Generated resource fixtures require the resource factory');
  assert(!generatedResources || !resourceHooks, 'Generated resource recipes must import the actual provider without test hooks');
  assert(!generatedPolicy || policy, "Generated policy fixtures require an explicit policy config");
  assert(!generatedPolicy || !policyHooks, "Generated profile recipes must import the actual provider without test hooks");
  const { artifacts } = await verifyRustModules();
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cordis-official-native-')));
  const configPath = join(directory, 'cordis.json'), patchPath = join(directory, 'cordis.patch.yml');
  const profile = { name: 'native-loader-fixture', dir: directory, patchPath,
    installAnchor: new URL('../../package.json', import.meta.url).pathname,
    home: join(directory, 'home'), cwd: directory, startedBundles: [], overlays: [], telemetryDisabledEnv: '1' };
  const ctx = new Context(), manifests = {}, consumerHistory = [];
  let calls = 0, fleetGuardRepaired = false, fleetCandidateRejected = false, fleetRollbackRejected = false;
  try {
    for (const [revision, artifact] of Object.entries(artifacts)) {
      manifests[revision] = await publishNativeModule({ libraryPath: artifact.path, directory: join(directory, 'artifacts'),
        plugins: [{ id: generatedFleet ? 'text-fleet' : 'analysis', factory: fleet ? 'harness.dynamic-text-fleet' : pipeline ? 'harness.dynamic-js-text-pipeline' : resources ? 'harness.dynamic-text-resources' : policy ? 'harness.dynamic-policy-text-analysis' : 'harness.dynamic-text-analysis', config: {}, ...(migration ? { state: 'migrate' } : {}) }] });
      assert.deepEqual(await readNativeModule(manifests[revision].manifestPath, { sha256: manifests[revision].manifestSha256 }), manifests[revision]);
    }
    const generatedEntries = generatedFleet ? await createNativeFleetEntries({ workers, migration }) : generatedPipeline ? await createNativeJsPipelineEntries() : generatedResources ? await createNativeResourceEntries() : generatedPolicy ? await createNativePolicyEntries({ policy }) : undefined;
    const nativeId = generatedFleet ? 'rust-text-fleet' : generatedPipeline ? 'rust-js-pipeline' : generatedResources ? 'rust-resources' : generatedPolicy ? 'rust-policy' : 'native';
    const toolId = generatedFleet ? 'rust-text-fleet-tools' : generatedPipeline ? 'rust-js-pipeline-tool' : generatedResources ? 'rust-resource-tool' : generatedPolicy ? 'rust-policy-tool' : 'tool';
    const policyId = generatedPolicy ? 'text-policy' : 'policy';
    const fleetAuditId = generatedFleet ? 'text-fleet-audit' : 'fleet-audit';
    const auditId = generatedResources ? 'text-resource-audit' : 'audit';
    const pipelineId = generatedPipeline ? 'text-pipeline' : 'pipeline';
    const bridgePath = join(directory, 'fleet-tools.mjs'), bridgeUrl = pathToFileURL(bridgePath).href;
    const writeBridge = version => writeFile(bridgePath, `import { apply as fleetApply, Config, inject } from ${JSON.stringify(new URL('../../examples/official/rust-text-fleet.mjs', import.meta.url).href)};
export { Config, inject }; export const name = 'fleet-hmr-${version}'; export async function apply(ctx, config) { return fleetApply(ctx, config); }
`);
    if (fleetHmr) await writeBridge(1);
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'native-loader-fixture', dsh: { profile: { bundles: [] } } }));
    await writeFile(configPath, '[]\n');
    await writeFile(patchPath, JSON.stringify([{ insert: [
      { id: 'system', name: 'cordis:native-test-system', config: {} },
      { id: 'tools', name: 'cordis:native-test-tools' },
      ...(generatedEntries ?? [
        ...(fleet ? [{ id: 'fleet-audit', name: 'cordis:native-test-fleet-audit', config: { label: 'fleet-v1' } }] : []),
        ...(pipeline ? [{ id: 'pipeline', name: 'cordis:native-test-pipeline', config: { revision: 'js-pipeline-v1' } }] : []),
        ...(resources ? [{ id: 'audit', name: 'cordis:native-test-audit', config: { label: 'resource-v1' } }] : []),
        ...(policy ? [{ id: 'policy', name: 'cordis:native-test-policy', config: policy }] : []),
        { id: 'native', name: nativeModuleSpecifier, ...(fleet ? { inject: ['textFleetAudit'] } : pipeline ? { inject: ['textPipeline'] } : resources ? { inject: ['textResourceAudit'] } : policy ? { inject: ['textPolicy'] } : {}), config: manifests.v1.config },
        { id: 'tool', name: fleetHmr ? bridgeUrl : 'cordis:native-test-tool', ...(fleet ? { config: { workers } } : {}) },
      ]),
      ...(rejectV2 ? [{ id: 'guard', name: 'cordis:native-test-guard' }] : []),
      ...(rejectFleetV2 ? [{ id: 'fleet-guard', name: 'cordis:native-test-fleet-guard' }] : []),
    ] }]));
    ctx.baseUrl = pathToFileURL(directory + '/').href;
    await ctx.plugin(Loader);
    if (fleetHmr) { await ctx.plugin(Timer); await ctx.plugin(Hmr, { root: [], base: '.', ignored: [], debounce: 5 }); }
    ctx.provide('profileContext', profile);
    ctx.loader.builtins['native-test-system'] = SystemPrompt;
    ctx.loader.builtins['native-test-tools'] = ToolRuntime;
    ctx.loader.builtins['native-test-tool'] = fleet ? fleetBridge : pipeline ? pipelineBridge : resources ? resourceBridge : policy ? policyBridge : bridge;
    if (fleet) ctx.loader.builtins['native-test-fleet-audit'] = createTextFleetAudit(fleetHooks);
    if (pipeline) ctx.loader.builtins['native-test-pipeline'] = createTextPipeline(pipelineHooks);
    if (resources) ctx.loader.builtins['native-test-audit'] = createTextResourceAudit(resourceHooks);
    if (policy) ctx.loader.builtins['native-test-policy'] = createTextPolicyPlugin(policyHooks);
    ctx.loader.builtins['native-test-guard'] = { name: 'native-version-guard', inject: ['rustDynamicText'],
      async apply(child) {
        const { revision } = await child.rustDynamicText.analyze('probe');
        consumerHistory.push(['setup', revision]);
        if (revision === 'v2') throw new Error('Required consumer refuses native v2');
        child.effect(() => () => { consumerHistory.push(['cleanup', revision]); });
      } };
    ctx.loader.builtins['native-test-fleet-guard'] = { name: 'native-fleet-version-guard', inject: ['rustTextFleet'],
      async apply(child) {
        const { revision } = await child.rustTextFleet.list();
        consumerHistory.push(['fleet-setup', revision]);
        if (revision === 'v2' && !fleetGuardRepaired) {
          // A failed candidate must not become the source of rollback state.
          await child.rustTextFleet.create('candidate_only');
          fleetCandidateRejected = true;
          throw new Error('Required consumer refuses native fleet v2 after mutating its catalog');
        }
        if (revision === 'v1' && failFleetRollbackOnce && fleetCandidateRejected && !fleetRollbackRejected && !fleetGuardRepaired) {
          await child.rustTextFleet.create('rollback_only');
          fleetRollbackRejected = true;
          consumerHistory.push(['fleet-rollback-rejected', revision]);
          throw new Error('Required consumer also refuses rollback after mutating its catalog');
        }
      } };
    await mountRootInclude(ctx, configPath, readProfilePatches('dsh', profile));
    await ctx.loader.await();
    await ctx.settle();
    await ctx.plugin(ConfigEditor);
    const entry = ctx.loader.resolve(`include:${nativeId}`), tree = ctx.loader.resolve('include').subtree;
    const readyEntries = [`include:${toolId}`, ...(rejectV2 ? ['include:guard'] : []), ...(rejectFleetV2 ? ['include:fleet-guard'] : [])];
    for (const id of ['include:system', 'include:tools', entry.id, ...readyEntries]) {
      const fiber = ctx.loader.resolve(id).fiber;
      assert(fiber, `Expected real official Loader fiber for ${id}`);
      await fiber.await();
      assert.equal(fiber.state, 2, `${id} should be active`);
    }
    return { ctx, directory, patchPath, manifests, entry, tree, readyEntries, consumerHistory, generatedEntries,
      ...(rejectFleetV2 ? { repairFleetGuard() { fleetGuardRepaired = true; } } : {}),
      ...(fleetHmr ? { async reloadBridge(version) { await writeBridge(version); ctx.hmr.stashed.add(bridgeUrl); return ctx.hmr.partialReload(); } } : {}),
      editor: ctx.configEditor, driver: ctx.fiber._domain.driver, pid: process.pid,
      ...(policy ? { policyEntry: ctx.loader.resolve(`include:${policyId}`) } : {}),
      ...(resources ? { auditEntry: ctx.loader.resolve(`include:${auditId}`) } : {}),
      ...(fleet ? { fleetAuditEntry: ctx.loader.resolve(`include:${fleetAuditId}`) } : {}),
      ...(pipeline ? { pipelineEntry: ctx.loader.resolve(`include:${pipelineId}`) } : {}),
      transactions: new LoaderTransactions(ctx, tree),
      async execute({ name, arguments: toolArguments, text = 'Hello 世界', chunkCharacters, signal = new AbortController().signal } = {}) {
        return ctx.tools.execute({ callId: `native-loader-${++calls}`, name: name ?? (fleet ? 'rust_text_notes_analyze' : pipeline ? 'rust_js_text_analyze' : resources ? 'rust_resource_text_analyze' : policy ? 'rust_policy_text_analyze' : 'rust_dynamic_text_analyze'),
          arguments: toolArguments ?? { text, ...(chunkCharacters === undefined ? {} : { chunkCharacters }) }, signal });
      },
      async update(revision, options = {}) {
        const manifest = manifests[revision];
        return updateOfficialRustModule(ctx, entry.id, manifest.manifestPath,
          { sha256: manifest.manifestSha256, readyEntries, ...options });
      },
      async dispose() {
        try { await ctx.dispose(); assert.equal(ctx.snapshot().plugins.length, 0); }
        finally { await rm(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    try { await ctx.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}
async function assertRevision(f, revision) {
  const result = await f.execute();
  assert.equal(result.isError, false);
  assert.equal(result.value.revision, revision);
  assert.equal(result.value.bytes, 12);
  assert.equal(result.value.characters, 8);
}


export { fixture, assertRevision, SettingsForms, watchOfficialRustModule, readNativeModule };
