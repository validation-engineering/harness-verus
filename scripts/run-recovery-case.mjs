#!/usr/bin/env node
import assert from 'node:assert/strict';
import { assertRecoveryReport } from '../src/recovery-contract.mjs';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFiles, json, outputDirectory, projectRoot, regularFiles, requireSuccess, runCommand,
  saveJson, sha256, verifyRecoveryBundle } from './recovery-evidence.mjs';

const descriptions = {
  'initial-turn': 'Official AgentLoop called the v1 tool and completed its Todo.',
  'update-failed': 'Checkpoint write failed; committed consumer retains the file service.',
  'update-blocked': 'Another update was rejected without retrying cleanup or starting v2.',
  'fault-repaired': 'Removed the directory occupying the checkpoint file path.',
  'retry-succeeded': 'Explicit retry flushed v1 before closing its file; successful inverse ran once.',
  'updated-turn': 'Resubmitted v2; official AgentLoop called the new tool and completed its Todo.',
  closed: 'Harness closed; no plugins remain in the native lifecycle graph.',
};

export async function demonstrateRecovery({ directory, quiet = false } = {}) {
  let bundled = false;
  try { await access(path.join(projectRoot, 'recovery-bundle.json')); bundled = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bundled) await verifyRecoveryBundle(projectRoot);
  const preflight = requireSuccess(runCommand(projectRoot, process.execPath, ['scripts/verify-install.mjs']));
  const inputs = await regularFiles(projectRoot, ['src', 'examples/recovery'],
    ['scripts/run-recovery-case.mjs', 'scripts/recovery-evidence.mjs', 'sources.lock.json', 'dist/build-report.json']);
  const sourceHashes = await hashFiles(projectRoot, inputs);
  const output = await outputDirectory(projectRoot, 'recovery', directory);
  const { runRecoveryCase } = await import('../src/recovery-case.mjs');
  let reportedWaits = 0;
  const report = await runRecoveryCase({ directory: output, onStage(stage, waits) {
    if (quiet) return;
    console.log(`${stage.name}: ${descriptions[stage.name]}`);
    for (const wait of waits.slice(reportedWaits)) {
      const details = wait.error.details;
      console.log(`  REENTRANT_MUTATION (${wait.version}/${wait.phase}): consumer ${details.owner}, generation ${details.generation}, retained provider ${details.retained}; disposal rejected before mutation.`);
    }
    reportedWaits = waits.length;
    if (stage.name === 'update-failed') console.log(`  CleanupFailed: consumer ${stage.consumer}, generation ${stage.generation}, inverse ${stage.inverse.id}, attempt ${stage.inverse.attempts}\n  CommittedConsumers: provider ${stage.provider} is waiting for consumer ${stage.consumer}.`);
  } });
  try {
    assertRecoveryReport(report);
    assert.deepEqual(await hashFiles(projectRoot, inputs), sourceHashes, 'Recovery inputs changed during execution');
    if (bundled) await verifyRecoveryBundle(projectRoot);
    const lock = await json(path.join(projectRoot, 'sources.lock.json'));
    report.provenance = { sourceHashes, cordis: lock.cordis, deepseekHarness: lock.deepseekHarness,
      ...(bundled ? { bundleManifestSha256: await sha256(path.join(projectRoot, 'recovery-bundle.json')) } : {}) };
    await saveJson(path.join(output, 'report.json'), report);
    await saveJson(path.join(output, 'preflight.json'), preflight);
    await writeFile(path.join(output, 'summary.md'), `# Harness cleanup recovery\n\nStatus: **passed**. Scripted model; real official AgentLoop, custom plugins and file I/O.\n\n`
      + report.stages.map(stage => `- **${stage.name}**: ${descriptions[stage.name]}`).join('\n')
      + `\n\nLifecycle waits rejected: **${report.waitSafety.rejectedWaits}**. Invocation records after shutdown: **${report.waitSafety.invocationScopesRemaining}**.`
      + '\n\nReview `report.json` for lifecycle wait rejections, raw native snapshots and source/artifact hashes, `before-update.json` and `after-update.json` for official session events, `wait-events.jsonl` for the retained-provider witnesses and unchanged before/after snapshots, and `plugin-events.jsonl` for cleanup ordering.\n\n'
      + 'This is an observed finite execution on the recorded platform. It does not prove arbitrary JavaScript, filesystem recovery, eventual cleanup, or complete paper refinement.\n');
  } catch (error) {
    report.status = 'failed'; report.evidenceError = error.message;
    await saveJson(path.join(output, 'report.json'), report);
    throw error;
  }
  return { status: report.status, output, report: path.join(output, 'report.json'),
    reportSha256: await sha256(path.join(output, 'report.json')), stages: report.stages.map(stage => stage.name), waitSafety: report.waitSafety };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let directory, quiet = false;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--json' && !quiet) quiet = true;
    else if (arg === '--output' && !directory) { directory = process.argv[++i]; assert(directory && !directory.startsWith('--')); }
    else throw new Error('Usage: node scripts/run-recovery-case.mjs [--output NEW_DIRECTORY] [--json]');
  }
  const result = await demonstrateRecovery({ directory, quiet });
  if (quiet) console.log(JSON.stringify(result));
  else console.log(`\nPassed all seven stages; ${result.waitSafety.rejectedWaits} lifecycle waits rejected, ${result.waitSafety.invocationScopesRemaining} invocation records remain. Evidence: ${result.output}`);
}
