import assert from 'node:assert/strict';
import test from 'node:test';
import { assertEquivalentRoster, generatedIdModules } from '../../scripts/official-roster.mjs';
const roster = ids => [
  { entryId: 'include:agent', moduleName: '@deepseek-ai/dsh-agent', enabled: true, fiberPhase: 'active' },
  { entryId: 'include:tools', moduleName: '@deepseek-ai/dsh-tools', enabled: true, fiberPhase: 'active' },
  ...generatedIdModules.map((moduleName, index) => ({ entryId: ids[index], moduleName, enabled: true, fiberPhase: 'active' })),
];
test('only the two official generated IDs may differ, without changing raw evidence', () => {
  const left = roster(['abc', '12345678']), right = roster(['def', '87654321']);
  const before = structuredClone(left);
  assertEquivalentRoster(left, right);
  assert.deepEqual(left, before);
});
test('stable ID, module, relative ordering and activation differences remain failures', () => {
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
    rows => rows.push({ ...rows[2] }),
    rows => { rows[2].entryId = 'named-id'; },
    rows => { rows[2].enabled = false; },
    rows => { rows[2].fiberPhase = 'pending'; },
  ]) {
    const altered = structuredClone(original); mutate(altered);
    assert.throws(() => assertEquivalentRoster(altered, original));
  }
});

test('numeric generated IDs may move during official object-registry enumeration without changing stable order', () => {
  const enumerate = ids => Object.values(Object.fromEntries(roster(ids).map(row => [row.entryId, row])));
  const left = enumerate(['54618084', '46e23a14']);
  const right = enumerate(['e0c7ae9c', '1234']);
  assert.equal(left[0].moduleName, generatedIdModules[0]);
  assert.equal(right[0].moduleName, generatedIdModules[1]);
  const before = [structuredClone(left), structuredClone(right)];
  assertEquivalentRoster(left, right);
  assert.deepEqual([left, right], before);
});
