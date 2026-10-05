import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
test('official entry routes ESM, CJS and inherited ESM file Workers and rejects the original host implementation', () => {
  const result = spawnSync(process.execPath, ['--import', './scripts/official-register.mjs', 'tests/official/bootstrap-fixture.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH ?? '', NO_COLOR: '1' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { mainProfile: 'harness', uniqueEsmCjsContext: true, upstreamEntryRejected: true, inheritedWorkerProfile: 'harness' });
});
