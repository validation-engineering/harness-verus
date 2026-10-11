import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { verifyOfficial } from '../scripts/verify-official.mjs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostModule = fileURLToPath(new URL('../scripts/official-process-host.mjs', import.meta.url));
const nested = (parent, child) => { const value = relative(parent, child); return !value || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`)); };

/** One ProcessDomain; polling only schedules changes, never plugin lifecycles. */
export async function createOfficialSupervisor(options) {
  const source = await realpath(resolve(options.directory));
  const home = await realpath(resolve(options.home));
  const workspace = await realpath(resolve(options.workspace));
  assert(!nested(source, home), 'DSH_HOME must be outside the captured plugin bundle');
  assert(!nested(source, workspace), 'Workspace must be outside the captured plugin bundle');
  const interval = options.interval ?? 750;
  assert(Number.isInteger(interval) && interval >= 50, 'Watch interval must be at least 50 ms');
  const port = options.port ?? 3080;
  assert(Number.isInteger(port) && port >= 0 && port <= 65535, 'port must be 0..65535');
  const Domain = options.ProcessDomain ?? (await import('@validation-engineering/cordis-loader/process')).ProcessDomain;
  const domain = new Domain({ entry: 'harness.json', hostModule, cwd: workspace, timeout: options.timeout ?? 30000,
    env: { ...options.env, DSH_HOME: home, CORDIS_HARNESS_PROCESS_WEB_ARGS: JSON.stringify(['--no-open', '--port', String(port)]) },
    ...(options.onOutput ? { onOutput: options.onOutput } : {}),
  });
  let timer, stopped = false, dirty = false, poll = Promise.resolve(), seen, started, observerError;
  const register = new URL('../scripts/official-register.mjs', import.meta.url);
  const registerHash = async () => createHash('sha256').update(await readFile(register)).digest('hex');
  const expectedRegisterHash = await registerHash();
  const beforeLoad = async () => {
    assert.equal(await registerHash(), expectedRegisterHash, 'Trusted official register changed; create a new supervisor after verification');
    await (options.beforeLoad ?? verifyOfficial)();
  };
  function report(value) {
    try { options.onReload?.(value); }
    catch (error) { observerError = error; stopped = true; clearInterval(timer); }
  }
  async function scan() {
    do {
      dirty = false;
      const plan = await domain.planReload(source);
      if (stopped || plan.candidateDigest === seen || plan.identical) continue;
      seen = plan.candidateDigest;
      await beforeLoad();
      if (stopped) return;
      try {
        const result = await domain.reload(source);
        report({ ok: true, result });
      } catch (error) {
        report({ ok: false, error, recovered: error.code === 'RELOAD_FAILED' && error.details?.restored === true });
        if (domain.state !== 'active') { stopped = true; clearInterval(timer); }
      }
    } while (dirty && !stopped);
  }
  function schedule() {
    if (stopped) return;
    dirty = true;
    if (schedule.running) return;
    schedule.running = true;
    poll = scan().catch(error => { stopped = true; clearInterval(timer); report({ ok: false, error, recovered: false }); }).finally(() => { schedule.running = false; if (dirty && !stopped) schedule(); });
  }
  return {
    domain,
    get observerError() { return observerError; },
    start() {
      assert(!stopped, 'Supervisor is stopping');
      return started ??= (async () => {
        await beforeLoad();
        assert(!stopped, 'Supervisor stopped during preflight');
        const result = await domain.load(source);
        seen = result.digest;
        if (options.watch && !stopped) timer = setInterval(schedule, interval);
        return result;
      })();
    },
    async reload() { assert(!stopped, 'Supervisor is stopping'); await beforeLoad(); assert(!stopped, 'Supervisor stopped during preflight'); return domain.reload(source); },
    async close() { stopped = true; clearInterval(timer); await started?.catch(() => {}); await poll; await domain.dispose(); },
    async abandon() { stopped = true; clearInterval(timer); await started?.catch(() => {}); await poll; return domain.abandon(); },
  };
}
