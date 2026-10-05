import assert from 'node:assert/strict';
import test from 'node:test';
import { assertEquivalentRoster, generatedIdModules } from '../../scripts/official-roster.mjs';
const roster = ids => [
  { entryId: 'include:agent', moduleName: '@deepseek-ai/dsh-agent', enabled: true, fiberPhase: 'active' },
  ...generatedIdModules.map((moduleName, index) => ({ entryId: ids[index], moduleName, enabled: true, fiberPhase: 'active' })),
];
test('only the two official generated IDs may differ, without changing raw evidence', () => {
  const left = roster(['abc', '12345678']), right = roster(['def', '87654321']);
  const before = structuredClone(left);
  assertEquivalentRoster(left, right);
  assert.deepEqual(left, before);
});
test('stable ID, module, ordering and activation differences remain failures', () => {
  const original = roster(['abc', 'def']);
  for (const mutate of [
    rows => { rows[0].entryId = 'another'; },
    rows => { rows[0].moduleName = 'another'; },
    rows => { rows[0].enabled = false; },
    rows => { rows[0].fiberPhase = 'failed'; },
    rows => rows.reverse(),
  ]) {
    const altered = structuredClone(original); mutate(altered);
    assert.throws(() => assertEquivalentRoster(altered, original));
  }
});
test('generated entries must be unique, active and retain the generated ID format', () => {
  const original = roster(['abc', 'def']);
  for (const mutate of [
    rows => rows.pop(),
    rows => rows.push({ ...rows[1] }),
    rows => { rows[1].entryId = 'named-id'; },
    rows => { rows[1].enabled = false; },
    rows => { rows[1].fiberPhase = 'pending'; },
  ]) {
    const altered = structuredClone(original); mutate(altered);
    assert.throws(() => assertEquivalentRoster(altered, original));
  }
});
