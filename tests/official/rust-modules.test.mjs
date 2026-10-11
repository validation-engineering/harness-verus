import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { projectRoot } from '../../scripts/verify-rust-addon.mjs';
import { verifyRustModules, moduleEvidenceRelativePath } from '../../scripts/verify-rust-modules.mjs';

await import('../../scripts/official-register.mjs');
const { Context } = await import('@deepseek-ai/cordis');
const { loadRustModule } = await import('@validation-engineering/cordis-loader/rust-module');
const { ToolRuntime } = await import('@deepseek-ai/dsh-tools');
const { SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt');
const bridge = await import('../../examples/official/rust-dynamic-text-analysis.mjs');

test('installed official ToolRuntime follows native generations and unregisters on module disposal', async () => {
  const { artifacts } = await verifyRustModules();
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime);
    const controller = await loadRustModule(ctx, { ...artifacts.v1,
      plugins: [{ id: 'analysis', factory: 'harness.dynamic-text-analysis' }] });
    const consumer = await ctx.plugin(bridge), driver = ctx.fiber._domain.driver;
    let sequence = 0;
    async function execute() {
      return ctx.tools.execute({ callId: `dynamic-${++sequence}`, name: 'rust_dynamic_text_analyze',
        arguments: { text: 'Hello 世界' }, signal: new AbortController().signal });
    }
    const first = await execute();
    assert.equal(first.isError, false); assert.equal(first.value.revision, 'v1');
    assert.equal(first.value.bytes, 12); assert.equal(first.value.characters, 8);
    await controller.reload(artifacts.v2);
    const second = await execute();
    assert.equal(second.isError, false); assert.equal(second.value.revision, 'v2');
    await assert.rejects(controller.reload(artifacts.fail), error => error.details?.restored === true);
    assert.equal((await execute()).value.revision, 'v2');
    assert.equal(ctx.fiber._domain.driver, driver);
    await controller.dispose();
    assert.equal(ctx.tools.get('rust_dynamic_text_analyze'), undefined);
    assert.equal((await execute()).isError, true);
    await consumer.dispose();
  } finally { await ctx.dispose(); }
  assert.equal(ctx.snapshot().plugins.length, 0);
});

test('dynamic artifact evidence rejects source, bytes, and installed runtime drift', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'cordis-dynamic-evidence-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { evidence, artifacts, published } = await verifyRustModules();
  const paths = [...Object.keys(evidence.inputs), moduleEvidenceRelativePath,
    ...Object.values(artifacts).map(item => path.relative(projectRoot, item.path)),
    ...Object.values(published).flatMap(item => [item.manifestPath, item.config.path].map(file => path.relative(projectRoot, file))),
    'sources.lock.json', '.vendor/cordis/provenance/package-report.json'];
  for (const file of paths) {
    const destination = path.join(temporary, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(projectRoot, file), destination);
  }
  for (const name of ['cordis', 'cordis-compat-deepseek', 'cordis-loader']) {
    await cp(path.join(projectRoot, 'node_modules/@validation-engineering', name),
      path.join(temporary, 'node_modules/@validation-engineering', name), { recursive: true });
  }
  assert(!(await readFile(path.join(temporary, moduleEvidenceRelativePath), 'utf8')).includes(projectRoot));
  await verifyRustModules({ root: temporary });
  async function mutate(file, suffix, expected) {
    const location = path.join(temporary, file), original = await readFile(location);
    try {
      await writeFile(location, Buffer.concat([original, Buffer.from(suffix)]));
      await assert.rejects(verifyRustModules({ root: temporary }), expected);
    } finally { await writeFile(location, original); }
  }
  await mutate('native/dynamic-text-analysis/src/lib.rs', '\n// changed\n', /sources changed/);
  await mutate(path.relative(projectRoot, artifacts.v2.path), 'changed', /bytes differ/);
  await mutate('node_modules/@validation-engineering/cordis/runtime.js', '\n// changed\n', /runtime differs/);
  await mutate('node_modules/@validation-engineering/cordis-loader/rust-module.js', '\n// changed\n', /runtime differs/);
});
