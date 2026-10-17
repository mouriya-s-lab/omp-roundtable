import {randomUUID} from 'node:crypto';
import type {Agenda,Caller,ConveneInput,DecisionCase,DomainError,Effect,EffectResult,Event,FactRead,Inputs,OwnerWorkTerminal,Policy,PortError,PortInput,ReplyResult,Result,SeatRequest,Ticket} from '../domain/model.ts';
import {createAgenda,effectPrecondition,replyReplay,satisfiedResult,transition} from '../domain/engine.ts';
import {canonical,digest,issueStateBaselineMatches,sameRef} from '../domain/identity.ts';
import {callerOwns,callerTickets,mainCaller} from '../domain/tickets.ts';
import type {AgendaFiles,GitHubPort,HostPort,PolicyReader,StateError} from '../ports/contracts.ts';
import {createSourceReader,type EffectReceipt,type SourceReader} from './source.ts';

export type RuntimeError={kind:'domain';error:DomainError}|{kind:'storage';error:StateError}|{kind:'source'|'host'|'policy';error:PortError};
export type AgendaView={
  kind:'agenda';agenda:string;version:number;lifecycle:Agenda['lifecycle'];tickets:readonly Ticket[];
  cases:readonly DecisionCase[];effects:readonly Effect[];externalMerges:readonly OwnerWorkTerminal[];
  report:string|null;sourceError:PortError|null;
};
/** The startup check a coordinator Main runs once, before its first turn. */
export type StartupView={active:readonly string[]};
export type ControllerOutput=AgendaView|{kind:'plan';input:ConveneInput}|{kind:'accepted';agenda:string;version:number;reply:ReplyResult|null};
export type ControllerOptions={files:AgendaFiles;github:GitHubPort;host:HostPort;policy:PolicyReader;intervalSeconds:number;onChange:()=>void;onError:(error:RuntimeError)=>void};
type Selection={sessionId:string;agendaId:string};
type PendingWrite={expectedVersion:number|null;state:Agenda;reply:ReplyResult|null;selection:Selection|null;operation:PortInput|null};
type CommitResult=Result<ReplyResult|null,RuntimeError>;
type OperationResult=Result<ControllerOutput,RuntimeError>;
type CallResult={kind:'receipt';receipt:EffectReceipt}|{kind:'delivery';result:Extract<EffectResult,{kind:'delivered'}>}|{kind:'query'};

function domain(kind:DomainError['kind'],message:string):{ok:false;error:RuntimeError} {return {ok:false,error:{kind:'domain',error:{kind,message,current:null}}};}
function unavailable(message:string):PortError {return {kind:'unavailable',message};}
function sourceDependent(operation:PortInput):boolean {
  if(operation.op==='noCode')return true;
  if(operation.op!=='reply')return false;
  switch(operation.reply.kind){case 'submit':case 'verdict':case 'decision':case 'designCommit':return true;case 'claim':case 'spawned':case 'report':return false;}
}

/** The only writer. Registry/session identity remains owned by HostPort. */
export class RoundtableController {
  readonly runId=randomUUID();
  private readonly source:SourceReader;
  private main:Caller|null=null;
  private policy:Policy|null=null;
  private attached:Agenda|null=null;
  private facts:FactRead={kind:'unavailable',error:unavailable('No complete source observation has been read')};
  private pending:PendingWrite|null=null;
  private readonly selected=new Map<string,string>();
  private tail:Promise<void>=Promise.resolve();
  private timer:ReturnType<typeof setInterval>|null=null;
  private scheduled:{handle:ReturnType<typeof setTimeout>;cause:'event'|'registry'}|null=null;
  private closed=false;

