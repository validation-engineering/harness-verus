#!/usr/bin/env node
import assert from 'node:assert/strict';
import { assertRecoveryReport, expectedStages } from '../src/recovery-contract.mjs';
import { coreReviewFiles, reviewDirectory } from './core-review.mjs';
import { npmCommand } from './npm-command.mjs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, hashFiles, json, outputDirectory, projectRoot, regularFiles, relativeFile, requireSuccess,
  runCommand, saveJson, sha256, verifyRecoveryBundle } from './recovery-evidence.mjs';

const bundleName = 'cordis-harness-recovery';
const readme = `# Cordis Harness recovery review bundle

This development bundle runs one compact Harness recovery case with an unchanged
official AgentLoop and a deterministic scripted model. No model account, sibling
checkout, Rust, Verus or source build is needed to run it. Use npm and the Node
version, platform and architecture recorded in recovery-bundle.json (package minimum: Node 22.22.0).

After verifying the archive against its separately supplied SHA256SUMS:

    node scripts/recovery-evidence.mjs
    npm ci --ignore-scripts --include=dev --include=optional --no-audit --no-fund
    node scripts/verify-install.mjs
    npm run demo:recovery

Add --offline to npm ci when all pinned registry dependencies are cached. Network
access is only needed for dependency installation with a cold cache. Runtime
tarballs and the native addon are already included; dependencies are installed
afresh. The recorded build tool inputs are checked but no compiler is invoked.

Read docs/recovery-case.md or docs/recovery-case.zh-CN.md for the failure, review
path and limits. Selected checked core/host review sources are included under
.vendor/cordis/provenance/review and bound to the core development report; they
are not a complete proof/build closure. The bundle includes the official files
used by the prebuilt compact application, plus its source manifest. Rebuilding the complete
project and running the official Web/standard application require the source
repository and its build guide. This is neither a signed release nor a complete
source checkout. Hashes establish consistency, not publisher authentication.
`;

export async function createRecoveryBundle({ directory, root = projectRoot }) {
  requireSuccess(runCommand(root, process.execPath, ['scripts/verify-install.mjs']));
  await mkdir(directory, { recursive: true });
  assert.deepEqual(await readdir(directory), [], 'Bundle output must be empty');
  const build = await json(path.join(root, 'dist/build-report.json'));
  const lock = await json(path.join(root, 'sources.lock.json'));
  const fixed = [...Object.keys(build.inputs), ...Object.keys(build.outputs)]
    .filter(name => !name.startsWith('node_modules/'));
  fixed.push('dist/build-report.json', 'LICENSE', 'NOTICE', 'docs/recovery-case.md', 'docs/recovery-case.zh-CN.md',
    'scripts/recovery-evidence.mjs', 'scripts/run-recovery-case.mjs', 'scripts/reproduce-recovery.mjs');
  fixed.push(...lock.cordis.archives.map(item => item.file), '.vendor/cordis/provenance/development-report.json',
    '.vendor/cordis/provenance/package-report.json', ...coreReviewFiles.map(name => `${reviewDirectory}/${name}`));
  const names = await regularFiles(root, ['src', 'examples/recovery', 'third-party'], fixed);
  const sources = await hashFiles(root, names);
  const project = path.join(directory, bundleName);
  await mkdir(project);
  for (const name of names) {
    relativeFile(name);
    const destination = path.join(project, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(root, name)));
  }
  await writeFile(path.join(project, 'BUNDLE-README.md'), readme);
  const files = { ...sources, 'BUNDLE-README.md': digest(readme) };
  const commit = requireSuccess(runCommand(root, 'git', ['rev-parse', 'HEAD'])).stdout.trim();
  const dirty = requireSuccess(runCommand(root, 'git', ['status', '--porcelain'])).stdout.trim().length > 0;
  const manifest = { schema: 'cordis-harness.recovery-bundle/v1',
    environment: { platform: process.platform, architecture: process.arch, node: process.version },
    sourceCommit: commit, workingTreeDirty: dirty, sourceIdentity: 'file hashes; commit is metadata only',
    cordisSourceFingerprint: lock.cordis.sourceFingerprint, harnessRevision: lock.deepseekHarness.revision,
    nativeTarget: lock.cordis.nativeTarget, buildReportSha256: files['dist/build-report.json'],
    compilerExecutedByConsumer: false, releaseAcceptance: false, files };
  await saveJson(path.join(project, 'recovery-bundle.json'), manifest);
  await verifyRecoveryBundle(project);
  assert.deepEqual(await hashFiles(root, names), sources, 'Sources changed while making the bundle');
  const archive = path.join(directory, `${bundleName}-${process.platform}-${process.arch}.tar.gz`);
  requireSuccess(runCommand(directory, 'tar', ['-czf', archive, bundleName]));
  const archiveSha256 = await sha256(archive);
  await writeFile(path.join(directory, 'SHA256SUMS'), `${archiveSha256}  ${path.basename(archive)}\n`);
  await verifyRecoveryBundle(project);
  return { project, archive, archiveSha256, manifestSha256: await sha256(path.join(project, 'recovery-bundle.json')), sources };
}

