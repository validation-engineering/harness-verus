import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
function run(args, env) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env,
    timeout: 45000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  return result;
}
const environment = home => ({ PATH:process.env.PATH, HOME:home, DSH_HOME:join(home,'dsh'), DSH_TELEMETRY_DISABLED:'1' });

test('official extension launcher initializes editable profiles and preserves existing patches', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cordis-extension-launcher-'));
  t.after(() => rm(home, {recursive:true,force:true}));
  const env = environment(home);
  const first = run(['scripts/official-extensions.mjs','web','--dump-config'], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /greeting\.mjs/);
  assert.match(first.stdout, /rust-text-analysis\.mjs/);
  const patch = join(env.DSH_HOME,'profiles/web/cordis.patch.yml');
  const custom = (await readFile(patch, 'utf8')) + '\n# retained user comment\n';
  await writeFile(patch, custom);
  const second = run(['scripts/official-extensions.mjs','web','--dump-config'], env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(patch, 'utf8'), custom);
  assert.match(await readFile(join(env.DSH_HOME,'profiles/headless/cordis.patch.yml'),'utf8'), /rust-text-analysis\.mjs/);
});

test('official extension preload rejects an ambient native binding override', () => {
  const result = run(['--import','./scripts/official-extensions-register.mjs','--eval',''],
    {...process.env,CORDIS_NATIVE_BINDING:'/unverified/addon.node'});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unset CORDIS_NATIVE_BINDING/);
});

test('ESM Workers inherit and validate the selected extension addon', async t => {
  const directory = await mkdtemp(join(tmpdir(),'cordis-extension-worker-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const file = join(directory,'worker.mjs');
  await writeFile(file, `import {parentPort} from 'node:worker_threads';
import {Context} from '@deepseek-ai/cordis';
const ctx=new Context();
await ctx.rustPlugin('harness.text-analysis');
let result;
await ctx.inject(['rustTextAnalysis'],async child=>{result=await child.rustTextAnalysis.analyze('worker');});
await ctx.dispose();
parentPort.postMessage({result,nodes:ctx.snapshot().plugins.length});\n`);
  const program = `import assert from 'node:assert/strict'; import {Worker} from 'node:worker_threads';
const worker=new Worker(${JSON.stringify(file)});
const result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
assert.equal(result.result.backend,'rust');assert.equal(result.result.words,1);assert.equal(result.nodes,0);
const exit=await new Promise(resolve=>worker.once('exit',resolve));assert.equal(exit,0);`;
  const parent = join(directory, 'parent.mjs');
  await writeFile(parent, program);
  const result = run(['--import','./scripts/official-extensions-register.mjs',parent], environment(directory));
  assert.equal(result.status,0,result.stderr);
});