  constructor(private readonly options:ControllerOptions){this.source=createSourceReader(options.github);}
  request(id:string):SeatRequest|undefined {return this.attached?.requests.find(request=>request.id===id);}
  setMain(caller:Caller):void {
    if(caller.kind!=='main'||caller.depth!==0||caller.runId!==this.runId)throw new Error('Controller Main must be the actual bound root session');
    if(this.main&&this.main.sessionId!==caller.sessionId&&this.attached)throw new Error('An attached agenda cannot transfer to another Main session without explicit resume');
    this.main=caller;
  }
  private serial<T>(work:()=>Promise<T>):Promise<T>{const result=this.tail.then(work);this.tail=result.then(()=>{},()=>{});return result;}
  private async inputs():Promise<Result<Inputs,RuntimeError>> {
    if(!this.main)return {ok:false,error:{kind:'host',error:unavailable('Main native session is not bound')}};
    const policy=await this.options.policy();if(!policy.ok)return {ok:false,error:{kind:'policy',error:policy.error}};
    this.policy=policy.value;
    const host=this.options.host.observe(this.runId,this.main);if(!host.ok)return {ok:false,error:{kind:'host',error:host.error}};
    return {ok:true,value:{facts:this.facts,host:host.value,policy:policy.value}};
  }
  /** Visibility is a read-only projection; it never queues writes or network I/O. */
  visible(caller:Caller):boolean {
    if(this.closed||!this.main||caller.runId!==this.runId)return false;
    if(caller.kind==='main')return caller.agentId===this.main.agentId&&caller.sessionId===this.main.sessionId;
    if(!this.attached||!this.policy)return false;
    const observed=this.options.host.observe(this.runId,this.main);if(!observed.ok)return false;
    const input:Inputs={facts:this.facts,host:observed.value,policy:this.policy};
    return this.attached.requests.some(request=>callerOwns(request,input,caller));
  }
  /**
   * The only entry point left for a coordinator: the process was launched for
   * one issue, so its first turn reports the saved agendas that already exist
   * and nothing can switch the process back out of the role.
   */
  async startup(caller:Caller):Promise<Result<StartupView,RuntimeError>> {
    if(!this.main||caller.kind!=='main'||caller.depth!==0||caller.agentId!==this.main.agentId||caller.sessionId!==this.main.sessionId||caller.runId!==this.runId)return domain('unauthorized','Only the actual bound Main can start as the Roundtable coordinator');
    const list=await this.options.files.list();if(!list.ok)return {ok:false,error:{kind:'storage',error:list.error}};
    const active=list.value.filter(state=>state.lifecycle==='active');
    if(active.length>1)return domain('ownershipConflict',`Multiple active saved agendas: ${active.map(state=>state.id).join(', ')}`);
    return {ok:true,value:{active:active.map(state=>state.id)}};
  }
  private adopt(write:PendingWrite):void {
    this.attached=write.state.lifecycle==='active'?write.state:null;
    if(write.selection)this.selected.set(write.selection.sessionId,write.selection.agendaId);
    if(this.attached)this.startTimer();else this.stopTimer();
    this.options.onChange();
  }
  private async flush():Promise<CommitResult> {
    const write=this.pending;if(!write)return {ok:true,value:null};
    const result=await this.options.files.save(write.expectedVersion,write.state);
    if(!result.ok)return {ok:false,error:{kind:'storage',error:result.error}};
    this.pending=null;this.adopt(write);return {ok:true,value:write.reply};
  }
  private async save(state:Agenda,expectedVersion:number|null,reply:ReplyResult|null,operation:PortInput|null=null,selection:Selection|null=null):Promise<CommitResult> {
    if(this.pending)throw new Error('A fixed durability target must be resolved before another transition');
    this.pending={state,expectedVersion,reply,operation,selection};return this.flush();
  }
  private async apply(event:Event,input:Inputs,operation:PortInput|null=null,selection:Selection|null=null):Promise<CommitResult> {
    const state=this.attached;if(!state)return domain('roundtableInactive','No agenda is attached to this run');
    const next=transition(state,input,event);
    switch(next.kind){
      case 'rejected':return {ok:false,error:{kind:'domain',error:next.error}};
      case 'same':return {ok:true,value:next.reply};
      case 'next':return this.save(next.state,state.version,next.reply,operation,selection);
    }
  }
  private async view(state:Agenda,caller:Caller):Promise<Result<AgendaView,RuntimeError>> {
    const input=await this.inputs();if(!input.ok)return input;
    const snapshot:Inputs=state.id===this.attached?.id?input.value:{...input.value,facts:{kind:'unavailable',error:unavailable('No current source observation exists for this read-only agenda view')}};
    const main=mainCaller(snapshot,caller);
    if(!main&&(!this.attached||state.id!==this.attached.id||!state.requests.some(request=>callerOwns(request,snapshot,caller))))return domain('unauthorized','This caller is not a current agenda seat');
    const own=callerTickets(state,snapshot,caller);
    const relevant=(context:DecisionCase['context'])=>main||own.some(ticket=>canonical(ticket.context)===canonical(context));
    return {ok:true,value:{kind:'agenda',agenda:state.id,version:state.version,lifecycle:state.lifecycle,tickets:own,
      cases:main?state.cases.filter(item=>item.state.kind!=='resolved'&&item.state.kind!=='cancelled'):[],
      effects:state.effects.filter(effect=>effect.state.kind!=='confirmed'&&effect.state.kind!=='cancelled'&&relevant(effect.scope)),
      externalMerges:main?state.units.flatMap(unit=>unit.members.flatMap(member=>member.ownerTerminal?.kind==='externallyMerged'?[member.ownerTerminal]:[])):[],
      report:state.report?.state.kind==='reported'?state.report.state.summary:null,sourceError:snapshot.facts.kind==='unavailable'?snapshot.facts.error:null}};
  }
  private async lookup(caller:Caller,agenda?:string):Promise<Result<Agenda,RuntimeError>> {
    let id=agenda??this.selected.get(caller.sessionId);
    if(!id){
      const list=await this.options.files.list();if(!list.ok)return {ok:false,error:{kind:'storage',error:list.error}};
      const active=list.value.filter(state=>state.lifecycle==='active');if(active.length!==1)return domain('agendaRequired','Select an explicit agenda; there is not exactly one active agenda');
      id=active[0]!.id;
    }
    if(this.attached?.id===id)return {ok:true,value:this.attached};
    const read=await this.options.files.load(id);return read.ok?read:{ok:false,error:{kind:'storage',error:read.error}};
  }
  async tickets(caller:Caller,agenda?:string):Promise<Result<AgendaView,RuntimeError>> {
    if(!this.visible(caller))return domain('roundtableInactive','Roundtable is not available to this session');
    const state=await this.lookup(caller,agenda);if(!state.ok)return state;
    const result=await this.view(state.value,caller);if(result.ok&&agenda!==undefined)this.selected.set(caller.sessionId,agenda);return result;
  }
  async context(caller:Caller):Promise<Result<AgendaView|null,RuntimeError>> {
    if(!this.visible(caller))return {ok:true,value:null};
    const result=await this.lookup(caller);if(!result.ok)return result.error.kind==='domain'&&result.error.error.kind==='agendaRequired'?{ok:true,value:null}:result;
    return this.view(result.value,caller);
  }
  async execute(caller:Caller,operation:PortInput,cwd:string):Promise<OperationResult> {
    if(operation.op==='tickets')return this.tickets(caller,operation.agenda);
    return this.serial(async()=>{
      if(!this.visible(caller))return domain('roundtableInactive','This session is not the coordinator Main or one of its current seats');
      if(caller.kind!=='main'&&operation.op!=='reply')return domain('unauthorized','Seats may only query tickets and reply to their own work');
      const pending=this.pending;
      const flushed=await this.flush();if(!flushed.ok)return flushed;
      if(operation.op!=='reply'&&pending?.operation&&canonical(pending.operation)===canonical(operation)){
        if(sourceDependent(operation)||operation.op==='convene'||operation.op==='resume')this.kick();
        return {ok:true,value:{kind:'accepted',agenda:pending.state.id,version:pending.state.version,reply:pending.reply}};
      }
      let input=await this.inputs();if(!input.ok)return input;
      if(operation.op==='convene')return this.convene(caller,operation,cwd);
      if(operation.op==='resume')return this.resume(caller,operation,cwd);
      const ticketAgenda=operation.op==='reply'?operation.ticket.match(/^(?:work|gate|case|spawn):([^/]+)\//)?.[1]:undefined;
      const state=await this.lookup(caller,ticketAgenda);if(!state.ok)return state;
      if(operation.op==='reply'){
        const event:Extract<Event,{kind:'reply'}>={kind:'reply',caller,ticket:operation.ticket,revision:operation.revision,payload:operation.reply,acceptedAt:Date.now()};
        const replay=replyReplay(state.value,input.value,event);if(!replay.ok)return {ok:false,error:{kind:'domain',error:replay.error}};
        if(replay.value!==null)return {ok:true,value:{kind:'accepted',agenda:state.value.id,version:state.value.version,reply:replay.value}};
      }
      if(!this.attached||this.attached.id!==state.value.id||this.attached.run.kind!=='attached'||this.attached.run.id!==this.runId)return domain('ownershipBlocked','Explicitly resume the saved agenda before submitting new replies');
      if(sourceDependent(operation)){
        this.facts=await this.source.read(this.attached,operation,'reply');
        if(this.facts.kind==='unavailable')return {ok:false,error:{kind:'source',error:this.facts.error}};
        input=await this.inputs();if(!input.ok)return input;
      }
      const event:Event=operation.op==='noCode'?{kind:'mainNoCode',caller,member:operation.member,bodyHash:operation.bodyHash,reason:operation.reason,acceptedAt:Date.now()}:{kind:'reply',caller,ticket:operation.ticket,revision:operation.revision,payload:operation.reply,acceptedAt:Date.now()};
      const accepted=await this.apply(event,input.value,operation);if(!accepted.ok)return accepted;
      const version=accepted.value?.acceptedVersion??this.attached?.version??state.value.version+1;
      // The ready intent and receipt are durable. Do not perform any further
      // reads or transitions before returning the exact accepted result.
      this.kick(sourceDependent(operation)?'event':'registry');
      return {ok:true,value:{kind:'accepted',agenda:state.value.id,version,reply:accepted.value}};
    });
  }
  private async preflight(cwd:string):Promise<Result<Inputs,RuntimeError>> {
    const input=await this.inputs();if(!input.ok)return input;
    const validated=await this.options.host.validate(cwd,[input.value.policy.ownerAgent,input.value.policy.gateAgent]);if(!validated.ok)return {ok:false,error:{kind:'host',error:validated.error}};
    return this.inputs();
  }
  private async convene(caller:Caller,operation:ConveneInput,cwd:string):Promise<OperationResult> {
    if(this.attached)return domain('ownershipConflict','This run already owns an active agenda');
    const list=await this.options.files.list();if(!list.ok)return {ok:false,error:{kind:'storage',error:list.error}};
    if(list.value.some(state=>state.lifecycle==='active'))return domain('ownershipBlocked','A saved active agenda requires explicit resume');
    const input=await this.preflight(cwd);if(!input.ok)return input;
    if(!mainCaller(input.value,caller))return domain('unauthorized','Only Main may convene');
    const facts=await this.source.read(null,operation,'convene');if(facts.kind==='unavailable')return {ok:false,error:{kind:'source',error:facts.error}};
    const created=createAgenda(operation,facts.facts,Date.now(),randomUUID());if(!created.ok)return {ok:false,error:{kind:'domain',error:created.error}};
    if(operation.mode==='plan')return {ok:true,value:{kind:'plan',input:operation}};
    this.facts=facts;
    const committed=await this.save(created.value,null,null,operation,{sessionId:caller.sessionId,agendaId:created.value.id});if(!committed.ok)return committed;
    this.kick();return this.view(created.value,caller);
  }
  private async resume(caller:Caller,operation:Extract<PortInput,{op:'resume'}>,cwd:string):Promise<OperationResult> {
    if(this.attached&&this.attached.id!==operation.agenda)return domain('ownershipConflict','Another agenda is already attached');
    const list=await this.options.files.list();if(!list.ok)return {ok:false,error:{kind:'storage',error:list.error}};
    const active=list.value.filter(state=>state.lifecycle==='active');
    if(active.length>1)return domain('ownershipConflict','Multiple saved active agendas require ownership resolution');
    const state=await this.options.files.load(operation.agenda);if(!state.ok)return {ok:false,error:{kind:'storage',error:state.error}};
    if(state.value.lifecycle==='completed'){this.selected.set(caller.sessionId,state.value.id);return this.view(state.value,caller);}
    const checked=await this.preflight(cwd);if(!checked.ok)return checked;
    if(!mainCaller(checked.value,caller))return domain('unauthorized','Only Main may resume');
    this.facts=await this.source.read(state.value,operation,'resume');if(this.facts.kind==='unavailable')return {ok:false,error:{kind:'source',error:this.facts.error}};
    const input=await this.inputs();if(!input.ok)return input;
    const next=transition(state.value,input.value,{kind:'resume',runId:this.runId,operatorConfirmedOriginalSessionEnded:operation.operatorConfirmedOriginalSessionEnded});
    if(next.kind==='rejected')return {ok:false,error:{kind:'domain',error:next.error}};
    if(next.kind==='next'){
      const saved=await this.save(next.state,state.value.version,next.reply,operation,{sessionId:caller.sessionId,agendaId:state.value.id});if(!saved.ok)return saved;
    }else {this.attached=state.value;this.selected.set(caller.sessionId,state.value.id);this.startTimer();}
    this.kick();return this.view(this.attached??state.value,caller);
  }
  private startTimer():void {
    if(this.timer||this.closed)return;
    this.timer=setInterval(()=>{this.run('timer').catch(error=>this.unexpected(error));},this.options.intervalSeconds*1000);this.timer.unref();
  }
  private stopTimer():void {clearInterval(this.timer??undefined);this.timer=null;}
  private kick(cause:'event'|'registry'='event'):void {
    if(this.closed||!this.attached&&!this.pending)return;
    if(this.scheduled){if(cause==='event')this.scheduled.cause='event';return;}
    const queued={cause,handle:setTimeout(()=>{this.scheduled=null;this.run(queued.cause).catch(error=>this.unexpected(error));},0)};
    this.scheduled=queued;queued.handle.unref();
  }
  registryChanged():void {
    this.options.onChange();
    this.kick('registry');
  }
  noteTurnEnd(caller:Caller):void {
    if(!this.attached)return;
    for(const effect of this.attached.effects){
      if(effect.action.kind!=='wake'||effect.action.holder!==caller.agentId)continue;
      if(effect.state.kind==='executing')this.options.host.noteTurnEnd(caller.agentId,this.runId,`${effect.id}:${effect.attempt}`);
      if(effect.state.kind==='confirmed'&&effect.state.result.kind==='delivered')this.options.host.noteTurnEnd(caller.agentId,this.runId,effect.state.result.messageId);
    }
    this.options.onChange();
    this.kick('registry');
  }
  private unexpected(error:unknown):void {this.options.onError({kind:'host',error:unavailable(error instanceof Error?error.message:'Unexpected controller failure')});}
  async run(cause:'timer'|'event'|'registry'):Promise<void> {
    await this.serial(async()=>{
      if(this.closed)return;
      const flushed=await this.flush();if(!flushed.ok){this.options.onError(flushed.error);return;}
      if(!this.attached)return;
      const host=await this.inputs();if(!host.ok){this.options.onError(host.error);return;}
      const reconciled=await this.apply({kind:'hostObserved'},host.value);if(!reconciled.ok){this.options.onError(reconciled.error);return;}
      if(cause!=='registry'){
        this.facts=await this.source.read(this.attached,null,cause);
        if(this.facts.kind==='unavailable'){this.options.onError({kind:'source',error:this.facts.error});this.options.onChange();return;}
        const observed=await this.settle();if(!observed.ok){this.options.onError(observed.error);return;}
      }
      const input=await this.inputs();if(!input.ok){this.options.onError(input.error);return;}
      const state=this.attached;if(!state)return;
      const actionable=(effect:Effect):boolean=>{
        if(cause==='registry'&&effect.action.kind!=='wake')return false;
        if(effect.state.kind==='ready'||effect.state.kind==='executing')return true;
        if(effect.state.kind!=='uncertain')return false;
        if(satisfiedResult(state,effect,input.value))return true;
        const action=effect.action;
        if(action.kind==='wake')return action.runId!==this.runId||!input.value.host.seats.some(seat=>seat.agentId===action.holder&&seat.status!=='aborted');
        if(action.kind==='merge'&&input.value.facts.kind==='available'){
          const pr=input.value.facts.facts.prs.find(pr=>sameRef(pr.ref,action.pr));
          return !!pr&&(pr.state.kind==='closed'||pr.state.kind==='merged'&&(pr.head!==action.head||canonical(pr.target)!==canonical(action.target)));
        }
        if(action.kind==='setIssueState'&&input.value.facts.kind==='available'){
          const issue=input.value.facts.facts.issues.find(issue=>sameRef(issue.ref,action.issue));
          return issue!==undefined&&!issueStateBaselineMatches(action,issue);
        }
        return false;
      };
      const effect=state.effects.find(effect=>effect.state.kind==='executing'&&actionable(effect))
        ??state.effects.find(effect=>effect.state.kind==='ready'&&actionable(effect))
        ??state.effects.find(effect=>effect.state.kind==='uncertain'&&actionable(effect));
      if(!effect)return;
      const result=await this.drive(effect);if(!result.ok){this.options.onError(result.error);return;}
      if(cause!=='registry'&&this.facts.kind==='available'){const settled=await this.settle();if(!settled.ok){this.options.onError(settled.error);return;}}
      if(this.attached?.effects.some(item=>(item.state.kind==='ready'||item.state.kind==='executing')&&(cause!=='registry'||item.action.kind==='wake')))this.kick(cause==='registry'?'registry':'event');
    });
  }
  private async settle():Promise<CommitResult> {
    const signatures=new Set<string>();
    while(this.attached){
      const input=await this.inputs();if(!input.ok)return input;
      const state=this.attached;
      const signature=digest({...state,version:0});if(signatures.has(signature))throw new Error('Non-convergent deterministic observe transition');signatures.add(signature);
      const next=transition(state,input.value,{kind:'observe'});
      if(next.kind==='rejected')return {ok:false,error:{kind:'domain',error:next.error}};
      if(next.kind==='same')return {ok:true,value:null};
      const saved=await this.save(next.state,state.version,next.reply);if(!saved.ok)return saved;
    }
    return {ok:true,value:null};
  }
  private async call(effect:Effect):Promise<Result<CallResult,PortError>> {
    const action=effect.action;const github=this.options.github;
    switch(action.kind){
      case 'publishPr':{
        const input={headRepo:action.headRepo,branch:action.submission.payload.branch,head:action.submission.payload.head,target:action.target,title:action.submission.payload.title,body:action.body};
        if(action.pr){const result=await github.editPr(action.pr,input);return result.ok?{ok:true,value:{kind:'receipt',receipt:{effectId:effect.id,result:{kind:'pr',pr:action.pr}}}}:result;}
        const result=await github.createPr(input);return result.ok?{ok:true,value:{kind:'receipt',receipt:{effectId:effect.id,result:{kind:'pr',pr:result.value}}}}:result;
      }
      case 'createIssue':{const result=await github.createIssue(action.spec);return result.ok?{ok:true,value:{kind:'receipt',receipt:{effectId:effect.id,result:{kind:'issue',issue:result.value}}}}:result;}
      case 'attachChild':{const result=await github.addSubIssue(action.parent,action.child);return result.ok?{ok:true,value:{kind:'query'}}:result;}
      case 'replaceBody':{const result=await github.editIssueBody(action.edit.issue,action.edit.expectedHash,action.edit.body);return result.ok?{ok:true,value:{kind:'query'}}:result;}
      case 'setIssueState':{const result=await github.setIssueOpen(action.issue,action.open);return result.ok?{ok:true,value:{kind:'query'}}:result;}
      case 'rerunChecks':{const result=await github.rerunCheck(action.repo,action.workflowRunId);return result.ok?{ok:true,value:{kind:'query'}}:result;}
      case 'merge':{const result=await github.mergePr(action.pr,action.head);return result.ok?{ok:true,value:{kind:'query'}}:result;}
      case 'wake':{
        if(effect.state.kind!=='executing'||!this.main)return {ok:false,error:{kind:'precondition',message:'Wake requires durable executing provenance and a bound Main'}};
        const result=await this.options.host.wake({requestId:action.requestId,runId:action.runId,agentId:action.holder,parentId:this.main.agentId,messageId:`${effect.id}:${effect.attempt}`,body:action.body,startedAt:effect.state.startedAt});
        return result.ok?{ok:true,value:{kind:'delivery',result:{kind:'delivered',...result.value}}}:result;
      }
    }
  }
  private async drive(previous:Effect):Promise<CommitResult> {
    if(!this.attached)return domain('roundtableInactive','Agenda finished before effect dispatch');
    if(previous.action.kind!=='wake'){
      this.facts=await this.source.read(this.attached,null,'effectPreflight');
      if(this.facts.kind==='unavailable')return {ok:false,error:{kind:'source',error:this.facts.error}};
    }
    let input=await this.inputs();if(!input.ok)return input;
    let effect=this.attached.effects.find(item=>item.id===previous.id);if(!effect)return {ok:true,value:null};
    const satisfied=satisfiedResult(this.attached,effect,input.value);
    if(satisfied&&effect.state.kind!=='executing')return this.apply({kind:'effectSatisfied',id:effect.id,result:satisfied},input.value);
    if(effect.state.kind==='executing'){
      if(satisfied)return this.apply({kind:'effectConfirmed',id:effect.id,attempt:effect.attempt,result:satisfied},input.value);
      return this.apply({kind:'effectFailed',id:effect.id,attempt:effect.attempt,outcome:'uncertain',error:{kind:'uncertainOutcome',message:'Recovered executing intent has no source-confirmed result; no mutation was retried'}},input.value);
    }
    if(effect.state.kind==='uncertain'){
      const action=effect.action;
      if(action.kind==='wake'&&(action.runId!==this.runId||!input.value.host.seats.some(seat=>seat.agentId===action.holder&&seat.status!=='aborted')))return this.apply({kind:'effectCancelled',id:effect.id,reason:'holderAbsent'},input.value);
      if(action.kind==='merge'){
        const pr=input.value.facts.kind==='available'?input.value.facts.facts.prs.find(pr=>sameRef(pr.ref,action.pr)):undefined;
        if(pr&&(pr.state.kind==='closed'||pr.state.kind==='merged'&&(pr.head!==action.head||canonical(pr.target)!==canonical(action.target))))return this.apply({kind:'effectCancelled',id:effect.id,reason:'targetBecameInapplicable'},input.value);
      }
      if(action.kind==='setIssueState'){
        const issue=input.value.facts.kind==='available'?input.value.facts.facts.issues.find(issue=>sameRef(issue.ref,action.issue)):undefined;
        if(issue&&!issueStateBaselineMatches(action,issue))return this.apply({kind:'effectCancelled',id:effect.id,reason:'targetBecameInapplicable'},input.value);
      }
      return {ok:true,value:null};
    }
    if(effect.state.kind!=='ready')return {ok:true,value:null};
    const preflight=effectPrecondition(this.attached,effect,input.value);
    if(!preflight.ok){
      const action=effect.action;const facts=input.value.facts.kind==='available'?input.value.facts.facts:null;
      const conflict=action.kind==='replaceBody'&&facts?.issues.some(issue=>sameRef(issue.ref,action.edit.issue)&&issue.bodyHash!==action.edit.expectedHash&&issue.body!==action.edit.body)||action.kind==='publishPr'&&action.pr!==null&&facts?.prs.some(pr=>sameRef(pr.ref,action.pr!)&&pr.bodyHash!==action.expectedBodyHash&&pr.body!==action.body);
      if(conflict)return this.apply({kind:'effectFailed',id:effect.id,attempt:effect.attempt,outcome:'knownFailed',error:{kind:'precondition',message:preflight.error.message}},input.value);
      const absent=action.kind==='wake'&&(action.runId!==input.value.host.runId||!input.value.host.seats.some(seat=>seat.agentId===action.holder&&seat.status!=='aborted'));
      return this.apply({kind:'effectCancelled',id:effect.id,reason:absent?'holderAbsent':action.kind==='wake'?'superseded':'preconditionChanged'},input.value);
    }
    const started=await this.apply({kind:'effectStarted',id:effect.id,attempt:effect.attempt+1,startedAt:Date.now()},input.value);if(!started.ok)return started;
    effect=this.attached?.effects.find(item=>item.id===previous.id);if(!effect||effect.state.kind!=='executing')throw new Error('Durable executing effect disappeared before its single call');
    const result=await this.call(effect);
    if(result.ok&&result.value.kind==='delivery'){
      return this.apply({kind:'effectConfirmed',id:effect.id,attempt:effect.attempt,result:result.value.result},input.value);
    }
    const receipt=result.ok&&result.value.kind==='receipt'?result.value.receipt:undefined;
    this.facts=await this.source.read(this.attached,null,'effectConfirm',receipt);
    input=await this.inputs();if(!input.ok)return input;
    let confirmation=satisfiedResult(this.attached!,effect,input.value);
    if(receipt?.result.kind==='pr'&&confirmation?.kind==='published'&&!sameRef(receipt.result.pr,confirmation.pr))confirmation=null;
    if(receipt?.result.kind==='issue')confirmation={kind:'created',issue:receipt.result.issue};
    if(confirmation&&this.facts.kind==='available'){
      const confirmed=await this.apply({kind:'effectConfirmed',id:effect.id,attempt:effect.attempt,result:confirmation},input.value);
      if(confirmed.ok)return confirmed;
      if(confirmed.error.kind!=='domain')return confirmed;
    }
    const error:PortError=!result.ok?result.error:this.facts.kind==='unavailable'?this.facts.error:{kind:'uncertainOutcome',message:'Source has not confirmed the exact action result; no mutation will be retried automatically'};
    const outcome=!result.ok&&(error.kind==='permission'||error.kind==='precondition'||error.kind==='rateLimited')?'knownFailed':'uncertain';
    const event:Event={kind:'effectFailed',id:effect.id,attempt:effect.attempt,error,outcome,...(receipt?{received:receipt.result}:{})};
    return this.apply(event,input.value);
  }
  shutdown():void {this.closed=true;this.stopTimer();clearTimeout(this.scheduled?.handle);this.scheduled=null;this.options.host.dispose();}
}
