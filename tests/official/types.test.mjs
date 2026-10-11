import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

test('official application transactions retain their public TypeScript contracts', () => {
  const manifest = require.resolve('typescript/package.json');
  const compiler = resolve(dirname(manifest), require(manifest).bin.tsc);
  const result = spawnSync(process.execPath, [compiler, '--project', fileURLToPath(new URL('../types/tsconfig.json', import.meta.url)), '--pretty', 'false'], { encoding: 'utf8', timeout: 20000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
