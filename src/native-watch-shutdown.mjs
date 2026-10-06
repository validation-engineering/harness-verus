const installations = new WeakMap();

/** Join every normal profile exit with the host-owned build watcher. The
 * returned promise still rejects on failure; an attached reporting branch also
 * handles upstream appExit's intentionally fire-and-forget invocation.
 */
export function installNativeWatchShutdown(shutdown, watcher, { onError = () => {} } = {}) {
  if (!shutdown || typeof shutdown.shutdown !== 'function' || typeof watcher?.close !== 'function'
    || typeof onError !== 'function') throw new TypeError('A shutdown controller, closeable watcher and error reporter are required');
  const existing = installations.get(shutdown);
  if (existing) {
    if (existing.watcher !== watcher) throw new Error('A different native watcher already owns this shutdown controller');
    return existing.close;
  }
  const originalShutdown = shutdown.shutdown.bind(shutdown);
  let pending;
  const close = code => {
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      const failures = [];
      try { await watcher.close(); } catch (error) { failures.push(error); }
      // Even an unsuccessful watcher drain must not skip official app cleanup.
      try { await originalShutdown(code); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Native watcher drain and official shutdown failed');
    });
    pending.catch(error => {
      try { Promise.resolve(onError(error)).catch(() => {}); }
      catch { /* A diagnostic callback cannot produce an unhandled rejection. */ }
    });
    return pending;
  };
  shutdown.shutdown = close;
  installations.set(shutdown, { watcher, close });
  return close;
}
