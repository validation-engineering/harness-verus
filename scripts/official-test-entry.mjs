// Integration-test observer only. The user launcher executes the same runCli.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { inspect } from 'node:util';
// process.exit() may run inside the official CLI's completed plugin episode.
// This test observer belongs to the host that registered it, not that caller.
const inHostScope = AsyncLocalStorage.snapshot();
const require = createRequire(new URL('../official-runtime/package.json', import.meta.url));
const { RegistryService, Context } = require('@deepseek-ai/cordis');
const native = typeof Context.prototype.snapshot === 'function';
// ACTIVE = 2 in both pinned profiles; upstream erases its const enum export.
const roots = new Set();
const original = RegistryService.prototype.plugin;
RegistryService.prototype.plugin = function (...args) {
  roots.add(this.ctx.root);
  return Reflect.apply(original, this, args);
};
const reportPath = process.env.CORDIS_HARNESS_TEST_REPORT;
assert(reportPath, 'Integration report path is required');
function capture(stage) {
  const previous = stage === 'exit' ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
  const contexts = [...roots].map(ctx => {
    const fibers = [...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => ({ name: fiber.name, state: fiber.state, active: fiber.state === 2, ...(fiber._error ? { error: inspect(fiber._error, { depth: 8 }) } : {}) })));
    return { ...(native ? { native: ctx.snapshot() } : {}), fibers };
  });
  writeFileSync(reportPath, JSON.stringify({ ...previous, backend: native ? 'native' : 'upstream', [stage]: { contexts, exitCode: process.exitCode ?? 0 } }, null, 2) + '\n', { mode: 0o600 });
}
writeFileSync(reportPath, '{}\n', { mode: 0o600 });
process.on('exit', () => inHostScope(capture, 'exit'));
const { runCli } = await import('../official-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
await runCli();
inHostScope(capture, 'ready');
