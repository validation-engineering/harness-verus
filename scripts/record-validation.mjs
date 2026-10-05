#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const recordPath = join(root, 'docs/validation-report.json');
const logPath = join(root, '.cordis-harness/validation.log');
const digest = data => createHash('sha256').update(data).digest('hex');
const hash = async path => digest(await readFile(resolve(root, path)));
const schema = 'cordis-harness.validation/v1';
async function sources() {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const names = [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
  const hashes = {};
  for (const name of names) {
    if (name === 'docs/validation-report.json') continue;
    assert((await lstat(join(root, name))).isFile(), `Source must be a regular file: ${name}`);
    hashes[name] = await hash(name);
  }
  return hashes;
}
function command(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  return { args, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
let report = { schema, status: 'running', proofExecuted: false, releaseAcceptance: false, paidModelRequests: false,
  platform: process.platform, architecture: process.arch, node: process.version, startedAt: new Date().toISOString() };
assert(process.argv.length <= 3 && (!process.argv[2] || process.argv[2] === '--check'), 'Usage: record-validation.mjs [--check]');
if (process.argv[2] === '--check') {
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(record.schema, schema); assert.equal(record.status, 'passed');
  assert.equal(record.proofExecuted, false); assert.equal(record.releaseAcceptance, false);
  assert.equal(record.node, process.version, 'Node version differs from the validated environment');
  assert.equal(record.platform, process.platform, 'Platform differs from the validated environment');
  assert.equal(record.architecture, process.arch, 'Architecture differs from the validated environment');
  assert.deepEqual(record.sourceHashes, await sources(), 'Application validation is stale');
  assert.equal(record.buildReportSha256, await hash('dist/build-report.json'), 'Build evidence changed');
  assert.equal(record.logSha256, await hash('.cordis-harness/validation.log'), 'Validation log changed');
  const verified = command(['scripts/verify-install.mjs']);
  assert.equal(verified.status, 0, verified.stderr);
  console.log(`Validation matches ${Object.keys(record.sourceHashes).length} source files, the installed runtime, and the recorded Node/platform/architecture. Hash check only.`);
} else {
  await mkdir(join(root, '.cordis-harness'), { recursive: true });
  await writeFile(recordPath, JSON.stringify(report, null, 2) + '\n');
  const before = await sources();
  const runs = [];
  try {
    const buildReportSha256 = await hash('dist/build-report.json');
    const files = (await readdir(join(root, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => 'tests/' + name);
    for (const args of [
      ['scripts/verify-install.mjs'],
      ['--import', '@cordis-verus/compat-harness/register', '--test', '--test-timeout=30000', '--test-reporter=tap', ...files],
      ['src/cli.mjs', 'demo', '--json'],
      ['scripts/verify-install.mjs'],
    ]) {
      const run = command(args); runs.push(run);
      assert.equal(run.error, undefined, JSON.stringify(run));
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(run.signal, null);
    }
    const tests = {};
    for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
      const matches = [...runs[1].stdout.matchAll(new RegExp('^# ' + name + ' (\\d+)$', 'gm'))];
      assert.equal(matches.length, 1, `Ambiguous test summary: ${name}`);
      tests[name] = Number(matches[0][1]);
    }
    assert(tests.tests > 0); assert.equal(tests.tests, tests.pass);
    for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(tests[name], 0);
    const demo = JSON.parse(runs[2].stdout.trim());
    assert.equal(demo.ok, true); assert.equal(demo.provider, 'scripted');
    assert.deepEqual(demo.toolCalls.map(call => call.name), ['todo_write', 'workspace_read', 'workspace_write', 'todo_write']);
    assert.match(await readFile(join(demo.workspace, 'DEMO_RESULT.md'), 'utf8'), /official AgentLoop/);
    assert.deepEqual(await sources(), before, 'Sources changed during validation');
    assert.equal(await hash('dist/build-report.json'), buildReportSha256, 'Build evidence changed during validation');
    const log = runs.map(run => JSON.stringify(run)).join('\n') + '\n'; await writeFile(logPath, log);
    report = { ...report, status: 'passed', checkedAt: new Date().toISOString(), tests,
      demo: { provider: demo.provider, toolCalls: demo.toolCalls.map(call => call.name), events: demo.eventCount, resultFileConfirmed: true },
      sourceHashes: before, sourceFingerprint: digest(JSON.stringify(before)), buildReportSha256, logSha256: digest(log) };
    await writeFile(recordPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Recorded ${tests.pass} passing tests, independent runtime verification, and the real official AgentLoop demo.`);
  } catch (error) {
    await writeFile(logPath, runs.map(run => JSON.stringify(run)).join('\n') + '\n');
    await writeFile(recordPath, JSON.stringify({ ...report, status: 'failed', failure: error.stack ?? String(error) }, null, 2) + '\n');
    throw error;
  }
}
