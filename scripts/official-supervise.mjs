#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyOfficial } from './verify-official.mjs';
import { createOfficialSupervisor } from '../src/official-supervisor.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  directory: { type: 'string', default: resolve(root, 'examples/process-plugins') },
  home: { type: 'string', default: process.env.DSH_HOME ?? resolve(root, '.cordis-harness/official-supervised') },
  workspace: { type: 'string', default: process.cwd() }, port: { type: 'string', default: '3080' },
  watch: { type: 'boolean', default: false }, interval: { type: 'string', default: '750' },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: npm run official:supervise -- [--directory plugin-bundle] [--home data-directory] [--workspace working-directory] [--port 3080] [--watch] [--interval 750]\nRuns the pinned official Web/standard profile. Restart changes the process and authentication token; reopen the new URL. DSH_HOME and workspace must be outside the plugin bundle.');
} else {
  await mkdir(resolve(values.home), { recursive: true });
  let closing;
  const supervisor = await createOfficialSupervisor({ directory: values.directory, home: values.home, workspace: values.workspace,
    port: Number(values.port), watch: values.watch, interval: Number(values.interval), beforeLoad: verifyOfficial,
    onReload({ ok, error, recovered }) {
      if (ok) console.error('[cordis-harness] New process active; use the new official launch URL to reconnect.');
      else {
        console.error(`[cordis-harness] Update failed (${error.code ?? 'ERROR'}); ${recovered ? 'previous captured version restored in a new process' : 'cleanup/replacement is unconfirmed; automatic updates stopped'}.`);
        if (!recovered) { process.exitCode = 1; void close(); }
      }
    },
  });
  async function close() {
    if (closing) return closing;
    closing = supervisor.close().catch(async error => {
      console.error(`[cordis-harness] Shutdown not confirmed (${error.code ?? 'ERROR'}). Terminating the process boundary; external effects may remain.`);
      await supervisor.abandon();
      process.exitCode = 1;
    });
    return closing;
  }
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    const result = await supervisor.start();
    console.error(`[cordis-harness] Official Web process active (${result.digest}); ${values.watch ? 'watching plugin bundle' : 'send SIGINT/SIGTERM to stop'}.`);
  } catch (error) {
    console.error(`[cordis-harness] Startup failed (${error.code ?? 'ERROR'}).`);
    process.exitCode = 1;
    await close();
  }
}
