#!/usr/bin/env node
import '@validation-engineering/cordis-compat-deepseek/register';
import { parseArgs } from 'node:util';
import { mkdir, mkdtemp, copyFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const { readConfig, createHarness } = await import('./app.mjs');

const project = fileURLToPath(new URL('../', import.meta.url));
const usage = `harness-verus compact — official Harness plugins on Rust-backed Cordis

  demo                          Offline real-agent/tool integration in a fresh workspace
  run <prompt>                  Run one agent turn; --resume reopens a persisted session
  chat                          Interactive session; /help lists plugin commands
  plugins                       Show configured plugins and active tools
  sessions                      List persisted sessions
  inspect <session-id>          Read up to 50 persisted events

Options:
  --config <file>                Configuration file (default harness.config.json)
  --workspace <directory>        Override the workspace root
  --provider scripted|deepseek   Select offline fixture or official DeepSeek provider
  --model <id>                   Explicit provider model
  --session <id> --resume        Choose / restore a session
  --allow-write                 Enable workspace_write explicitly
  --json                        Print machine-readable command results
  --help                        Show this text
`;
const parsed = parseArgs({ allowPositionals: true, options: {
  config: { type: 'string', default: resolve(project, 'harness.config.json') },
  workspace: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' },
  session: { type: 'string' }, resume: { type: 'boolean' },
  'allow-write': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean' },
} });
const { values, positionals } = parsed;
const command = positionals[0] ?? 'help';
function show(result) {
  if (values.json) console.log(JSON.stringify(result));
  else if (result?.answer !== undefined) {
    console.log(result.answer || `Turn ended: ${result.reason.kind}`);
    console.log(`Session: ${result.sessionId} | provider: ${result.provider} | ${result.toolCalls.length} tool calls | ${result.eventCount} events`);
    if (!result.ok) console.error(JSON.stringify({ reason: result.reason, toolErrors: result.toolErrors }));
  } else console.log(JSON.stringify(result, null, 2));
}
async function main() {
  if (values.help || command === 'help') { console.log(usage); return; }
  if (!['demo', 'run', 'chat', 'plugins', 'sessions', 'inspect'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const overrides = {};
  if (values.workspace) overrides.workspace = resolve(values.workspace);
  if (values.provider || values.model) overrides.provider = {
    ...(values.provider ? { type: values.provider } : {}), ...(values.model ? { model: values.model } : values.provider ? { model: values.provider === 'deepseek' ? 'deepseek-flash' : 'demo' } : {}),
  };
  const config = await readConfig(values.config, overrides);
  if (values['allow-write']) for (const spec of config.plugins) {
    if (spec.module === 'local:workspace') spec.config = { ...spec.config, allowWrite: true };
  }
  let demoWorkspace;
  if (command === 'demo') {
    const directory = resolve(project, '.cordis-harness/demos');
    await mkdir(directory, { recursive: true });
    demoWorkspace = await mkdtemp(directory + '/workspace-');
    await copyFile(resolve(project, 'examples/workspace/README.md'), resolve(demoWorkspace, 'README.md'));
    config.workspace = demoWorkspace;
    config.provider = { type: 'scripted', model: 'demo' };
    config.sessionDirectory = resolve(project, '.cordis-harness/demo-sessions');
    config.plugins = [
      { id: 'todo', module: 'official:todo' },
      { id: 'workspace', module: 'local:workspace', config: { allowWrite: true } },
    ];
  }
  const app = await createHarness(config);
  const stopping = new AbortController();
  let terminationCode;
  const interrupt = () => {
    if (command === 'chat' && !app.isBusy()) stopping.abort();
    else app.cancel();
  };
  const terminate = () => { terminationCode = 143; stopping.abort(); app.cancel(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    if (command === 'plugins') return show({ plugins: app.plugins(), tools: app.tools() });
    if (command === 'sessions') return show(await app.sessions());
    if (command === 'inspect') {
      if (!positionals[1]) throw new Error('inspect requires a session id');
      return show(await app.inspect(positionals[1]));
    }
    if (command === 'run' || command === 'demo') {
      const prompt = command === 'demo' ? 'Read README.md, create DEMO_RESULT.md and complete the todo list.' : positionals.slice(1).join(' ');
      if (!prompt.trim()) throw new Error('run requires a prompt');
      if (values.resume && !values.session) throw new Error('--resume requires --session');
      const result = await app.run(prompt, { sessionId: values.session, resume: values.resume });
      if (command === 'demo') {
        if (result.ok) await readFile(resolve(demoWorkspace, 'DEMO_RESULT.md'));
        result.workspace = demoWorkspace;
      }
      show(result);
      if (!result.ok) process.exitCode = result.reason.kind === 'aborted' ? 130 : 1;
      return;
    }
    if (!stdin.isTTY) throw new Error('chat needs an interactive terminal; use run for scripts');
    let sessionId = values.session ?? randomUUID();
    let resume = values.resume ?? false;
    const terminal = createInterface({ input: stdin, output: stdout });
    terminal.on('SIGINT', interrupt);
    console.log(`Session ${sessionId}. /help for commands. Provider: ${config.provider.type}.`);
    try {
      while (!stopping.signal.aborted) {
        let input;
        try { input = (await terminal.question('you> ', { signal: stopping.signal })).trim(); } catch { break; }
        if (!input) continue;
        if (input === '/exit') break;
        try {
          if (input === '/help') { console.log('/plugins | /load <id> <module> [JSON config] | /unload <id> | /reload <id> [JSON config] | /retry-cleanup <id> | /new | /exit'); continue; }
          if (input === '/plugins') { show({ plugins: app.plugins(), tools: app.tools() }); continue; }
          if (input === '/new') { sessionId = randomUUID(); resume = false; console.log(`Session ${sessionId}`); continue; }
          const parts = input.split(/\s+/);
          if (parts[0] === '/unload') { await app.unloadPlugin(parts[1]); console.log('Unloaded '+parts[1]); continue; }
          if (parts[0] === '/retry-cleanup') { await app.retryPluginCleanup(parts[1]); console.log('Cleanup confirmed for '+parts[1]); continue; }
          if (parts[0] === '/reload') { show(await app.reloadPlugin(parts[1], parts.length > 2 ? JSON.parse(parts.slice(2).join(' ')) : undefined)); continue; }
          if (parts[0] === '/load') { show(await app.loadPlugin({ id: parts[1], module: parts[2], config: parts.length > 3 ? JSON.parse(parts.slice(3).join(' ')) : {} })); continue; }
          show(await app.run(input, { sessionId, resume })); resume = false;
        } catch (error) { console.error(error.message); }
      }
    } finally { terminal.close(); }
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    await app.close();
    if (terminationCode) process.exitCode = terminationCode;
  }
}
try { await main(); }
catch (error) {
  console.error(error.stack ?? String(error));
  if (error instanceof AggregateError) for (const child of error.errors) console.error(child.stack ?? String(child));
  process.exitCode ??= error.name === 'AbortError' ? 130 : 1;
}
