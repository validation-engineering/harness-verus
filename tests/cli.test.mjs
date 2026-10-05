import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function run(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null, result.stderr);
  return result;
}
async function fixture(t) {
  const directory = await mkdtemp(tmpdir() + '/cordis-cli-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(directory + '/README.md', 'CLI process boundary fixture');
  const config = { schema: 1, workspace: '.', sessionDirectory: 'sessions', provider: { type: 'scripted', model: 'demo' }, plugins: [
    { id: 'todo', module: 'official:todo' }, { id: 'workspace', module: 'local:workspace', config: { allowWrite: true } },
  ] };
  const filename = directory + '/harness.config.json'; await writeFile(filename, JSON.stringify(config));
  return { directory, filename, config };
}

test('standalone CLI bootstraps routing without a --import flag and works outside the project cwd', async t => {
  const { directory, filename } = await fixture(t);
  const help = run(['--help'], directory); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /cordis-harness/);
  const listed = run(['plugins', '--config', filename, '--json'], directory);
  assert.equal(listed.status, 0, listed.stderr); assert.ok(JSON.parse(listed.stdout).tools.some(tool => tool.name === 'todo_write'));
});

test('CLI persists and resumes a session across two independent Node processes', async t => {
  const { directory, filename } = await fixture(t);
  const args = ['run', 'First process', '--config', filename, '--session', 'cli-session', '--json'];
  const first = run(args, directory); assert.equal(first.status, 0, first.stderr); assert.equal(JSON.parse(first.stdout).ok, true);
  const second = run([...args.slice(0, 1), 'Second process', ...args.slice(2), '--resume'], directory);
  assert.equal(second.status, 0, second.stderr); assert.equal(JSON.parse(second.stdout).ok, true);
  const inspect = run(['inspect', 'cli-session', '--config', filename, '--json'], directory);
  assert.equal(inspect.status, 0, inspect.stderr);
  const stored = JSON.parse(inspect.stdout);
  assert.equal(stored.events.filter(event => event.type === 'user/message').length, 2);
  assert.match(await readFile(directory + '/DEMO_RESULT.md', 'utf8'), /official AgentLoop/);
});

test('tool denial produces a nonzero CLI status and structured failure output', async t => {
  const { directory, filename, config } = await fixture(t);
  config.plugins[1].config.allowWrite = false; await writeFile(filename, JSON.stringify(config));
  const result = run(['run', 'Denied write', '--config', filename, '--json'], directory);
  assert.equal(result.status, 1, result.stderr);
  const response = JSON.parse(result.stdout); assert.equal(response.ok, false); assert.equal(response.toolErrors.length, 1);
});
