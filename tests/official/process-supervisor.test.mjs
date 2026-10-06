import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createOfficialSupervisor } from '../../src/official-supervisor.mjs';

// Development preflight is explicit. The normal test command uses installed artifacts.
const { ProcessDomain } = await import(process.env.CORDIS_HARNESS_PROCESS_DOMAIN_SOURCE
  ? pathToFileURL(resolve(process.env.CORDIS_HARNESS_PROCESS_DOMAIN_SOURCE)).href
  : '../../official-runtime/node_modules/@cordis-verus/compat-loader/process.js');
const plugin = (process.env.CORDIS_HARNESS_PROCESS_DOMAIN_SOURCE ? '' : `import { Context } from '@deepseek-ai/cordis';
if (typeof Context !== 'function') throw new Error('Native Harness facade was not routed');
`) + `import { appendFileSync } from 'node:fs';
import { version, failStartup, failCleanup } from './version.mjs';
export const name = 'process-fixture';
export const inject = ['webServer'];
export function apply(ctx) {
  const record = action => appendFileSync(process.env.CORDIS_TEST_LIFETIME, JSON.stringify({action, version, pid:process.pid}) + '\\n');
  record('start');
  ctx.effect(() => async () => { record('stop'); if (failCleanup) throw new Error('fixture cleanup rejected'); });
  if (failStartup) throw new Error('fixture candidate rejected');
  ctx.effect(() => ctx.webServer.register({ kind:'exact', path:'/process-fixture', handler(_req,res) {
    res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({version,pid:process.pid}));
  }}));
}`;
async function until(check, label) {
  const end = Date.now() + 30000;
  do { if (await check()) return; await delay(40); } while (Date.now() < end);
  throw new Error(`Timed out waiting for ${label}`);
}
function exited(pid) { try { process.kill(pid, 0); return false; } catch (error) { assert.equal(error.code, 'ESRCH'); return true; } }
async function fixture(t, options = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'cordis-official-process-test-'));
  const bundle = resolve(directory, 'bundle'), home = resolve(directory, 'dsh'), workspace = resolve(directory, 'workspace'), userHome = resolve(directory, 'user');
  await Promise.all([bundle, home, workspace, userHome].map(path => mkdir(path)));
  await writeFile(resolve(bundle, 'harness.json'), JSON.stringify({schemaVersion:1, plugins:[{id:'process-fixture',name:'./plugin.mjs'}]}));
  await writeFile(resolve(bundle, 'plugin.mjs'), plugin);
  const lifetime = resolve(directory, 'lifetime.jsonl');
  await writeFile(lifetime, '');
  async function version(value, flags = {}) { await writeFile(resolve(bundle, 'version.mjs'), `export const version=${JSON.stringify(value)},failStartup=${!!flags.failStartup},failCleanup=${!!flags.failCleanup};\n`); }
  await version('v1', options.initial);
  const urls = [];
  let output = '', outputError;
  const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(env, {PATH:process.env.PATH, TMPDIR:tmpdir(), HOME:userHome, USERPROFILE:userHome, LANG:'en_US.UTF-8', NO_COLOR:'1', TERM:'dumb',
    DSH_AGENTS_HOME:resolve(directory,'agents'), DSH_TELEMETRY_DISABLED:'1', CORDIS_TEST_LIFETIME:lifetime});
  const supervisor = await createOfficialSupervisor({directory:bundle,home,workspace,port:0,ProcessDomain,env,timeout:30000,
    ...options,
    ...(process.env.CORDIS_HARNESS_PROCESS_DOMAIN_SOURCE ? {beforeLoad:async()=>{}} : {}),
    onOutput({data}) {
      if (outputError) return;
      if (Buffer.byteLength(output) + Buffer.byteLength(data) > 2 * 1024 * 1024) { outputError = new Error('Child output exceeded 2 MiB'); return; }
      output += data;
      for (const match of output.matchAll(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/g)) if (!urls.includes(match[1])) urls.push(match[1]);
    },
  });
  t.after(async () => {
    try { await supervisor.close(); } catch { await supervisor.abandon(); }
    await rm(directory, {recursive:true,force:true});
    assert.equal(outputError, undefined, 'Process output must stay bounded');
  });
  async function authenticate(status) {
    await until(() => urls.some(value => new URL(value).origin === status.origin), 'official launch URL');
    const url = urls.findLast(value => new URL(value).origin === status.origin);
    const response = await fetch(url, {redirect:'manual',signal:AbortSignal.timeout(5000)});
    assert.equal(response.status, 303);
    const cookie = response.headers.getSetCookie().map(row => row.split(';')[0]).join('; ');
    assert(cookie);
    return {cookie, origin:status.origin};
  }
  async function rpc(auth, method, args) {
    const response = await fetch(`${auth.origin}/api/${method}`, {method:'POST',headers:{...auth,'content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:'process-test',method,payload:{args}}),signal:AbortSignal.timeout(5000)});
    assert.equal(response.status,200);
    const body = await response.json();
    assert.equal(body.result?.ok,true, `${method} failed`);
    return body.result.value;
  }
  return {supervisor, directory, bundle, home, workspace, env, version, authenticate, rpc, status:()=>supervisor.domain.call('supervisor','status'),
    records:async()=> (await readFile(lifetime,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),
    async served(status) {const response=await fetch(`${status.origin}/process-fixture`, {signal:AbortSignal.timeout(5000)}); assert.equal(response.status,200);return response.json();},
  };
}

test('real official Web: captured nested module update, reconnect, persisted session and failed-candidate recovery', async t => {
  const f=await fixture(t);
  const initial=await f.supervisor.start();
  const first=await f.status();
  assert.equal(first.rootContexts,1);
  assert(first.entries.length > 100);
  assert(first.entries.filter(row=>!row.disabled).every(row=>row.active));
  assert.deepEqual(await f.served(first),{version:'v1',pid:first.pid});
  const auth=await f.authenticate(first);
  const html=await (await fetch(first.origin,{headers:auth})).text();
  assert.match(html, /<title>DeepSeek Harness<\/title>/);
  const presets=await f.rpc(auth,'agentPresets/list',{});
  assert(presets.presets.some(row=>row.id==='standard'&&row.isDefault));
  const sessionId='process-reconnect';
  await f.rpc(auth,'session/create',{request:{cwd:f.workspace,sessionId}});
  const graph=await f.supervisor.domain.moduleGraph();
  assert(graph.edges.some(row=>row.from==='plugin.mjs'&&row.to==='version.mjs'));
  await f.version('v2');
  const plan=await f.supervisor.domain.planReload();
  assert(plan.affectedModules.includes('plugin.mjs'));
  assert(plan.changedFiles.some(row=>row.path==='version.mjs'));
  await f.supervisor.reload();
  const second=await f.status();
  assert.notEqual(second.pid,first.pid); assert(exited(first.pid));
  assert.deepEqual(await f.served(second),{version:'v2',pid:second.pid});
  const secondAuth=await f.authenticate(second);
  const sessions=await f.rpc(secondAuth,'session/list',{_request:{}});
  assert(sessions.items.some(row=>row.sessionId===sessionId), 'Official JSONL session must survive process replacement');
  const records=await f.records();
  assert(records.findIndex(row=>row.action==='stop'&&row.pid===first.pid)<records.findIndex(row=>row.action==='start'&&row.pid===second.pid), 'Old cleanup precedes candidate execution');
  await f.version('broken',{failStartup:true});
  await assert.rejects(f.supervisor.reload(), error=>error.code==='RELOAD_FAILED'&&error.details.restored===true);
  const restored=await f.status();
  assert.notEqual(restored.pid,second.pid); assert(exited(second.pid));
  assert.equal(f.supervisor.domain.lastRecovery.restored,true);
  assert.equal((await f.served(restored)).version,'v2', 'Recovery uses retained bytes, not the now-broken source');
  const restoredAuth=await f.authenticate(restored);
  assert((await f.rpc(restoredAuth,'session/list',{_request:{}})).items.some(row=>row.sessionId===sessionId));
  const all=await f.records();
  const candidate=all.find(row=>row.action==='start'&&row.version==='broken');
  assert(candidate && exited(candidate.pid));
  assert(all.some(row=>row.action==='stop'&&row.pid===candidate.pid), 'Failed candidate cleanup must run before recovery');
  await f.supervisor.close();
  assert.equal(f.supervisor.domain.state,'closed'); assert(exited(restored.pid));
  assert.notEqual(initial.digest, f.supervisor.domain.lastRecovery?.digest);
});

test('real official Web: failed cleanup prevents candidate admission and cannot claim normal shutdown', async t => {
  const f=await fixture(t,{initial:{failCleanup:true}});
  await f.supervisor.start();
  const first=await f.status();
  await f.version('must-not-start');
  await assert.rejects(f.supervisor.reload(), error=>['DOMAIN_ABANDONED','CLEANUP_BLOCKED'].includes(error.code));
  assert(['abandoned','blocked'].includes(f.supervisor.domain.state));
  assert(!(await f.records()).some(row=>row.version==='must-not-start'));
  assert.equal(f.supervisor.domain.lastRecovery,undefined);
  const result=await f.supervisor.abandon();
  assert.deepEqual(result,{abandoned:true,cleanupConfirmed:false});
  assert(exited(first.pid));
});

test('real official Web watcher rescans changes during replacement and stops before disposal', async t => {
  const updates=[];
  const f=await fixture(t,{watch:true,interval:50,onReload:value=>updates.push(value)});
  await f.supervisor.start();
  await f.version('watch-v2');
  await until(()=>f.supervisor.domain.state==='reloading', 'watch reload admission');
  await f.version('watch-v3');
  await until(()=>updates.filter(row=>row.ok).length >= 2 && f.supervisor.domain.state==='active', 'final rescan of a change made during replacement');
  assert.equal((await f.served(await f.status())).version, 'watch-v3');
  assert(updates.some(row=>row.ok));
  const final=await f.status();
  await f.supervisor.close();
  await f.version('after-close');
  await delay(150);
  assert(exited(final.pid));
  assert(!(await f.records()).some(row=>row.version==='after-close'));
});

// These tests isolate watcher coordination; the tests above exercise real Cordis.
function controlledDomain() {
  let instance;
  class Domain {
    constructor() { instance=this; this.state='empty'; this.loads=0; this.disposals=0; this.digest='initial'; }
    async load() { this.loads++; this.state='active'; return {digest:this.digest}; }
    async planReload() { return {candidateDigest:this.digest,identical:false}; }
    async reload() { this.loads++; return {digest:this.digest}; }
    async dispose() { this.disposals++; this.state='closed'; }
  }
  return {Domain, get instance(){return instance;}};
}
async function controlled(t, options) {
  const base=await mkdtemp(resolve(tmpdir(),'cordis-watch-coordination-'));
  await Promise.all(['bundle','home','workspace'].map(name=>mkdir(resolve(base,name))));
  const control=controlledDomain();
  const supervisor=await createOfficialSupervisor({directory:resolve(base,'bundle'),home:resolve(base,'home'),workspace:resolve(base,'workspace'),
    ProcessDomain:control.Domain,watch:true,interval:50,beforeLoad:async()=>{},...options});
  t.after(async()=>{await supervisor.close();await rm(base,{recursive:true,force:true});});
  return {supervisor,control};
}
test('watch coordination coalesces start and joins preflight when stopped', async t=>{
  const gate=Promise.withResolvers();
  const {supervisor,control}=await controlled(t,{beforeLoad:()=>gate.promise});
  const first=supervisor.start();
  assert.equal(supervisor.start(),first);
  const closing=supervisor.close();
  gate.resolve();
  await assert.rejects(first,/stopped during preflight/);
  await closing;
  assert.equal(control.instance.loads,0);
  assert.equal(control.instance.state,'closed');
});
test('watch observer exceptions stop notifications and remain separate from successful cleanup',async t=>{
  const error=new Error('observer failed');
  const {supervisor,control}=await controlled(t,{onReload(){throw error;}});
  await supervisor.start();
  control.instance.digest='changed';
  await until(()=>supervisor.observerError===error,'observer error');
  const loads=control.instance.loads;
  control.instance.digest='next';
  await delay(150);
  assert.equal(control.instance.loads,loads);
  await supervisor.close();
  assert.equal(control.instance.state,'closed');
  assert.equal(supervisor.observerError,error);
});

test('installed official supervisor CLI watches a real bundle and exits only after official cleanup', {
  skip: !!process.env.CORDIS_HARNESS_PROCESS_DOMAIN_SOURCE && 'Development-source preflight is not installed CLI acceptance',
}, async t => {
  const f=await fixture(t);
  const script=fileURLToPath(new URL('../../scripts/official-supervise.mjs',import.meta.url));
  const child=spawn(process.execPath,[script,'--directory',f.bundle,'--home',f.home,'--workspace',f.workspace,'--port','0','--watch','--interval','100'],
    {cwd:f.workspace,env:f.env,stdio:['ignore','pipe','pipe']});
  let output='',outputError,exitResult;
  function collect(chunk) {
    if(outputError) return;
    if(Buffer.byteLength(output)+Buffer.byteLength(chunk)>2*1024*1024) {outputError=new Error('CLI output exceeded 2 MiB');return;}
    output+=chunk;
  }
  const completed=Promise.withResolvers();
  child.once('error',completed.reject);
  child.once('close',(code,signal)=>{exitResult={code,signal};completed.resolve(exitResult);});
  child.stdout.on('data',collect);
  child.stderr.on('data',collect);
  t.after(async()=>{
    if(exitResult) return;
    child.kill('SIGTERM');
    await Promise.race([completed.promise,delay(10000)]);
    if(!exitResult) {child.kill('SIGKILL');await completed.promise;}
  });
  await until(()=>output.includes('watching plugin bundle') || exitResult,'CLI initial readiness');
  assert.equal(exitResult,undefined,'CLI must remain live');
  const first=(await f.records()).find(row=>row.action==='start');
  assert(first);
  await f.version('cli-v2');
  await until(()=>output.includes('New process active') || exitResult,'CLI watch reload');
  assert.equal(exitResult,undefined);
  const second=(await f.records()).find(row=>row.action==='start'&&row.version==='cli-v2');
  assert(second && second.pid!==first.pid && exited(first.pid));
  const url=[...output.matchAll(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/g)].at(-1)?.[1];
  assert(url);
  const response=await fetch(new URL('/process-fixture',url),{signal:AbortSignal.timeout(5000)});
  assert.deepEqual(await response.json(),{version:'cli-v2',pid:second.pid});
  child.kill('SIGTERM');
  assert.deepEqual(await completed.promise,{code:0,signal:null});
  assert(exited(second.pid));
  assert((await f.records()).some(row=>row.action==='stop'&&row.pid===second.pid));
  assert.equal(outputError,undefined,'CLI output must stay bounded');
});

test('stopping during watch preflight prevents candidate admission',async t=>{
  const entered=Promise.withResolvers(), gate=Promise.withResolvers();
  let checks=0;
  const {supervisor,control}=await controlled(t,{beforeLoad(){if(++checks===1)return;entered.resolve();return gate.promise;}});
  await supervisor.start();
  control.instance.digest='new-candidate';
  await entered.promise;
  const closing=supervisor.close();
  gate.resolve();
  await closing;
  assert.equal(control.instance.loads,1,'No candidate starts after watch shutdown admission');
  assert.equal(control.instance.state,'closed');
});
test('stopping during manual reload preflight prevents late candidate admission',async t=>{
  const entered=Promise.withResolvers(), gate=Promise.withResolvers();
  let checks=0;
  const {supervisor,control}=await controlled(t,{beforeLoad(){if(++checks===1)return;entered.resolve();return gate.promise;}});
  await supervisor.start();
  const reload=supervisor.reload();
  await entered.promise;
  const closing=supervisor.close();
  gate.resolve();
  await assert.rejects(reload,/stopped during preflight/);
  await closing;
  assert.equal(control.instance.loads,1);
});
test('a previous recovery cannot label a later admission failure as recovered',async t=>{
  const reports=[];
  const {supervisor,control}=await controlled(t,{onReload:value=>reports.push(value)});
  await supervisor.start();
  control.instance.lastRecovery={restored:true};
  control.instance.reload=async()=>{throw Object.assign(new Error('host changed'),{code:'HOST_CHANGED'});};
  control.instance.digest='new-candidate';
  await until(()=>reports.length>0,'failed admission notification');
  assert.equal(reports[0].recovered,false);
  await supervisor.close();
});
