#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = async file => digest(await readFile(file));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const relative = file => path.relative(root, file).split(path.sep).join('/');
assert(!process.env.ESBUILD_BINARY_PATH, 'Build evidence requires the installed esbuild binary, without ESBUILD_BINARY_PATH');
const lock = await json(path.join(root, 'sources.lock.json'));
assert.equal(lock.schema, 'cordis-harness.sources/v1');
const officialRoot = path.join(root, lock.deepseekHarness.sourceDirectory);
const output = path.join(root, 'dist/upstream/plugins.mjs');
const reportPath = path.join(root, 'dist/build-report.json');
await mkdir(path.dirname(output), { recursive: true });
await rm(reportPath, { force: true });
const inputs = {};
async function add(file) {
  const name = relative(path.resolve(file));
  assert(!name.startsWith('../') && !path.isAbsolute(name), `Build input outside project: ${name}`);
  const actual = await hash(path.join(root, name));
  if (inputs[name]) assert.equal(actual, inputs[name], `Input changed during build: ${name}`);
  inputs[name] = actual;
}
async function verifySnapshot() {
  const snapshotPath = path.join(root, lock.deepseekHarness.snapshotFile);
  assert.equal(await hash(snapshotPath), lock.deepseekHarness.snapshotSha256, 'Official source manifest differs from lock');
  const records = await json(snapshotPath);
  const seen = [];
  async function visit(at) {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      const name = path.relative(officialRoot, file).split(path.sep).join('/');
      if (entry.isDirectory()) await visit(file);
      else {
        const expected = records[name];
        assert(expected, `Unexpected official source: ${name}`);
        if (entry.isSymbolicLink()) assert.equal(await readlink(file), expected.symlink, `Official symlink changed: ${name}`);
        else { assert(entry.isFile() && expected.sha256, `Official source type changed: ${name}`); assert.equal(await hash(file), expected.sha256, `Official source changed: ${name}`); }
        seen.push(name);
      }
    }
  }
  await visit(officialRoot);
  assert.deepEqual(seen.sort(), Object.keys(records).sort(), 'Official source snapshot is incomplete');
  await add(snapshotPath);
}
await verifySnapshot();
for (const file of ['package.json', 'package-lock.json', 'sources.lock.json', 'scripts/build.mjs', 'scripts/bootstrap.mjs', 'scripts/install-artifacts.mjs', 'scripts/verify-install.mjs', 'scripts/runtime-packages.mjs', 'scripts/core-review.mjs', 'scripts/npm-command.mjs', 'src/upstream.ts']) await add(path.join(root, file));
async function toolFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Linked compiler input: ${relative(file)}`);
    if (entry.isDirectory()) await toolFiles(file);
    else { assert(entry.isFile()); await add(file); }
  }
}
await toolFiles(path.join(root, 'node_modules/esbuild'));
await toolFiles(path.join(root, 'node_modules/@esbuild'));
for (const item of lock.cordis.archives) assert.equal(await hash(path.join(root, item.file)), item.sha256, `Runtime archive differs: ${item.name}`);
const packages = new Map();
async function catalog(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await catalog(file);
    else if (entry.name === 'package.json') {
      const manifest = await json(file);
      if (!manifest.name?.startsWith('@deepseek-ai/')) continue;
      assert(!packages.has(manifest.name), `Duplicate official package: ${manifest.name}`);
      packages.set(manifest.name, { directory, manifest, file });
    }
  }
}
await catalog(path.join(officialRoot, 'packages'));
await catalog(path.join(officialRoot, 'vendor'));
const resolvedPackages = {};
const result = await build({
  absWorkingDir: root, entryPoints: ['src/upstream.ts'], outfile: output,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true,
  sourcemap: false, legalComments: 'eof',
  plugins: [{ name: 'immutable-official-harness', setup(builder) {
    builder.onResolve({ filter: /^@deepseek-ai\// }, async args => {
      if (args.path === '@deepseek-ai/cordis') return { path: args.path, external: true };
      assert(!args.path.startsWith('@deepseek-ai/cordis/'), `Unsupported Cordis deep import: ${args.path}`);
      const [, name, suffix] = args.path.match(/^(@deepseek-ai\/[^/]+)(?:\/(.*))?$/) ?? [];
      const entry = packages.get(name);
      assert(entry, `Unknown official package: ${args.path}`);
      await add(entry.file);
      let file;
      if (!suffix) file = 'src/index.ts';
      else if (suffix.startsWith('src/')) file = suffix;
      else if (suffix === 'package.json') file = suffix;
      else {
        const exported = entry.manifest.exports?.[`./${suffix}`];
        const target = typeof exported === 'string' ? exported : exported?.default ?? exported?.import;
        assert(target?.startsWith('./lib/'), `Unsupported official source export: ${args.path}`);
        file = target.replace(/^\.\/lib\/(?:types\/)?/, 'src/').replace(/\.[mc]?js$/, '.ts');
      }
      const resolved = path.resolve(entry.directory, file);
      assert(resolved.startsWith(officialRoot + path.sep), `Source export escapes snapshot: ${args.path}`);
      await access(resolved);
      resolvedPackages[args.path] = relative(resolved);
      return { path: resolved };
    });
    builder.onResolve({ filter: /^(cordis(?:\/|$)|@cordisjs\/)/ }, args => { throw new Error(`Mixed Cordis profile import: ${args.path}`); });
    builder.onResolve({ filter: /^@validation-engineering\// }, args => ({ path: args.path, external: true }));
  } }],
});
for (const name of Object.keys(result.metafile.inputs)) {
  assert(!name.includes('/vendor/cordis/'), 'The upstream JS scheduler was accidentally bundled');
  assert(!name.includes('node_modules/@validation-engineering/'), 'A compatibility facade was accidentally bundled');
  await add(path.resolve(root, name));
}
for (const name of [
  'packages/core/agent/src/index.ts', 'packages/core/agent-loop/src/index.ts',
  'packages/core/session/src/index.ts', 'packages/core/tools/src/index.ts',
  'packages/core/scope/src/index.ts', 'packages/core/system-prompt/src/index.ts',
  'packages/llm/llm/src/index.ts', 'packages/llm/llm-deepseek-api-key/src/index.ts',
  'packages/todo/tool-todo/src/index.ts',
]) assert(Object.hasOwn(result.metafile.inputs, relative(path.join(officialRoot, name))), `Missing official module: ${name}`);
const outputs = {};
for (const [name, metadata] of Object.entries(result.metafile.outputs)) {
  for (const item of metadata.imports) {
    assert(item.external, `Unexpected untracked output import: ${item.path}`);
    assert(!path.isAbsolute(item.path) && !item.path.startsWith('file:'), `Nonportable output import: ${item.path}`);
    assert(item.path.startsWith('node:') || item.path === '@deepseek-ai/cordis' || item.path.startsWith('@validation-engineering/'), `Unexpected external dependency: ${item.path}`);
  }
  outputs[name] = await hash(path.resolve(root, name));
}
const manifest = path.join(officialRoot, 'packages/llm/llm/package.json');
await add(manifest);
await copyFile(manifest, path.join(root, 'dist/package.json'));
outputs['dist/package.json'] = await hash(manifest);
const notices = [];
for (const [name, file, original] of [
  ['DeepSeek Harness (MIT)', 'third-party/DeepSeek-Harness.LICENSE', `${lock.deepseekHarness.sourceDirectory}/LICENSE`],
  ['Zod (MIT)', 'third-party/Zod.LICENSE', 'node_modules/zod/LICENSE'],
  ['eventsource-parser (MIT)', 'third-party/eventsource-parser.LICENSE', 'node_modules/eventsource-parser/LICENSE'],
]) {
  assert.equal(await hash(path.join(root, file)), await hash(path.join(root, original)), `License differs from dependency: ${name}`);
  await add(path.join(root, file)); await add(path.join(root, original));
  notices.push(`${name}\n${await readFile(path.join(root, file), 'utf8')}`);
}
await writeFile(path.join(root, 'dist/THIRD-PARTY-NOTICES.txt'), notices.join('\n\n'));
outputs['dist/THIRD-PARTY-NOTICES.txt'] = await hash(path.join(root, 'dist/THIRD-PARTY-NOTICES.txt'));
for (const [name, expected] of Object.entries(inputs)) assert.equal(await hash(path.join(root, name)), expected, `Build source changed: ${name}`);
const report = {
  schema: 'cordis-harness.build/v1', status: 'passed', node: process.version, esbuild: esbuildVersion,
  upstream: { revision: lock.deepseekHarness.revision, tree: lock.deepseekHarness.tree, sourceUnmodified: true },
  runtimeSourceFingerprint: lock.cordis.sourceFingerprint,
  runtimeResolution: 'bare @deepseek-ai/cordis -> explicit cordis-compat-deepseek/register hook; single installed Rust-backed runtime',
  inputs, outputs, resolvedPackages,
  requiredPreload: '@validation-engineering/cordis-compat-deepseek/register',
  runtimeAssets: { 'dist/package.json': relative(manifest) },
  claims: { completeHarnessCompatibility: false, crossPlatformAcceptance: false, hostCallbackProof: false },
};
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`Built unchanged official Harness modules: ${Object.keys(resolvedPackages).length} package imports, ${Object.keys(inputs).length} inputs.`);
