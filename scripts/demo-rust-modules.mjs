#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRustModule } from '@cordis-verus/compat-loader/rust-module';
import { createHarness } from '../src/app.mjs';
import { verifyRustModules } from './verify-rust-modules.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function runRustModuleDemo(workspace) {
  const { artifacts, manifestSha256 } = await verifyRustModules({ runtime: 'slim' });
  const app = await createHarness({ base: root, workspace, sessionDirectory: path.join(workspace, 'sessions'), plugins: [],
    provider: { type: 'scripted', model: 'demo', options: {
      steps: [{ name: 'rust_dynamic_text_analyze', arguments: { text: 'Hello 世界\r\nRust 🦀\n' } }],
    } },
  });
  const pid = process.pid, driver = app.ctx.fiber._domain.driver;
  let controller, report;
  try {
    controller = await loadRustModule(app.ctx, { ...artifacts.v1,
      plugins: [{ id: 'analysis', factory: 'harness.dynamic-text-analysis' }] });
    await app.loadPlugin({ id: 'native-tool', module: './plugins/dynamic-text-analysis.mjs' });
    async function turn(sessionId, revision) {
      const result = await app.run('Analyze the sample text with the Rust tool.', { sessionId });
      assert.equal(result.ok, true);
      assert.deepEqual(result.toolCalls.map(call => call.name), ['rust_dynamic_text_analyze']);
      const stored = await app.inspect(sessionId, 0, 200);
      const callId = result.toolCalls[0].callId;
      const messages = stored.events.filter(event => event.type === 'tool/result'
        && event.data.message.toolCallId === callId).map(event => event.data.message);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].isError, false);
      assert.equal(messages[0].content.length, 1);
      assert.equal(messages[0].content[0].type, 'text');
      const value = JSON.parse(messages[0].content[0].text);
      assert.equal(value.backend, 'rust-dynamic');
      assert.equal(value.revision, revision);
      assert.equal(value.bytes, 24); assert.equal(value.characters, 17);
      assert.equal(value.words, 4); assert.equal(value.lines, 2);
      return { sessionId, events: stored.events.length, value };
    }
    const v1 = await turn('rust-v1', 'v1'), old = app.ctx.rustDynamicText;
    const first = controller.snapshot();
    await controller.reload(artifacts.v2);
    assert.throws(() => old.analyze('retired'), /STALE|inactive|released|admitted/i);
    const v2 = await turn('rust-v2', 'v2');
    const second = controller.snapshot();
    assert.notEqual(first.entries[0].factoryRef, second.entries[0].factoryRef);
    await assert.rejects(controller.reload(artifacts.fail), error => error.code === 'NATIVE_MODULE_RELOAD_FAILED' && error.details.restored);
    const restored = await turn('rust-restored', 'v2');
    assert.equal(controller.snapshot().entries[0].factoryRef, second.entries[0].factoryRef);
    assert.equal(app.ctx.fiber._domain.driver, driver); assert.equal(process.pid, pid);
    report = { schema: 'cordis-harness.rust-module-demo/v1', pid, provider: 'scripted', paidModelRequests: false,
      singleDriver: true, manifestSha256, runs: [v1, v2, restored], candidateFailureRestored: true,
      unloadSupported: false, diagnostics: controller.inspect().images };
    await controller.dispose();
    report.cleanupDiagnostics = controller.inspect().images;
    for (const module of report.cleanupDiagnostics.modules) {
      assert.deepEqual(module.resources, { instances: 0, jobs: 0, reverseCalls: 0, streams: 0, objects: 0, retainedInstances: 0, retainedJobs: 0, retainedReverseCalls: 0, retainedStreams: 0, retainedObjects: 0 });
    }
    assert.equal(app.tools().some(tool => tool.name === 'rust_dynamic_text_analyze'), false);
  } finally { await app.close(); }
  report.nativePluginsAtExit = app.ctx.snapshot().plugins.length;
  assert.equal(report.nativePluginsAtExit, 0);
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/demo-rust-modules.mjs');
  const directory = path.join(root, '.cordis-harness/demos');
  await mkdir(directory, { recursive: true });
  const workspace = await mkdtemp(path.join(directory, 'rust-modules-'));
  console.log(JSON.stringify({ ...await runRustModuleDemo(workspace), workspace }, null, 2));
}
