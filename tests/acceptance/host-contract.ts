import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Standalone HOST PORT evidence only. The SeatRequest below is explicitly a
// test fixture, not a Roundtable spawn receipt or product protocol acceptance.
const model = 'opencode-go/deepseek-v4.1-flash';
const root = realpathSync(mkdtempSync('/tmp/rt-host-contract-'));
const evidence = `${root}/evidence.jsonl`;
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const native = process.env.OMP_HOST_CONTRACT_BINARY ?? '/Users/mouriya/Library/Application Support/Tern/omp/bin/omp';
const requestName = `RtHost${crypto.randomUUID().replaceAll('-', '')}`;
let token = '';
function safe(text: string): string {
  return text.replaceAll(token || '\u0000', '[REDACTED]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
function emit(value: unknown): void {
  const line = safe(JSON.stringify(value));
  appendFileSync(evidence, `${line}\n`, { mode: 0o600 });
  console.log(line);
}
type Exit = { code: number | null; signal: NodeJS.Signals | null };
const exits = new WeakMap<ChildProcessWithoutNullStreams, Promise<Exit>>();
function launch(binary: string, args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = Promise.withResolvers<Exit>();
  child.once('exit', (code, signal) => completion.resolve({ code, signal }));
  child.once('error', completion.reject);
  exits.set(child, completion.promise);
  return child;
}
async function command(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const child = launch(binary, args, env);
  let text = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { text += chunk; }); child.stderr.resume(); child.stdin.end();
  const exit = await exits.get(child)!;
  if (exit.code !== 0) throw new Error(`${binary} ${args[0]} failed (${exit.code}); diagnostic output suppressed`);
  return text.trim();
}
async function stop(child: ChildProcessWithoutNullStreams, name: string): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.stdin.end();
  const term = setTimeout(() => child.kill('SIGTERM'), 5000);
  const kill = setTimeout(() => child.kill('SIGKILL'), 10000);
  const result = await exits.get(child)!; clearTimeout(term); clearTimeout(kill);
  emit({ phase: 'process_exit', process: name, ...result });
}
async function allocatePort(): Promise<number> {
  const server = createServer();
  const started = Promise.withResolvers<void>();
  server.once('error', started.reject);
  server.listen(0, '127.0.0.1', started.resolve);
  await started.promise;
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No TCP address');
  const stopped = Promise.withResolvers<void>();
  server.close(error => error ? stopped.reject(error) : stopped.resolve());
  await stopped.promise;
  return address.port;
}
async function listening(port: number): Promise<boolean> {
  const connection = Promise.withResolvers<boolean>();
  const socket = connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); connection.resolve(true); });
  socket.once('error', () => connection.resolve(false));
  return connection.promise;
}
const hostImport = `./${relative(root, `${checkout}/src/ports/host.ts`)}`;
const modelImport = `./${relative(root, `${checkout}/src/domain/model.ts`)}`;
const contractsImport = `./${relative(root, `${checkout}/src/ports/contracts.ts`)}`;
const probe = String.raw`
import { appendFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { z, getAgentDir, type ExtensionAPI, type ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { AgentRegistry, MAIN_AGENT_ID } from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import { AgentLifecycleManager } from '@oh-my-pi/pi-coding-agent/registry/agent-lifecycle';
import { cfgAsyncEnabled } from '@oh-my-pi/pi-coding-agent/tools/settings';
import { cfgTaskIsolationEnabled } from '@oh-my-pi/pi-coding-agent/task/settings';
import { createHostPort } from HOST_IMPORT;
import type { Caller, SeatRequest } from MODEL_IMPORT;
import type { HostPort } from CONTRACTS_IMPORT;
const output = OUTPUT;
const wanted = MODEL;
const requestedName = REQUEST_NAME;
const runId = 'host-contract-run';
const registry = AgentRegistry.global();
const lifecycle = AgentLifecycleManager.global();
type SharedProbe = {
  fixture: SeatRequest | undefined;
  host: HostPort | undefined;
  contexts: Map<string,ExtensionContext>;
  callers: Map<string,Caller>;
  endCounts: Map<string,number>;
};
const slots = globalThis as typeof globalThis & { [key:symbol]: SharedProbe | undefined };
const key = Symbol.for('omp-roundtable.host-contract.' + requestedName);
const shared = slots[key] ??= {fixture:undefined,host:undefined,contexts:new Map(),callers:new Map(),endCounts:new Map()};
const host = shared.host ??= createHostPort(id => shared.fixture?.id === id ? shared.fixture : undefined);
const {contexts,callers,endCounts} = shared;
let acceptedTask = false;
let childId: string | undefined;
let checking = false;
let done = false;
function emit(value: unknown) { appendFileSync(output, JSON.stringify(value) + '\n', {mode:0o600}); }
function requireThat(condition: unknown, clause: string) { emit({phase:'assertion', clause, ok:Boolean(condition)}); if (!condition) throw new Error('host-contract failure: ' + clause); }
function identity(ctx: ExtensionContext, phase: string) {
  const ref = registry.get(ctx.agent.id); const session = ref?.session;
  const actual = session?.model ? session.model.provider + '/' + session.model.id : null;
  const thinking = session?.thinkingLevel;
  emit({phase, agent:ctx.agent, model:actual, thinkingLevel:thinking, sameSessionManager:session?.sessionManager === ctx.sessionManager, lifecycleOwnsRegistry:lifecycle.manages(registry), asyncEnabled:session && cfgAsyncEnabled.get(session.settings), isolationEnabled:session && cfgTaskIsolationEnabled.get(session.settings), asyncManager:session?.asyncJobManager !== undefined, cwd:ctx.cwd,agentDir:getAgentDir()});
  if(actual !== wanted || thinking !== 'low') { writeFileSync(MISMATCH_PATH,'model mismatch',{mode:0o600}); ctx.abort(); }
  requireThat(actual === wanted && thinking === 'low', 'exact model and low for ' + ctx.agent.id);
  requireThat(session?.sessionManager === ctx.sessionManager && lifecycle.manages(registry), 'host-created session and shared lifecycle for ' + ctx.agent.id);
}
function bind(ctx: ExtensionContext) {
  const previous = contexts.get(ctx.agent.id);
  const before = callers.get(ctx.agent.id);
  const result = host.bind(ctx,runId);
  requireThat(result.ok,'real context binding ' + ctx.agent.id);
  if (!result.ok) return;
  contexts.set(ctx.agent.id,ctx); callers.set(ctx.agent.id,result.value);
  if (previous) emit({phase:'binding_update',agentId:ctx.agent.id,newContext:previous !== ctx,sameManager:previous.sessionManager === ctx.sessionManager,sameCallerSession:before?.sessionId === result.value.sessionId});
  if (shared.fixture?.binding.kind === 'bound' && shared.fixture.binding.agentId === ctx.agent.id) shared.fixture = {...shared.fixture,binding:{...shared.fixture.binding,sessionId:result.value.sessionId}};
}
async function waitUntil(test:()=>boolean, label:string, timeout=120000) {
  const deadline = Date.now()+timeout;
  while (!test()) { if (Date.now()>deadline) throw new Error('host-contract timeout: '+label); await delay(50); }
}
async function checks(ctx:ExtensionContext) {
  requireThat(!checking,'single native check call'); checking=true;
  try {
    requireThat(acceptedTask,'Main native task accepted before fixture');
    await waitUntil(()=>registry.list().some(ref=>ref.parentId===MAIN_AGENT_ID && ref.id===requestedName),'child registration');
    await waitUntil(()=>{ const current=registry.get(requestedName); return Boolean(current && callers.get(current.id) && (endCounts.get(current.id)??0)>0 && current.status==='idle'); },'real completed child');
    const ref=registry.get(requestedName)!; childId=ref.id;
    emit({phase:'native_lifecycle_state',agentId:ref.id,status:ref.status,adopted:lifecycle.has(ref.id,ref),hasSession:Boolean(ref.session),sessionFile:ref.sessionFile??null});
    const childCtx=contexts.get(ref.id)!; const childCaller=callers.get(ref.id)!;
    requireThat(childCtx.cwd!==ctx.cwd,'async isolated child cwd differs from Main');
    identity(childCtx,'child_source_identity');
    const member={repo:{owner:'test-fixture',name:'host-contract'},number:1};
    const fixture: SeatRequest={id:'test-seat-request',role:'owner',context:{kind:'member',member},obligation:{kind:'owner',member},name:requestedName,assignment:'HOST CONTRACT TEST FIXTURE ONLY',runId,binding:{kind:'bound',agentId:ref.id,sessionId:childCaller.sessionId,parentId:MAIN_AGENT_ID},receipt:null};
    shared.fixture=fixture;
    emit({phase:'test_fixture',source:'accepted native task tool_result plus actual registry and bound child context',fixture});
    const validation=await host.validate(ctx.cwd,['task:free']); emit({phase:'preflight',result:validation}); requireThat(validation.ok,'native async/isolation/effective nonblocking agent preflight');
    const mainCaller=callers.get(MAIN_AGENT_ID)!;
    const observation=host.observe(runId,mainCaller); emit({phase:'observation',result:observation}); requireThat(observation.ok,'native registry observation');
    const base={requestId:fixture.id,runId,agentId:ref.id,parentId:MAIN_AGENT_ID,messageId:'test-wake-1',body:'HOST CONTRACT TEST: Reply exactly HOST_CHILD_WOKEN; do not call tools.',startedAt:Date.now()};
    for (const [clause,change] of [['request',{requestId:'absent-request'}],['run',{runId:'wrong-run'}],['parent',{parentId:'wrong-parent'}],['holder',{agentId:'absent-holder'}]] as const) {
      const result=await host.wake({...base,...change}); emit({phase:'rejected_wake',clause,result}); requireThat(!result.ok && result.error.kind==='precondition','reject '+clause+' mismatch');
    }
    await lifecycle.park(ref.id);
    requireThat(ref.status==='parked' && !ref.session,'real lifecycle park and detach');
    emit({phase:'parked',agentId:ref.id,status:ref.status,hasSession:Boolean(ref.session),turnEnds:endCounts.get(ref.id)});
    const beforeEnds=endCounts.get(ref.id)??0; const started=performance.now();
    const receipt=await host.wake(base); const elapsedMs=performance.now()-started;
    emit({phase:'wake_receipt',result:receipt,elapsedMs,childEndsBefore:beforeEnds,childEndsAtReturn:endCounts.get(ref.id)??0,statusAtReturn:ref.status});
    requireThat(receipt.ok && (receipt.value.outcome==='injected'||receipt.value.outcome==='woken'),'literal native direct delivery receipt');
    requireThat((endCounts.get(ref.id)??0)===beforeEnds,'wake resolves without waiting for complete child model turn');
    await waitUntil(()=>(endCounts.get(ref.id)??0)>beforeEnds && ref.status==='idle','wake child response and idle');
    const session=ref.session!;
    requireThat(session && !session.isStreaming,'real idle child after fast reply');
    const finalAssistant=session.messages.filter(message=>message.role==='assistant').at(-1);
    requireThat(finalAssistant?.role==='assistant' && finalAssistant.content.some(part=>part.type==='text' && part.text.trim()==='HOST_CHILD_WOKEN'),'direct wake reached exact child and returned expected response');
    const replies=session.messages.filter(message=>message.role==='assistant').map(message=>({role:message.role,provider:message.role==='assistant'?message.provider:null,model:message.role==='assistant'?message.model:null,stopReason:message.role==='assistant'?message.stopReason:null}));
    emit({phase:'child_terminal_metadata',agentId:ref.id,messages:replies});
    host.noteTurnEnd(ref.id,runId,base.messageId);
    emit({phase:'turn_end_observation',result:host.observe(runId,mainCaller)});
    requireThat(typeof session.setPlanModeState==='function','native real plan state setter');
    const prior=session.getPlanModeState(); session.setPlanModeState({enabled:true,planFilePath:PLAN_PATH});
    try { const result=await host.wake({...base,messageId:'plan-must-reject'}); emit({phase:'idle_plan_rejection',result,plan:session.getPlanModeState()?.enabled,isStreaming:session.isStreaming}); requireThat(!result.ok && result.error.kind==='precondition' && result.error.message.includes('idle in plan mode'),'reject actual idle plan child'); }
    finally { session.setPlanModeState(prior); }
    const latest=contexts.get(ref.id)!;
    host.release(latest);
    const released=await host.wake({...base,messageId:'released-must-reject'}); emit({phase:'manager_release',result:released,nativeContext:true,sameManager:latest.sessionManager===session.sessionManager}); requireThat(!released.ok && latest.sessionManager===session.sessionManager,'real context manager release clears bound use');
    bind(latest);
    await lifecycle.park(ref.id); requireThat(ref.status==='parked','fast reply can park without invalidating earlier receipt');
    const aborted=await lifecycle.release(ref.id,ref,{tombstone:true});
    const abortWake=await host.wake({...base,messageId:'aborted-must-reject'}); emit({phase:'aborted',released:aborted,status:ref.status,result:abortWake}); requireThat(aborted && ref.status==='aborted' && !abortWake.ok,'actual abort refuses wake');
    await lifecycle.release(ref.id,ref);
    const absent=await host.wake({...base,messageId:'absent-must-reject'}); emit({phase:'absent',registered:Boolean(registry.get(ref.id)),result:absent}); requireThat(!registry.get(ref.id) && !absent.ok,'actual absence refuses wake');
    done=true; emit({phase:'host_contract_result',success:true,scope:'HostPort only; not Roundtable application acceptance'});
    return {content:[{type:'text',text:'HOST_CONTRACT_OK'}],details:{ok:true}};
  } catch(error) {
    emit({phase:'host_contract_failure',error:error instanceof Error?error.message:String(error),registry:registry.list().map(ref=>({id:ref.id,status:ref.status,hasSession:Boolean(ref.session),adopted:lifecycle.has(ref.id,ref)}))});
    const fixture=shared.fixture;
    if(childId && fixture) {
      const ref=registry.get(childId);
      if(ref) {
        const released=await lifecycle.release(childId,ref,{tombstone:true});
        const aborted=await host.wake({requestId:fixture.id,runId,agentId:childId,parentId:MAIN_AGENT_ID,messageId:'failure-cleanup-abort',body:'must not deliver',startedAt:Date.now()});
        emit({phase:'failure_cleanup_abort',released,status:ref.status,result:aborted});
        await lifecycle.release(childId,ref);
        const absent=await host.wake({requestId:fixture.id,runId,agentId:childId,parentId:MAIN_AGENT_ID,messageId:'failure-cleanup-absent',body:'must not deliver',startedAt:Date.now()});
        emit({phase:'failure_cleanup_absence',registered:Boolean(registry.get(childId)),result:absent});
      }
    }
    throw error;
  }
}
export default function(pi:ExtensionAPI) {
  pi.registerTool({name:'rt_host_check',label:'Host contract',description:'Main: after native task accepted, run host boundary checks once.',defaultInactive:true,loadMode:'essential',parameters:z.object({}),async execute(_id,_params,_signal,_update,ctx){ return checks(ctx); }});
  pi.on('session_start',async(_event,ctx)=>{
    identity(ctx,'session_start'); bind(ctx);
    if(ctx.agent.kind==='main') writeFileSync(LOADED_PATH,'ready',{mode:0o600});
    const prior=pi.getActiveTools(); const hidden=!prior.includes('rt_host_check');
    await pi.setActiveTools([...prior,'rt_host_check']); const active=pi.getActiveTools().includes('rt_host_check');
    await pi.setActiveTools(prior); const restored=!pi.getActiveTools().includes('rt_host_check');
    emit({phase:'default_inactive',agentId:ctx.agent.id,hidden,active,restored}); requireThat(hidden&&active&&restored,'defaultInactive activation and restoration');
    if(ctx.agent.kind==='main') await pi.setActiveTools(['task','rt_host_check']);
  });
  pi.on('before_agent_start',(_event,ctx)=>{ identity(ctx,'before_agent_start'); bind(ctx); });
  pi.on('before_provider_request',(_event,ctx)=>{identity(ctx,'provider_request_metadata');});
  pi.on('tool_call',(event,ctx)=>{emit({phase:'tool_call',agentId:ctx.agent.id,name:event.toolName,input:event.toolName==='task'?event.input:undefined});});
  pi.on('tool_result',(event,ctx)=>{
    if(event.toolName==='task'&&ctx.agent.kind==='main') {
      emit({phase:'native_task_result',isError:event.isError,details:event.details,content:event.content});
      requireThat(!event.isError,'real task success');
      const details=event.details;
      requireThat(typeof details==='object' && details!==null && 'async' in details && typeof details.async==='object' && details.async!==null && 'jobId' in details.async && details.async.jobId===requestedName,'accepted native task names exact child');
      acceptedTask=true;
    }
  });
  pi.on('agent_end',(_event,ctx)=>{
    endCounts.set(ctx.agent.id,(endCounts.get(ctx.agent.id)??0)+1);
    const session=registry.get(ctx.agent.id)?.session;
    const last=session?.messages.filter(message=>message.role==='assistant').at(-1);
    const assistant=last?.role==='assistant'?{provider:last.provider,model:last.model,stopReason:last.stopReason,text:last.content.filter(part=>part.type==='text').map(part=>part.type==='text'?part.text:'').join('')}:null;
    emit({phase:'agent_end',agentId:ctx.agent.id,count:endCounts.get(ctx.agent.id),status:registry.get(ctx.agent.id)?.status,assistant});
    if(assistant) requireThat(assistant.provider==='opencode-go' && assistant.model==='deepseek-v4.1-flash','actual assistant model at terminal '+ctx.agent.id);
  });
  pi.on('session_shutdown',(_event,ctx)=>{
    host.release(ctx); emit({phase:'session_shutdown',agentId:ctx.agent.id,contextMatched:contexts.get(ctx.agent.id)?.sessionManager===ctx.sessionManager,parked:registry.get(ctx.agent.id)?.status==='parked'});
    if(ctx.agent.kind==='main') { const main=callers.get(MAIN_AGENT_ID); const after=main?host.observe(runId,main):null; emit({phase:'main_shutdown_release',result:after,done}); host.dispose(); emit({phase:'host_disposed',done,childId}); }
  });
}
`.replace('HOST_IMPORT', JSON.stringify(hostImport)).replace('MODEL_IMPORT', JSON.stringify(modelImport)).replace('CONTRACTS_IMPORT', JSON.stringify(contractsImport)).replace('OUTPUT', JSON.stringify(evidence)).replace('MODEL;', `${JSON.stringify(model)};`).replace('REQUEST_NAME', JSON.stringify(requestName)).replace('PLAN_PATH', JSON.stringify(`${root}/fixture-plan.md`)).replace('LOADED_PATH',JSON.stringify(`${root}/main-loaded`)).replace('MISMATCH_PATH',JSON.stringify(`${root}/model-mismatch`));

