import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRustModules } from '../../scripts/verify-rust-modules.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
function run(args, env) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env,
    timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  return result;
}
const environment = home => ({ PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home,
  DSH_HOME: join(home, 'dsh'), DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' });

test('official native launcher initializes immutable module entries and preserves user patches', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cordis-native-launcher-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = environment(home), { published } = await verifyRustModules();
  const first = run(['scripts/official-native.mjs', 'web', '--dump-config'], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /cordis:rust-module/);
  assert.match(first.stdout, /rust-dynamic-text-analysis\.mjs/);
  assert(first.stdout.includes(published.v1.config.sha256), 'Dump must reference the verified immutable image');
  for (const profile of ['web', 'headless']) {
    const patch = join(env.DSH_HOME, `profiles/${profile}/cordis.patch.yml`);
    const rows = JSON.parse(await readFile(patch, 'utf8'))[0].insert;
    assert.deepEqual(rows.find(row => row.name === 'cordis:rust-module').config, published.v1.config);
  }
  const patch = join(env.DSH_HOME, 'profiles/web/cordis.patch.yml');
  const custom = (await readFile(patch, 'utf8')) + '\n# retained native user configuration\n';
  await writeFile(patch, custom);
  const second = run(['scripts/official-native.mjs', 'web', '--dump-config'], env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(patch, 'utf8'), custom);
  const completeRows = JSON.parse(custom.split('\n#')[0])[0].insert;
  for (const missing of ['cordis:rust-module', completeRows.find(row => row.name.endsWith('rust-dynamic-text-analysis.mjs')).name]) {
    const ordinary = JSON.stringify([{ insert: completeRows.filter(row => row.name !== missing) }], null, 2) + '\n# user controls this existing profile\n';
    await writeFile(patch, ordinary);
    const rejected = run(['scripts/official-native.mjs', 'web', '--dump-config'], env);
    assert.notEqual(rejected.status, 0, 'Missing native entries must not silently start an ordinary profile');
    assert.match(rejected.stderr, /Native Rust profile web is missing or replaces the required rust-module \/ rust-dynamic-tool entries/);
    assert.equal(await readFile(patch, 'utf8'), ordinary, 'Reject without overwriting the user profile');
  }
});

test('official native launcher rejects ambient unverified addon overrides before runtime startup', () => {
  const result = run(['scripts/official-native.mjs', 'web', '--dump-config'],
    { ...process.env, CORDIS_NATIVE_BINDING: '/unverified/addon.node' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unset CORDIS_NATIVE_BINDING/);
});

test('dynamic default-app acceptance rejects upstream and mixed native backends', () => {
  for (const [args, expected] of [
    [['--backend', 'upstream', '--dynamic'], /Dynamic Rust modules require the native backend/],
    [['--backend', 'native', '--dynamic', '--rust'], /mutually exclusive/],
  ]) {
    const result = run(['scripts/check-official-extensions.mjs', ...args], { PATH: process.env.PATH ?? '' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});
