import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
const require = createRequire(new URL('../../official-runtime/package.json', import.meta.url));
const { Context } = require('@deepseek-ai/cordis');
const routed = await import('@deepseek-ai/cordis');
assert.equal(routed.Context, Context);
const ctx = new Context();
assert.equal(ctx.snapshot().profile, 'harness');
await ctx.dispose();
const original = new URL('../../official-runtime/node_modules/@deepseek-ai/cordis/lib/index.js', import.meta.url);
await assert.rejects(import(original.href), { code: 'ERR_CORDIS_ORIGINAL_HOST' });
assert.throws(() => require(original.pathname), { code: 'ERR_CORDIS_ORIGINAL_HOST' });
const worker = new Worker(new URL('./bootstrap-worker.mjs', import.meta.url));
const workerExit = new Promise((resolve, reject) => {
  worker.once('error', reject);
  worker.once('exit', code => code === 0 ? resolve() : reject(new Error('Worker exited ' + code)));
});
try {
  const message = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  assert.equal(message.profile, 'harness');
  await workerExit;
} finally { await worker.terminate(); }
console.log(JSON.stringify({ mainProfile: 'harness', uniqueEsmCjsContext: true, upstreamEntryRejected: true, inheritedWorkerProfile: 'harness' }));