let broker: ChildProcessWithoutNullStreams | undefined;
let child: ChildProcessWithoutNullStreams | undefined;
let success = false;
const ownerHome = homedir();
const clean = { ...process.env }; delete clean.OMP_PROFILE; delete clean.PI_PROFILE; delete clean.OMP_AUTH_BROKER_TOKEN; delete clean.OMP_AUTH_BROKER_URL;
const ownerEnv = { ...clean, HOME: ownerHome, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? `${ownerHome}/.omp/agent` };
try {
  for (const name of ['home','config','agent','cwd','tmp','tern','cwd/.omp/agents']) mkdirSync(`${root}/${name}`, { recursive: true, mode: 0o700 });
  writeFileSync(`${root}/probe.ts`, probe, { mode: 0o600 });
  writeFileSync(`${root}/cwd/.omp/agents/task-free.md`, `---\nname: task:free\ndescription: Host contract fixture child\nmodel: ${model}:low\nthinkingLevel: low\nblocking: false\n---\nPerform only the assigned host-contract response. Never delegate or modify files. Reply exactly as requested, with no tools.\n`, { mode: 0o600 });
  writeFileSync(`${root}/overlay.yml`, `async:\n  enabled: true\ntask:\n  batch: false\n  agentIdleTtlMs: 0\n  isolation:\n    enabled: true\n  agentModelOverrides:\n    "task:free": "${model}:low"\nadvisor:\n  enabled: false\nretry:\n  enabled: false\n  modelFallback: false\nproviders:\n  cacheWarming: off\ntelemetry:\n  otlpExportEnabled: false\nmarketplace:\n  autoUpdate: false\nstartup:\n  checkUpdate: false\n`, { mode: 0o600 });
  emit({ phase: 'source', checkout, hostImport, evidence, requestName, scope: 'HostPort only', hostVersion: await command(native,['--version'],ownerEnv) });
  await command('git',['-C',`${root}/cwd`,'init','--initial-branch=main'],clean);
  await command('git',['-C',`${root}/cwd`,'-c','user.name=Host Contract','-c','user.email=host-contract@example.invalid','commit','--allow-empty','-m','host contract fixture'],clean);
  const port=await allocatePort(); const url=`http://127.0.0.1:${port}`;
  emit({phase:'broker_launch',executable:native,argv:['auth-broker','serve',`--bind=127.0.0.1:${port}`],credentialSource:'owner existing store; token memory only'});
  broker=launch(native,['auth-broker','serve',`--bind=127.0.0.1:${port}`],ownerEnv); broker.stdout.resume(); broker.stderr.resume();
  const deadline=Date.now()+15000;
  while(!await listening(port)){if(broker.exitCode!==null||broker.signalCode!==null||Date.now()>deadline)throw new Error('Owner broker unavailable');await delay(100);}
  const payload:unknown=JSON.parse(await command(native,['auth-broker','token','--json'],{...ownerEnv,OMP_AUTH_BROKER_URL:url}));
  if(typeof payload==='string')token=payload;else if(typeof payload==='object'&&payload!==null&&'token'in payload&&typeof payload.token==='string')token=payload.token;
  if(!token)throw new Error('Owner broker returned no token');
  const env={PATH:process.env.PATH,HOME:`${root}/home`,TMPDIR:`${root}/tmp`,PI_CONFIG_DIR:`${root}/config`,PI_CODING_AGENT_DIR:`${root}/agent`,OMP_WORKTREE_DIR:`${root}/worktrees`,TERN_CONFIG_DIR:`${root}/tern`,TERN_DAEMON_SOCKET:`${root}/no-daemon.sock`,OMP_AUTH_BROKER_URL:url,OMP_AUTH_BROKER_TOKEN:token,PI_NO_PTY:'1',PI_NOTIFICATIONS:'off',TERM:'dumb'};
  const args=['--cwd',`${root}/cwd`,'--model',model,'--thinking','low','--mode','rpc','--no-ui','--no-session','--no-title','--no-lsp','--no-extensions','--no-skills','--no-rules','-e',`${root}/probe.ts`,'--config',`${root}/overlay.yml`,'--approval-mode','yolo'];
  emit({phase:'rpc_launch',executable:native,argv:args,isolatedHome:env.HOME,isolatedAgentDir:env.PI_CODING_AGENT_DIR,profilesCleared:true,fallbackEnabled:false,ptysAllocated:0});
  child=launch(native,args,env); const active=child;
  let stderr=''; child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{stderr=(stderr+safe(chunk)).slice(-12000);});
  const completed = Promise.withResolvers<void>();
    let pending='';let finished=false;let checkResult=false;
    const timer=setTimeout(()=>finish(new Error('Native host contract timed out after 240 seconds')),240000);
    const modelGuard=setInterval(()=>{if(existsSync(`${root}/model-mismatch`))finish(new Error('Native session model/thinking mismatch; probe aborted without fallback'));},50);
    function finish(error?:Error){if(finished)return;finished=true;clearTimeout(timer);clearInterval(modelGuard);if(error)completed.reject(error);else completed.resolve();}
    function send(value:unknown){active.stdin.write(JSON.stringify(value)+'\n');}
    active.stdout.setEncoding('utf8');active.stdout.on('data',chunk=>{
      pending+=chunk;
      while(pending.includes('\n')){
        const end=pending.indexOf('\n');const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim())continue;
        try{
          const frame:unknown=JSON.parse(line);if(typeof frame!=='object'||frame===null||!('type'in frame))continue;
          if(frame.type==='ready'){emit({phase:'rpc_ready'});send({type:'get_state',id:'identity'});}
          else if(frame.type==='response'&&'id'in frame&&frame.id==='identity'){
            const data='data'in frame?frame.data:null;
            if(typeof data!=='object'||data===null||!('model'in data)||typeof data.model!=='object'||data.model===null||!('provider'in data.model)||!('id'in data.model))throw new Error('RPC state missing model identity');
            const actual=`${data.model.provider}/${data.model.id}`;const thinking='thinkingLevel'in data?data.thinkingLevel:null;
            emit({phase:'rpc_identity',model:actual,thinkingLevel:thinking});if(actual!==model||thinking!=='low')throw new Error('Root model mismatch; aborting probe');
            if(!existsSync(`${root}/main-loaded`))throw new Error(`Host contract extension did not initialize; stderr=${stderr}`);
            const message=`Host boundary test only. First call the native task tool exactly once with agent "task:free", name "${requestName}", isolated true, task "Reply exactly HOST_CHILD_READY. Do not call tools or modify files.", solutionSpace "one exact text response". After native task returns accepted, call rt_host_check with {} once. Do not wait for the child yourself. After rt_host_check succeeds, reply exactly HOST_CONTRACT_OK. Do not call any other tools or spawn additional children.`;
            emit({phase:'prompt_sent',message});send({type:'prompt',id:'host-contract',message});
          }else if(frame.type==='tool_execution_end'&&'toolName'in frame&&frame.toolName==='rt_host_check'){
            emit({phase:'rpc_check_result',frame});checkResult=!('isError'in frame&&frame.isError===true);if(!checkResult)throw new Error('Host check tool failed');
          }else if(frame.type==='message_end'&&'message'in frame){
            const message=frame.message;if(typeof message==='object'&&message!==null&&'role'in message&&message.role==='assistant'){
              emit({phase:'root_assistant_metadata',provider:'provider'in message?message.provider:null,model:'model'in message?message.model:null,stopReason:'stopReason'in message?message.stopReason:null});
              if(('provider'in message&&message.provider!=='opencode-go')||('model'in message&&message.model!=='deepseek-v4.1-flash'))throw new Error('Actual root response model mismatch');
            }
          }else if(frame.type==='agent_end'){if(!checkResult)throw new Error(`Main ended without successful host checks; stderr=${stderr}`);success=true;finish();}
          else if(frame.type==='extension_error'||frame.type==='error'){emit({phase:'rpc_failure',frame});throw new Error('Native error frame');}
        }catch(error){finish(error instanceof Error?error:new Error(String(error)));}
      }
    });
    exits.get(active)!.then(exit=>{if(!finished)finish(new Error(`Native exited early ${JSON.stringify(exit)} stderr=${stderr}`));},finish);
  await completed.promise;
}catch(error){emit({phase:'probe_failure',error:error instanceof Error?error.message:String(error)});}
finally{
  if(child)await stop(child,'native-root');
  if(broker){broker.kill('SIGTERM');await stop(broker,'owner-auth-broker');}
  token='';emit({phase:'cleanup',rootStopped:!child||child.exitCode!==null||child.signalCode!==null,brokerStopped:!broker||broker.exitCode!==null||broker.signalCode!==null,ptysAllocated:0,credentialCopies:0,success,evidence});
  process.exitCode=success?0:1;
}
