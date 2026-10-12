import assert from 'node:assert/strict';

export const expectedStages = ['initial-turn', 'update-failed', 'update-blocked',
  'fault-repaired', 'retry-succeeded', 'updated-turn', 'closed'];
export const expectedWaits = [
  ['v1', 'setup-after-effect'], ['v1', 'owned-task'], ['v1', 'cleanup-1'], ['v1', 'cleanup-2'],
  ['v2', 'setup-after-effect'], ['v2', 'owned-task'], ['v2', 'cleanup-1'],
];
export function errorRecord(error) {
  return { name: error.name, message: error.message, ...(error.code ? { code: error.code } : {}),
    ...(error.details ? { details: structuredClone(error.details) } : {}),
    ...(error.errors ? { errors: [...error.errors].map(errorRecord) } : {}),
    ...(error.cause instanceof Error ? { cause: errorRecord(error.cause) } : {}) };
}

// Validate raw observations, not a host-supplied "safe" boolean. This is a
// finite execution check; the executable admission proof lives in the core.
export function assertWaitObservation(observation) {
  const { before, after, owner, provider, error } = observation;
  const consumer = before.plugins.find(node => node.id === owner);
  const retained = before.plugins.find(node => node.id === provider);
  assert(consumer && retained && owner !== provider, 'Wait must name two real live plugins');
  assert(consumer.committed.some(binding => binding.service === 'recoveryJournal'
    && binding.provider === provider && binding.generation === retained.generation),
  'Wait witness must match the committed file service');
  assert(before.storage.invocationScopes > 0, 'Wait must originate in a recorded live invocation');
  assert.equal(error?.code, 'REENTRANT_MUTATION', 'Expected a lifecycle rejection, not a timeout or callback failure');
  assert.deepEqual(error.details, { operation: 'disposal', owner, generation: consumer.generation,
    target: provider, retained: provider }, 'Wait rejection must identify the actual retained dependency');
  assert.deepEqual(after, before, 'Rejected wait must not retire a plugin or alter the graph');
}

export function assertRecoveryReport(report) {
  assert.equal(report.schema, 'cordis-harness.recovery-case/v2');
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.stages.map(stage => stage.name), expectedStages);
  assert.deepEqual(report.waitRejections.map(({ version, phase }) => [version, phase]), expectedWaits,
    'Missing or reordered lifecycle wait evidence');
  for (const observation of report.waitRejections) assertWaitObservation(observation);
  const failed = report.stages.find(stage => stage.name === 'update-failed');
  const retry = report.stages.find(stage => stage.name === 'retry-succeeded');
  for (const observation of report.waitRejections.filter(row => row.version === 'v1')) {
    assert.equal(observation.owner, failed.consumer, 'Wait and recovery must use the same consumer');
    assert.equal(observation.provider, failed.provider, 'Wait and recovery must use the same provider');
  }
  const updated = report.stages.find(stage => stage.name === 'updated-turn').snapshot;
  const replacement = report.waitRejections.find(row => row.version === 'v2');
  assert(updated.plugins.some(node => node.id === replacement.owner));
  assert(updated.plugins.some(node => node.id === replacement.provider));
  assert.notEqual(replacement.owner, failed.consumer);
  assert.notEqual(replacement.provider, failed.provider);
  for (const observation of report.waitRejections.filter(row => row.version === 'v2')) {
    assert.equal(observation.owner, replacement.owner, 'All v2 waits must use the replacement consumer');
    assert.equal(observation.provider, replacement.provider, 'All v2 waits must use the replacement provider');
  }
  const retained = failed.snapshot.plugins.find(node => node.id === failed.provider);
  assert(retained.blockers.some(blocker => blocker.code === 'CommittedConsumers'
    && blocker.consumers.some(item => item.id === failed.consumer && item.generation === failed.generation)));
  assert.equal(retry.cleanupAttempts, 2); assert.equal(retry.oneShotReleases, 1);
  assert(!retry.snapshot.plugins.some(node => [failed.consumer, failed.provider].includes(node.id)));
  assert.equal(report.stages.at(-1).pluginsRemaining, 0);
  assert.equal(report.stages.at(-1).snapshot.plugins.length, 0);
  assert.equal(report.stages.at(-1).snapshot.storage.invocationScopes, 0,
    'Completed callbacks must release all invocation records');
  return { rejectedWaits: report.waitRejections.length, invocationScopesRemaining: 0 };
}
