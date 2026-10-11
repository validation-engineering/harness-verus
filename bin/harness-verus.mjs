#!/usr/bin/env node
// The public command preserves the official CLI and its default Web mode.
// The compact scripted demo is an explicit secondary entry.
const command = process.argv[2];
if (command === 'demo' || command === 'compact') {
  if (command === 'compact') process.argv.splice(2, 1);
  await import('../src/cli.mjs');
} else {
  await import('../scripts/official.mjs');
}
