import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context } from '../../official-runtime/node_modules/@cordis-verus/compat-harness/index.js';
import { addonEvidenceRelativePath, addonRelativePath, projectRoot, verifyRustAddon } from '../../scripts/verify-rust-addon.mjs';

const stale = error => /STALE_EPISODE|no longer admitted|not available|inactive/.test(`${error.code}: ${error.message}`);
test('a real Rust tool backend shares the Harness graph and retires its old method', async () => {
  const { addonPath } = await verifyRustAddon();
  const ctx = new Context({ addon: addonPath });
  try {
    const backend = await ctx.rustPlugin('harness.text-analysis');
    let service;
    const consumer = await ctx.inject(['rustTextAnalysis'], child => { service = child.rustTextAnalysis; });
    assert.equal(ctx.snapshot().plugins.length, 3, 'one root, one Rust backend, one JS consumer');
    assert.deepEqual(await service.analyze('Hello 世界\r\nRust 🦀\n'), {
      backend: 'rust', version: '0.1.0', bytes: 24, characters: 17, lines: 2, words: 4,
    });
    assert.deepEqual(await service.analyze(''), {
      backend: 'rust', version: '0.1.0', bytes: 0, characters: 0, lines: 0, words: 0,
    });
    await assert.rejects(service.analyze(42), /exactly one string/);
    await assert.rejects(service.analyze('x', 'unexpected'), /exactly one string/);
    await assert.rejects(service.analyze('x'.repeat(1_048_577)), /1048576 UTF-8 bytes/);
    const oldMethod = service.analyze;
    await backend.restart();
    await consumer.await();
    assert.throws(() => oldMethod('old episode'), stale);
    assert.equal((await service.analyze('new episode')).words, 2);
  } finally { await ctx.dispose(); }
  assert.equal(ctx.snapshot().plugins.length, 0, 'native removal completes before test returns');
});

test('Rust addon evidence is portable and rejects source, binary and runtime drift', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'cordis-harness-rust-evidence-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { evidence } = await verifyRustAddon();
  const paths = [...Object.keys(evidence.inputs), addonEvidenceRelativePath, addonRelativePath,
    'sources.lock.json', '.vendor/cordis/provenance/package-report.json'];
  for (const file of paths) {
    const destination = path.join(temporary, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(projectRoot, file), destination);
  }
  await cp(path.join(projectRoot, 'official-runtime/node_modules/@cordis-verus/compat-cordis'),
    path.join(temporary, 'official-runtime/node_modules/@cordis-verus/compat-cordis'), { recursive: true });
  assert(!(await readFile(path.join(temporary, addonEvidenceRelativePath), 'utf8')).includes(projectRoot),
    'portable manifest must not contain checkout paths');
  assert.equal((await verifyRustAddon({ root: temporary })).evidence.factory, 'harness.text-analysis');
  async function mutate(file, transform, expected) {
    const location = path.join(temporary, file), original = await readFile(location);
    try {
      await writeFile(location, transform(original));
      await assert.rejects(verifyRustAddon({ root: temporary }), expected);
    } finally { await writeFile(location, original); }
  }
  await t.test('changed Rust source requires rebuild', () => mutate('native/text-analysis/src/lib.rs',
    bytes => Buffer.concat([bytes, Buffer.from('\n// source changed\n')]), /sources changed/));
  await t.test('changed addon bytes are rejected', () => mutate(addonRelativePath,
    bytes => Buffer.concat([bytes, Buffer.from('changed')]), /bytes differ/));
  await t.test('an unrecorded Rust source is rejected', async () => {
    const extra = path.join(temporary, 'native/text-analysis/src/extra.rs');
    await writeFile(extra, '// unrecorded\n');
    try { await assert.rejects(verifyRustAddon({ root: temporary }), /sources changed/); }
    finally { await rm(extra); }
  });
  await t.test('core provenance cannot be replaced', () => mutate('.vendor/cordis/provenance/package-report.json',
    bytes => Buffer.concat([bytes, Buffer.from('\n')]), /report differs from approved/));
  await t.test('installed runtime drift is rejected', () => mutate('official-runtime/node_modules/@cordis-verus/compat-cordis/runtime.js',
    bytes => Buffer.concat([bytes, Buffer.from('\n// runtime changed\n')]), /runtime differs/));
});
