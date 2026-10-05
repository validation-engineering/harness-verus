import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
test('distribution evidence remains portable and rejects changed inputs', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'cordis-harness-evidence-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const build = JSON.parse(await readFile(path.join(root, 'dist/build-report.json'), 'utf8'));
  const files = new Set([...Object.keys(build.inputs), ...Object.keys(build.outputs),
    'dist/build-report.json', 'scripts/verify-install.mjs', 'sources.lock.json', 'package-lock.json']);
  for (const name of files) {
    const destination = path.join(temporary, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(root, name), destination);
  }
  for (const directory of ['node_modules', '.vendor/cordis']) {
    await cp(path.join(root, directory), path.join(temporary, directory), { recursive: true, verbatimSymlinks: true });
  }
  function verify() {
    const env = { ...process.env };
    for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'CORDIS_NATIVE_BINDING', 'ESBUILD_BINARY_PATH']) delete env[name];
    return spawnSync(process.execPath, ['scripts/verify-install.mjs'], { cwd: temporary, env, encoding: 'utf8', timeout: 10000 });
  }
  async function change(file, value, check) {
    const location = path.join(temporary, file);
    const before = await readFile(location);
    try { await writeFile(location, value(before)); await check(verify()); }
    finally { await writeFile(location, before); }
  }
  const fails = pattern => result => { assert.notEqual(result.status, 0); assert.match(result.stderr, pattern); };
  await t.test('verifies an extracted installation copied outside the original project', async () => {
    for (const name of ['sources.lock.json', 'package-lock.json', 'dist/build-report.json']) {
      assert(!(await readFile(path.join(temporary, name), 'utf8')).includes(root), `Absolute project path in ${name}`);
    }
    const result = verify();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /unique Harness Context/);
  });
  await t.test('rejects incomplete evidence with no recorded outputs', () => change('dist/build-report.json', before => {
    const report = JSON.parse(before); report.outputs = {}; return JSON.stringify(report);
  }, fails(/Incomplete build evidence: output/)));
  await t.test('rejects a changed application export input', () => change('src/upstream.ts', before => Buffer.concat([before, Buffer.from('\n// changed\n')]), fails(/Stale build: src\/upstream.ts/)));
  await t.test('rejects a changed official AgentLoop source', () => change('.cache/upstream/deepseek-harness/packages/core/agent-loop/src/index.ts', before => Buffer.concat([before, Buffer.from('\n// changed\n')]), fails(/Stale build:.*agent-loop\/src\/index.ts/)));
  await t.test('rejects a changed generated bundle', () => change('dist/upstream/plugins.mjs', before => Buffer.concat([before, Buffer.from('\n// changed\n')]), fails(/Stale build: dist\/upstream\/plugins.mjs/)));
  await t.test('rejects a changed tarball', () => change('.vendor/cordis/cordis-verus-compat-harness-0.1.0.tgz', before => Buffer.concat([before, Buffer.from('changed')]), fails(/Archive differs from source lock/)));
  await t.test('rejects installed facade modifications', () => change('node_modules/@cordis-verus/compat-harness/index.js', before => Buffer.concat([before, Buffer.from('\n// changed\n')]), fails(/Installed package changed/)));
  await t.test('rejects unrecorded files inside a runtime package', async () => {
    const extra = path.join(temporary, 'node_modules/@cordis-verus/compat-harness/unrecorded.mjs');
    await writeFile(extra, 'export const hidden = true;');
    try { fails(/Unexpected runtime package content/)(verify()); } finally { await rm(extra); }
  });
  await t.test('rejects source links in the dependency lock', () => change('package-lock.json', before => {
    const lock = JSON.parse(before);
    lock.packages['node_modules/@cordis-verus/compat-harness'].link = true;
    return JSON.stringify(lock);
  }, fails(/Linked dependency in npm lock/)));
});
