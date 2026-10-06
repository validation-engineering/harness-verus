import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runRustModuleDemo } from '../../scripts/demo-rust-modules.mjs';

test('real official AgentLoop consumes v1, v2, and restored Rust code in one host process', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'cordis-native-agent-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const result = await runRustModuleDemo(workspace);
  assert.deepEqual(result.runs.map(run => run.value.revision), ['v1', 'v2', 'v2']);
  assert(result.runs.every(run => run.events > 0));
  assert.equal(result.nativePluginsAtExit, 0);
  assert.equal(result.paidModelRequests, false);
});
