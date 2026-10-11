#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { npmCommand } from './npm-command.mjs';

const { values } = parseArgs({ options: {
  'from-directory': { type: 'string' }, output: { type: 'string' }, registry: { type: 'boolean', default: false },
} });
assert(values['from-directory'] && values.output, 'Usage: check-release.mjs --from-directory DIRECTORY --output FILE [--registry]');
const input = resolve(values['from-directory']), output = resolve(values.output);
const candidate = JSON.parse(await readFile(join(input, 'candidate.json'), 'utf8'));
assert.equal(candidate.schema, 'harness-verus.npm-candidate/v1');
assert.equal(candidate.name, '@validation-engineering/harness-verus');
assert.match(candidate.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(basename(candidate.file), candidate.file);
if (process.env.GITHUB_SHA) assert.equal(candidate.sourceCommit, process.env.GITHUB_SHA, 'Candidate belongs to another source commit');
const archive = await readFile(join(input, candidate.file));
assert.equal(createHash('sha256').update(archive).digest('hex'), candidate.sha256);
assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, candidate.integrity);
const directory = await mkdtemp(join(tmpdir(), 'harness registry consumer '));
const project = join(directory, 'installed application'), work = join(directory, 'user workspace'), data = join(directory, 'user data');
await mkdir(project); await mkdir(work);
const env = { ...process.env, HARNESS_VERUS_HOME: data, DSH_HOME: join(data, 'official'),
  DSH_TELEMETRY_DISABLED: '1', npm_config_cache: join(directory, 'npm cache') };
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'CORDIS_NATIVE_BINDING', 'ESBUILD_BINARY_PATH']) delete env[name];
const [npm, ...prefix] = npmCommand(env);
function run(command, args, cwd = project, timeout = 240000) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  return result.stdout;
}
const report = { schema: 'harness-verus.npm-installation/v1', status: 'running',
  registry: values.registry, sourceCommit: candidate.sourceCommit, coreCommit: candidate.coreCommit,
  package: candidate, environment: { platform: process.platform, architecture: process.arch, node: process.version },
  compilerExecuted: false, paidModelRequests: false };
try {
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'harness-release-consumer', private: true,
    dependencies: { [candidate.name]: values.registry ? candidate.version : `file:${join(input, candidate.file)}` } }, null, 2));
  const flags = ['--ignore-scripts', '--include=optional', '--include=peer', '--no-audit', '--no-fund'];
  run(npm, [...prefix, 'install', ...flags]);
  const lock = JSON.parse(await readFile(join(project, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[`node_modules/${candidate.name}`].integrity, candidate.integrity, 'npm installed different application bytes');
  const installed = join(project, 'node_modules', candidate.name), cli = join(installed, 'bin/harness-verus.mjs');
  async function smoke() {
    const verified = JSON.parse(run(process.execPath, [join(installed, 'scripts/verify-published.mjs')], work));
    assert.equal(verified.coreCommit, candidate.coreCommit);
    const help = run(process.execPath, [cli, '--help'], work);
    assert.match(help, /dsh.*profile|profile.*dsh/s, 'Public entry must use the official CLI');
    const demo = JSON.parse(run(process.execPath, [cli, 'demo', '--json'], work));
    assert.equal(demo.ok, true); assert.equal(demo.provider, 'scripted');
    assert.deepEqual(demo.toolCalls.map(call => call.name), ['todo_write', 'workspace_read', 'workspace_write', 'todo_write']);
    assert(demo.workspace.startsWith(data + sep), 'A global install must write demo data outside its package');
    assert.match(await readFile(join(demo.workspace, 'DEMO_RESULT.md'), 'utf8'), /official AgentLoop/);
    return verified;
  }
  const first = await smoke();
  // Exercise the installed integrity boundary, not a simulated hash helper.
  const entry = join(installed, 'src/app.mjs'), original = await readFile(entry);
  try {
    await writeFile(entry, Buffer.concat([original, Buffer.from('\n// changed after installation\n')]));
    const rejected = spawnSync(process.execPath, [join(installed, 'scripts/verify-published.mjs')], { cwd: work, env, encoding: 'utf8', timeout: 30000 });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Installed release file changed/);
  } finally { await writeFile(entry, original); }
  run(npm, [...prefix, 'ci', '--offline', ...flags]);
  assert.deepEqual(await smoke(), first);
  Object.assign(report, { status: 'passed', target: first.target, offlineReinstall: 'passed',
    checks: ['exact-npm-archive', 'published-source-and-core-integrity', 'official-cli-entry',
      'real-official-agent-loop', 'four-scripted-tool-calls', 'external-data-directory', 'changed-code-rejected', 'offline-reinstall'],
    scope: 'Fresh package installation, official CLI help and compact real AgentLoop demo. Full Web/headless acceptance is recorded separately for the development environment.' });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Installed ${candidate.name}@${candidate.version} on ${first.target}; official CLI and scripted AgentLoop passed before and after offline reinstall.`);
} catch (error) {
  await writeFile(output, JSON.stringify({ ...report, status: 'failed', error: error.stack ?? String(error) }, null, 2) + '\n');
  throw error;
} finally { await rm(directory, { recursive: true, force: true }); }
