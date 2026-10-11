import test from 'node:test';
import assert from 'node:assert/strict';
import { installOfficialTransactions } from '../../src/integrations/deepseek-loader.mjs';

// Contract-only bootstrap fixtures. Real ConfigEditor/HMR/Include execution is
// covered by harness-verus with the installed immutable official packages.
function contract() {
  class Entry { update() {} }
  class EntryGroup { update() {} create() {} remove() {} stop() {} }
  class EntryTree { create() {} update() {} remove() {} }
  class Hmr { runExclusive(operation) { return operation(); } partialReload() {} }
  class ConfigEditor { edit() {} }
  return { Entry, EntryGroup, EntryTree, Hmr, ConfigEditor };
}

test('official host installation validates the complete contract before replacing methods', () => {
  const classes = contract(), original = classes.Entry.prototype.update;
  delete classes.ConfigEditor.prototype.edit;
  assert.throws(() => installOfficialTransactions(classes), { code: 'INCOMPATIBLE_OFFICIAL_LOADER' });
  assert.equal(classes.Entry.prototype.update, original);
  assert.throws(() => installOfficialTransactions({ ...classes, Hmr: {} }), { code: 'INCOMPATIBLE_OFFICIAL_LOADER' });
});

test('repeated official host installation preserves wrappers and rejects changed class identities', () => {
  const classes = contract();
  installOfficialTransactions(classes);
  const wrapped = classes.Entry.prototype.update;
  installOfficialTransactions(classes);
  assert.equal(classes.Entry.prototype.update, wrapped);
  assert.throws(() => installOfficialTransactions({ ...classes, Hmr: contract().Hmr }), { code: 'INCOMPATIBLE_OFFICIAL_LOADER' });
  assert.throws(() => installOfficialTransactions({ ...classes, Entry: contract().Entry }), { code: 'INCOMPATIBLE_OFFICIAL_LOADER' });
  assert.equal(classes.Entry.prototype.update, wrapped);
});

test('official in-process HMR requires a current native service before touching caches', async () => {
  const classes = contract();
  let touched = false;
  classes.Hmr.prototype.partialReload = () => { touched = true; };
  installOfficialTransactions(classes);
  await assert.rejects(new classes.Hmr().partialReload(), { code: 'STALE_OFFICIAL_SERVICE' });
  assert.equal(touched, false);
});
