#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { verifyOfficial, evidencePath } from './verify-official.mjs';
import { assertEquivalentRoster, generatedIdModules } from './official-roster.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportPath = resolve(root, 'docs/official-validation-report.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = async path => digest(await readFile(resolve(root, path)));
const env = () => ({ node: process.version, platform: process.platform, architecture: process.arch });
async function execute(command, args, timeout = 180000) {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  // Integration scripts own their children and handle SIGTERM by cleaning up.
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  try {
    const result = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => done({ code, signal }));
    });
    assert.equal(result.code, 0, stdout + stderr);
    assert.equal(result.signal, null, stdout + stderr);
    return { args, ...result, stdout, stderr };
  } finally { clearTimeout(timer); }
}
async function sources() {
  const result = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  const hashes = {};
  for (const name of [...new Set(result.stdout.split('\0').filter(Boolean))].sort()) {
    // Evidence files do not form circular dependencies on one another.
    if (/validation-report\.json$/.test(name)) continue;
    assert((await lstat(resolve(root, name))).isFile(), `Source is not a file: ${name}`);
    hashes[name] = await hash(name);
  }
  return hashes;
}
const expectedCommands = [
  ['--test', 'tests/official/bootstrap.test.mjs', 'tests/official/roster.test.mjs'],
  ...['web', 'headless'].flatMap(kind => ['upstream', 'native'].map(backend => [`scripts/check-official-${kind}.mjs`, '--backend', backend])),
];
const executionFiles = [
  ...['web', 'headless'].flatMap(kind => ['upstream', 'native'].flatMap(backend => [`.cache/official-${kind}/${backend}.json`, `.cache/official-${kind}/${backend}.log`])),
  '.cache/official/validation-runs.json',
].sort();
function webSummary(reports) {
  const upstream = reports['web/upstream'].checks, native = reports['web/native'].checks;
  assertEquivalentRoster(native.pluginInventory.entries, upstream.pluginInventory.entries);
  assert.deepEqual(native.presets, upstream.presets, 'Default presets differ');
  assert.equal(native.runtime.backend, 'native');
  assert.equal(native.runtime.rootContexts, 1);
  return { officialVersion: reports['web/native'].version, defaultPreset: native.presets.default,
    totalEntries: native.pluginInventory.total, activeEntries: native.pluginInventory.active,
    activeFibers: native.runtime.activeFibers, originalRosterEqual: true,
    rosterComparison: { generatedIdsComparedByModule: generatedIdModules, allOtherEntryIds: 'exact' },
    staticAssets: native.staticAssets.length, browserEntries: native.browserGraph.entries,
    shutdown: native.shutdown };
}
function headlessSummary(reports) {
  const original = reports['headless/upstream'], native = reports['headless/native'];
  assert.equal(native.paidModelRequests, false);
  assert.equal(native.modelTransport, 'loopback HTTP/SSE fixture');
  assert.equal(native.runs.length, 2);
  assert.equal(original.runs.length, 2);
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(native.runs[index].graph.pluginNames, original.runs[index].graph.pluginNames, 'Default headless plugin roster differs');
    assert.equal(native.runs[index].graph.nativeProfile, 'harness');
    assert.equal(native.runs[index].graph.contexts, 1);
    assert.equal(native.runs[index].graph.nativePluginsAtExit, 0);
    assert(native.runs[index].graph.nativeNodesAtExit <= 1);
    assert.equal(native.checks.shutdown[index].forced, false);
    assert.equal(native.checks.shutdown[index].code, 0);
    assert.equal(native.checks.shutdown[index].signal, null);
  }
  assert.equal(native.checks.persistence.prefixPreserved, true);
  assert.equal(native.checks.persistence.independentProcessResume, true);
  const toolCounts = [...new Set(native.requests.filter(request => request.kind !== 'title').map(request => request.tools))];
  assert.deepEqual(toolCounts, [...new Set(original.requests.filter(request => request.kind !== 'title').map(request => request.tools))]);
  return { originalRosterEqual: true, defaultToolCounts: toolCounts,
    loopbackRequests: native.requests.length,
    firstEvents: native.checks.persistence.firstEvents, resumedEvents: native.checks.persistence.resumedEvents,
    prefixPreserved: true, independentProcessResume: true,
    nativePluginsAtExit: native.runs.map(run => run.graph.nativePluginsAtExit),
    shutdown: native.checks.shutdown };
}
async function checkedExecution(hashes) {
  assert.deepEqual(Object.keys(hashes ?? {}).sort(), executionFiles, 'Incomplete official execution evidence');
  for (const path of executionFiles) assert.equal(await hash(path), hashes[path], `Execution evidence changed: ${path}`);
  const reports = {};
  for (const kind of ['web', 'headless']) for (const backend of ['upstream', 'native']) {
    const evidence = JSON.parse(await readFile(resolve(root, `.cache/official-${kind}/${backend}.json`), 'utf8'));
    assert.equal(evidence.status, 'passed'); assert.equal(evidence.backend, backend);
    assert.equal(evidence.evidence, 'installed-artifacts');
    assert.equal(evidence.releaseAcceptance, false);
    assert.equal(evidence.log, `.cache/official-${kind}/${backend}.log`);
    assert.equal(evidence.logSha256, hashes[evidence.log]);
    reports[`${kind}/${backend}`] = evidence;
  }
  const runs = JSON.parse(await readFile(resolve(root, '.cache/official/validation-runs.json'), 'utf8'));
  assert.equal(runs.length, expectedCommands.length);
  for (let index = 0; index < runs.length; index++) {
    assert.deepEqual(runs[index].args, expectedCommands[index]);
    assert.equal(runs[index].code, 0); assert.equal(runs[index].signal, null);
  }
  return reports;
}
const schema = 'cordis-harness.official-validation/v1';
assert(process.argv.length <= 3 && (!process.argv[2] || process.argv[2] === '--check'), 'Usage: record-official-validation.mjs [--check]');
if (process.argv[2] === '--check') {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.schema, schema); assert.equal(report.status, 'passed');
  assert.equal(report.releaseAcceptance, false); assert.equal(report.proofExecuted, false);
  assert.deepEqual(report.environment, env(), 'Validation environment changed');
  assert.deepEqual(report.sourceHashes, await sources(), 'Official-mode source evidence is stale');
  assert.equal(report.sourceFingerprint, digest(JSON.stringify(report.sourceHashes)));
  assert.equal(report.paidModelRequests, false); assert.equal(report.browserExecution, false);
  assert.equal(report.installEvidenceSha256, await hash(evidencePath));
  const evidence = await checkedExecution(report.executionHashes);
  assert.deepEqual(report.web, webSummary(evidence), 'Official Web summary differs from execution evidence');
  assert.deepEqual(report.headless, headlessSummary(evidence), 'Official headless summary differs from execution evidence');
  await verifyOfficial();
  console.log('Official-mode validation matches source, installed artifacts, execution logs, and environment. Hash check only.');
} else {
  await mkdir(resolve(root, '.cache/official'), { recursive: true });
  const report = { schema, status: 'running', environment: env(), startedAt: new Date().toISOString(),
    scope: 'Official npm Web/standard and headless; only Node-host Cordis replaced. Browser Cordis remains official JavaScript.',
    proofExecuted: false, releaseAcceptance: false, paidModelRequests: false, browserExecution: false };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  try {
    await verifyOfficial();
    const before = await sources(), installEvidenceSha256 = await hash(evidencePath);
    const reports = {}, executionHashes = {}, runs = [];
    runs.push(await execute(process.execPath, ['--test', 'tests/official/bootstrap.test.mjs', 'tests/official/roster.test.mjs']));
    for (const kind of ['web', 'headless']) for (const backend of ['upstream', 'native']) {
      console.log(`Checking official ${kind} with ${backend} Cordis...`);
      runs.push(await execute(process.execPath, [`scripts/check-official-${kind}.mjs`, '--backend', backend]));
      const file = `.cache/official-${kind}/${backend}.json`;
      const evidence = JSON.parse(await readFile(resolve(root, file), 'utf8'));
      assert.equal(evidence.status, 'passed'); assert.equal(evidence.backend, backend);
      assert.equal(evidence.evidence, 'installed-artifacts');
      reports[`${kind}/${backend}`] = evidence;
      executionHashes[file] = await hash(file);
      assert.equal(typeof evidence.log, 'string');
      assert.equal(evidence.logSha256, await hash(evidence.log));
      executionHashes[evidence.log] = evidence.logSha256;
    }
    const web = webSummary(reports), headless = headlessSummary(reports);
    await verifyOfficial();
    assert.equal(await hash(evidencePath), installEvidenceSha256, 'Installation changed during execution');
    assert.deepEqual(await sources(), before, 'Sources changed during execution');
    const logPath = '.cache/official/validation-runs.json';
    await writeFile(resolve(root, logPath), JSON.stringify(runs, null, 2) + '\n');
    executionHashes[logPath] = await hash(logPath);
    await checkedExecution(executionHashes);
    Object.assign(report, { status: 'passed', checkedAt: new Date().toISOString(),
      sourceHashes: before, sourceFingerprint: digest(JSON.stringify(before)), installEvidenceSha256, executionHashes,
      web, headless });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`Recorded official Web/standard and headless acceptance for both backends; ${web.activeEntries} active default Web entries.`);
  } catch (error) {
    await writeFile(reportPath, JSON.stringify({ ...report, status: 'failed', error: error.stack ?? String(error) }, null, 2) + '\n');
    throw error;
  }
}
