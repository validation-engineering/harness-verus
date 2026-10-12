import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertRecoveryReport, expectedStages, errorRecord } from './recovery-contract.mjs';
export { expectedStages, errorRecord } from './recovery-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function jsonLines(file) {
  return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
async function rejected(operation, message) {
  try { await operation(); } catch (error) { return errorRecord(error); }
  assert.fail(message);
}

/** Actual application calls only. No fabricated snapshot, replacement loop or scheduler. */
export async function runRecoveryCase({ directory, onStage = () => {} }) {
  assert.deepEqual(await readdir(directory), [], 'Use a new empty output directory');
  const { createHarness } = await import('./app.mjs');
  const report = {
    schema: 'cordis-harness.recovery-case/v2', status: 'running',
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    provider: 'deterministic scripted provider', officialAgentLoop: true,
    applicationMode: 'compact Harness with official AgentLoop, tools and Todo',
    proofExecuted: false, releaseAcceptance: false, stages: [], waitRejections: [],
  };
  const output = join(directory, 'report.json');
  const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n');
  const stage = async (name, observations) => {
    assert.equal(name, expectedStages[report.stages.length]);
    report.stages.push({ name, ...observations });
    report.waitRejections = await jsonLines(join(directory, 'wait-events.jsonl'));
    await save();
    await onStage(report.stages.at(-1), report.waitRejections);
  };
  const plugin = version => ({ id: 'recovery', module: './examples/recovery/file-journal.mjs',
    config: { directory, version } });
  const steps = [
    { name: 'todo_write', arguments: { todos: [{ content: 'Read installed plugin version', status: 'in_progress' }] } },
    { name: 'recovery_version', arguments: {} },
    { name: 'todo_write', arguments: { todos: [{ content: 'Read installed plugin version', status: 'completed' }] } },
  ];
  const fault = join(directory, 'checkpoint-v1.json');
  let app, faultCreated = false;
  await save();
  try {
    app = await createHarness({ base: root, workspace: directory, sessionDirectory: join(directory, 'sessions'),
      provider: { type: 'scripted', model: 'recovery-demo', options: { steps } },
      plugins: [{ id: 'todo', module: 'official:todo' }, plugin('v1')],
    });
    const turn = async (version, sessionId) => {
      const result = await app.run('Read the installed plugin version.', { sessionId });
      const transcript = await app.inspect(sessionId, 0, 200);
      await writeFile(join(directory, `${sessionId}.json`), JSON.stringify({ result, transcript }, null, 2) + '\n');
      assert.equal(result.ok, true);
      assert.deepEqual(result.toolCalls.map(call => call.name), steps.map(step => step.name));
      assert(result.projection.values.todos.every(todo => todo.status === 'completed'));
      const responses = transcript.events.filter(event => event.type === 'tool/result');
      const call = result.toolCalls.find(item => item.name === 'recovery_version');
      const message = responses.find(event => event.data.message.toolCallId === call.callId)?.data.message;
      assert.equal(message?.isError, false);
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
      assert.deepEqual(JSON.parse(text), { version }, 'Official session must contain the actual plugin result');
      return { version, sessionId, toolCalls: result.toolCalls.map(call => call.name), eventCount: result.eventCount };
    };
    await stage('initial-turn', await turn('v1', 'before-update'));
    const oldIds = new Set(app.ctx.snapshot().plugins.map(node => node.id));
    await mkdir(fault);
    faultCreated = true;
    const updateError = await rejected(() => app.reloadPlugin('recovery', plugin('v2').config), 'Update unexpectedly succeeded despite the filesystem fault');
    const blocked = app.ctx.snapshot();
    assert.equal(blocked.profile, 'harness');
    const consumer = blocked.plugins.find(node => node.cleanupFailed
      && node.host?.inverses.some(inverse => inverse.label === 'persist final checkpoint' && inverse.state === 'failed'));
    assert(consumer, 'No real failed checkpoint inverse in diagnostics');
    const inverse = consumer.host.inverses.find(item => item.label === 'persist final checkpoint' && item.state === 'failed');
    assert.equal(inverse.attempts, 1);
    assert(consumer.blockers.some(blocker => blocker.code === 'CleanupFailed' && blocker.retryable));
    const provider = blocked.plugins.find(node => node.blockers.some(blocker => blocker.code === 'CommittedConsumers'
      && blocker.consumers.some(item => item.id === consumer.id && item.generation === consumer.generation)));
    assert(provider, 'Provider must remain blocked by this exact committed consumer');
    const eventsBefore = await jsonLines(join(directory, 'plugin-events.jsonl'));
    assert.equal(eventsBefore.filter(item => item.type === 'checkpoint-attempt').length, 1);
    assert.equal(eventsBefore.filter(item => item.type === 'one-shot-released').length, 1);
    assert(!eventsBefore.some(item => item.type === 'provider-closed' || item.version === 'v2'));
    assert(app.plugins().find(item => item.id === 'recovery').cleanupBlocked);
    await stage('update-failed', { error: updateError, consumer: consumer.id, provider: provider.id,
      generation: consumer.generation, inverse, snapshot: blocked });

    const blockedError = await rejected(() => app.reloadPlugin('recovery', plugin('v2').config), 'A blocked revision must require explicit recovery');
    assert.match(blockedError.message, /cleanup is blocked/);
    assert.deepEqual(app.ctx.snapshot(), blocked, 'Rejected update must not retry cleanup or change the graph');
    assert.deepEqual(await jsonLines(join(directory, 'plugin-events.jsonl')), eventsBefore);
    await stage('update-blocked', { error: blockedError, cleanupAttempts: 1, replacementStarted: false });
    await rmdir(fault);
    faultCreated = false;
    await stage('fault-repaired', { action: 'Removed the empty directory occupying checkpoint-v1.json' });
    await app.retryPluginCleanup('recovery');
    assert(!app.plugins().some(item => item.id === 'recovery'));
    const afterRetry = app.ctx.snapshot();
    assert(!afterRetry.plugins.some(node => node.id === consumer.id || node.id === provider.id));
    const events = await jsonLines(join(directory, 'plugin-events.jsonl'));
    assert.equal(events.filter(item => item.type === 'checkpoint-attempt').length, 2);
    assert.equal(events.filter(item => item.type === 'checkpoint-succeeded').length, 1);
    assert.equal(events.filter(item => item.type === 'one-shot-released').length, 1);
    assert(events.findIndex(item => item.type === 'checkpoint-succeeded') < events.findIndex(item => item.type === 'provider-closed'));
    const checkpoint = JSON.parse(await readFile(fault, 'utf8'));
    assert.deepEqual(checkpoint, { version: 'v1', flushed: true });
    const journal = await jsonLines(join(directory, 'journal-v1.jsonl'));
    assert.deepEqual(journal, [{ type: 'agent-tool-call', version: 'v1' }, { type: 'consumer-flushed', version: 'v1' }]);
    await stage('retry-succeeded', { cleanupAttempts: 2, oneShotReleases: 1,
      checkpoint, journal, snapshot: afterRetry });

    // The failed revision did not commit v2. Explicitly resubmit it after the
    // retained old instance has been fully released by retryPluginCleanup.
    await app.loadPlugin(plugin('v2'));
    const updated = await turn('v2', 'after-update');
    const replacement = app.ctx.snapshot();
    assert(replacement.plugins.some(node => !oldIds.has(node.id)));
    await stage('updated-turn', { ...updated, snapshot: replacement });
    await app.close();
    const final = app.ctx.snapshot();
    assert.equal(final.plugins.length, 0);
    const allEvents = await jsonLines(join(directory, 'plugin-events.jsonl'));
    assert.equal(allEvents.filter(item => item.type === 'provider-closed').length, 2);
    await stage('closed', { pluginsRemaining: 0, snapshot: final });
    report.status = 'passed';
    report.pluginEvents = allEvents;
    report.waitSafety = assertRecoveryReport(report);
    await save();
    return report;
  } catch (error) {
    report.status = 'failed';
    report.error = errorRecord(error);
    if (app) report.failureSnapshot = app.ctx.snapshot();
    // Best-effort repair of only the fault this case created, before closing
    // the application. Cleanup trouble is retained in the failed report.
    const cleanupErrors = [];
    if (faultCreated) try { await rmdir(fault); } catch (cleanup) { cleanupErrors.push(errorRecord(cleanup)); }
    if (app) {
      try { if (app.plugins().some(item => item.id === 'recovery' && item.cleanupBlocked)) await app.retryPluginCleanup('recovery'); }
      catch (cleanup) { cleanupErrors.push(errorRecord(cleanup)); }
      try { await app.close(); } catch (cleanup) { cleanupErrors.push(errorRecord(cleanup)); }
    }
    if (cleanupErrors.length) report.cleanupErrors = cleanupErrors;
    await save();
    throw error;
  }
}
