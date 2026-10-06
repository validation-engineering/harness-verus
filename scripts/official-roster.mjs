import assert from 'node:assert/strict';

// The pinned directory-picker-auto plugin calls loader.create({ name }) for
// these two entries. Official EntryTree.ensureId assigns random hexadecimal IDs.
// Preserve the raw reports; normalize only these proven generated IDs in copies.
export const generatedIdModules = Object.freeze([
  '@deepseek-ai/dsh-host-directory-picker-native',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
]);
export function comparableRoster(entries) {
  for (const name of generatedIdModules) {
    const matches = entries.filter(entry => entry.moduleName === name);
    assert.equal(matches.length, 1, `Expected exactly one automatic picker entry: ${name}`);
    assert.equal(matches[0].enabled, true);
    assert.equal(matches[0].fiberPhase, 'active');
    assert.match(matches[0].entryId, /^[0-9a-f]{1,8}$/);
  }
  // Numeric-only generated IDs are array-index keys in the official loader's
  // object registry and enumerate before named entries. Compare only these two
  // generated entries by module, including their positions; every stable entry
  // retains its original order. Never rewrite the raw evidence.
  return [
    ...entries.filter(entry => !generatedIdModules.includes(entry.moduleName)).map(entry => ({ ...entry })),
    ...generatedIdModules.map(moduleName => ({
      ...entries.find(entry => entry.moduleName === moduleName), entryId: `dynamic:${moduleName}`,
    })),
  ];
}
export function assertEquivalentRoster(actual, expected) {
  assert.deepEqual(comparableRoster(actual), comparableRoster(expected), 'Default official plugin roster or activation differs');
}
