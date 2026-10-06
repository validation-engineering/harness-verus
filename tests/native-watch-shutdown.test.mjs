import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { installNativeWatchShutdown } from '../src/native-watch-shutdown.mjs';

test('normal appExit and signal callers share one drain before official shutdown', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), order = [];
  const watcher = { async close() { order.push('draining'); entered.resolve(); await release.promise; order.push('drained'); } };
  const shutdown = { async shutdown(code) { assert.equal(this, shutdown); order.push(`shutdown:${code}`); } };
  const close = installNativeWatchShutdown(shutdown, watcher);
  const first = shutdown.shutdown(0); // The method used by the official appExit closure.
  try {
    await entered.promise;
    assert.equal(close(130), first);
    assert.equal(installNativeWatchShutdown(shutdown, watcher), close);
    assert.deepEqual(order, ['draining']);
  } finally { release.resolve(); }
  await first;
  assert.deepEqual(order, ['draining', 'drained', 'shutdown:0']);
  assert.equal(close(1), first);
});

test('drain failure still runs official shutdown and remains a reported rejection', async () => {
  const error = new Error('drain failed'), order = [], reported = [];
  const close = installNativeWatchShutdown({ async shutdown(code) { order.push(`shutdown:${code}`); } },
    { async close() { order.push('drain'); throw error; } }, { onError: failure => reported.push(failure) });
  const completion = close(130);
  await assert.rejects(completion, failure => failure === error);
  assert.deepEqual(order, ['drain', 'shutdown:130']);
  assert.deepEqual(reported, [error]);
});

test('drain and official shutdown failures are both retained', async () => {
  const drain = new Error('drain'), shutdown = new Error('shutdown'), reported = [];
  const close = installNativeWatchShutdown({ shutdown() { throw shutdown; } },
    { close() { throw drain; } }, { onError: error => reported.push(error) });
  await assert.rejects(close(1), error => error instanceof AggregateError && error.errors[0] === drain && error.errors[1] === shutdown);
  assert.equal(reported.length, 1);
});

test('fire-and-forget appExit handles rejection even if the reporter fails', async () => {
  let reported = 0, shutdowns = 0;
  const shutdown = { async shutdown() { shutdowns++; } };
  installNativeWatchShutdown(shutdown, { async close() { throw new Error('drain failed'); } },
    { onError: async () => { reported++; throw new Error('reporter failed'); } });
  void shutdown.shutdown(0);
  await nextTurn(); await nextTurn();
  assert.equal(reported, 1);
  assert.equal(shutdowns, 1);
});