export async function reproduceRecovery({ directory, offline = true, quiet = false } = {}) {
  const output = await outputDirectory(projectRoot, 'reproductions', directory);
  const reportPath = path.join(output, 'reproduction.json');
  const report = { schema: 'cordis-harness.recovery-reproduction/v1', status: 'running',
    startedAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch,
    installation: offline ? 'npm ci --offline using local npm cache' : 'npm ci with registry access permitted',
    independentInstallation: true, externalReviewer: false, paidModelRequests: false,
    proofExecuted: false, releaseAcceptance: false, runs: [] };
  let temporary, caseDirectory;
  await saveJson(reportPath, report);
  const execute = async (cwd, command, args) => {
    const run = runCommand(cwd, command, args);
    const log = `command-${report.runs.length + 1}.json`;
    await saveJson(path.join(output, log), run);
    report.runs.push({ command: path.basename(command), args, status: run.status, log, logSha256: await sha256(path.join(output, log)) });
    await saveJson(reportPath, report);
    requireSuccess(run);
    return run;
  };
  try {
    if (!quiet) console.log('Preparing a source-bound recovery bundle from installed artifacts...');
    const bundle = await createRecoveryBundle({ directory: path.join(output, 'package') });
    report.bundle = { archive: path.relative(output, bundle.archive), sha256: bundle.archiveSha256,
      manifestSha256: bundle.manifestSha256, sourceHashes: bundle.sources };
    temporary = await mkdtemp(path.join(tmpdir(), 'cordis-recovery-review-'));
    assert(!path.resolve(temporary).startsWith(path.resolve(projectRoot) + path.sep), 'Review must run outside the source repository');
    assert.equal(await sha256(bundle.archive), bundle.archiveSha256, 'Archive changed before extraction');
    await execute(temporary, 'tar', ['-xzf', bundle.archive]);
    const extracted = path.join(temporary, bundleName);
    assert.equal(await sha256(path.join(extracted, 'recovery-bundle.json')), bundle.manifestSha256, 'Extracted manifest differs from the producer');
    await verifyRecoveryBundle(extracted);
    assert(!(await readdir(extracted)).includes('node_modules'), 'Review installation must start without node_modules');
    report.isolation = { directory: temporary, freshNodeModules: true, siblingCheckoutUsed: false,
      copiedNodeModules: false, compilerExecuted: false, cleanedAfterRun: false };
    if (!quiet) console.log('Installing pinned dependencies in a fresh directory outside the checkout...');
    const [npm, ...npmPrefix] = npmCommand();
    await execute(extracted, npm, [...npmPrefix, 'ci', '--ignore-scripts', '--include=dev', '--include=optional', '--no-audit', '--no-fund', ...(offline ? ['--offline'] : [])]);
    await verifyRecoveryBundle(extracted);
    caseDirectory = path.join(extracted, '.cordis-harness/review-case');
    if (!quiet) console.log('Running the real file-failure, blocked-update and explicit-retry case...');
    const run = await execute(extracted, process.execPath, ['scripts/run-recovery-case.mjs', '--output', caseDirectory, '--json']);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'passed');
    assert.equal(result.reportSha256, await sha256(path.join(caseDirectory, 'report.json')));
    const scenario = await json(path.join(caseDirectory, 'report.json'));
    assert.equal(scenario.status, 'passed');
    assert.equal(scenario.provenance.bundleManifestSha256, bundle.manifestSha256);
    const waitSafety = assertRecoveryReport(scenario);
    assert.deepEqual(result.stages, expectedStages);
    await verifyRecoveryBundle(extracted);
    assert.deepEqual(await hashFiles(projectRoot, Object.keys(bundle.sources)), bundle.sources, 'Source inputs changed during reproduction');
    const retry = scenario.stages.find(stage => stage.name === 'retry-succeeded');
    assert.equal(retry.cleanupAttempts, 2); assert.equal(retry.oneShotReleases, 1);
    assert.equal(await sha256(bundle.archive), bundle.archiveSha256, 'Archive changed during reproduction');
    report.case = { waitSafety, stages: result.stages, pluginsRemaining: 0, cleanupAttempts: retry.cleanupAttempts, oneShotReleases: retry.oneShotReleases,
      provider: scenario.provider, report: 'case/report.json', reportSha256: result.reportSha256 };
    report.status = 'passed'; report.checkedAt = new Date().toISOString();
  } catch (error) {
    report.status = 'failed'; report.error = error.stack ?? String(error);
    throw error;
  } finally {
    try {
      if (caseDirectory) {
        try { await cp(caseDirectory, path.join(output, 'case'), { recursive: true, errorOnExist: true, force: false }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (temporary) {
        await rm(temporary, { recursive: true, force: true });
        if (report.isolation) report.isolation.cleanedAfterRun = true;
      }
    } catch (error) {
      report.status = 'failed'; report.cleanupError = error.stack ?? String(error);
      throw error;
    } finally { await saveJson(reportPath, report); }
  }
  return { status: report.status, output, report: reportPath, reportSha256: await sha256(reportPath),
    archive: path.join(output, report.bundle.archive), archiveSha256: report.bundle.sha256, stages: report.case.stages };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let directory, offline = true, quiet = false;
  const seen = new Set();
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]; assert(!seen.has(arg), `Duplicate option: ${arg}`); seen.add(arg);
    if (arg === '--json') quiet = true;
    else if (arg === '--online') offline = false;
    else if (arg === '--output') { directory = process.argv[++i]; assert(directory && !directory.startsWith('--')); }
    else throw new Error('Usage: node scripts/reproduce-recovery.mjs [--online] [--output NEW_DIRECTORY] [--json]');
  }
  const result = await reproduceRecovery({ directory, offline, quiet });
  if (quiet) console.log(JSON.stringify(result));
  else console.log(`\nIndependent installation passed all seven stages and lifecycle wait checks.\nArchive: ${result.archive}\nSHA-256: ${result.archiveSha256}\nEvidence: ${result.output}`);
}
