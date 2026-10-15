import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createAgenda, tickets, transition} from '../src/domain/index.ts';
import type {
  Agenda, Caller, CaseDecision, CheckFailure, DecisionCase, Event, Facts,
  GateJob, HostSeat, Inputs, IssueRef, IssueSnapshot, Member, PrSnapshot,
  ProtocolReply, ReplyResult, RequiredCheckIdentity, Ticket, TicketId, Transition, Unit,
} from '../src/domain/index.ts';

// This consumer owns its source/registry observations. Agenda objects are only
// constructed by createAgenda and changed by public transition results.
const REPO = {owner:'OccurrenceAudit',name:'recurring-obligations'};
const ISSUE:IssueRef = {repo:REPO,number:41};
const PR:IssueRef = {repo:REPO,number:73};
const HEAD = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
const BASE = 'e'.repeat(40);
const H0 = 'The original source contract: preserve the requested behavior.';
const H1 = 'The revised source contract: also preserve the independent constraint.';
const H2 = 'A later source contract changed before Main could answer.';
const MAIN:Caller = {agentId:'occurrence-main',sessionId:'occurrence-main-session',parentId:null,runId:'occurrence-run',kind:'main',depth:0};
const digest = (body:string):string => createHash('sha256').update(body).digest('hex');
type SourceMode = 'pending'|'merged'|'actions'|'status';
type ReplyEvent = Extract<Event,{kind:'reply'}>;
type Accepted = {event:ReplyEvent;result:ReplyResult};

function failedCheck(kind:'actions'|'status'):CheckFailure {
  const identity:RequiredCheckIdentity = {name:'required-behavior',source:{kind:'app',id:901}};
  if(kind==='actions')return {kind,identity,checkRunId:701,workflowRunId:702,jobId:703,runAttempt:1,head:HEAD};
  return {kind,identity,context:'required-behavior',sha:HEAD};
}

class Recurrence {
  state:Agenda;
  readonly facts:Facts;
  readonly issue:IssueSnapshot;
  readonly pr:PrSnapshot;
  readonly seats:HostSeat[] = [];
  private time = 100;

  constructor(mode:SourceMode) {
    this.issue = {ref:ISSUE,body:H0,bodyHash:digest(H0),updatedAt:1,state:mode==='merged'?'closed':'open',lastClose:mode==='merged'?{id:'source-close-41',at:5}:null,lastReopen:null,children:[]};
    const prBody = `Deliver the independently checked behavior.\n\nCloses ${REPO.owner}/${REPO.name}#${ISSUE.number}`;
    this.pr = {ref:PR,headRepo:REPO,headBranch:'occurrence-owner',head:HEAD,target:{repo:REPO,base:'main'},title:'Preserve recurring obligations',body:prBody,bodyHash:digest(prBody),updatedAt:1,state:mode==='merged'?{kind:'merged',sha:MERGE,at:5}:{kind:'open'},closes:[ISSUE],mergeable:'yes',checks:mode==='actions'||mode==='status'?{kind:'failing',required:[failedCheck(mode)]}:{kind:'passing',required:[]}};
    this.facts = {
      viewer:REPO.owner,issues:[this.issue],prs:mode==='pending'?[]:[this.pr],
      links:mode==='pending'?[]:[{issue:ISSUE,pr:PR}],
      repos:[{repo:REPO,defaultBranch:'main',defaultHead:mode==='merged'?MERGE:BASE,bases:[{name:'main',state:{kind:'present',head:mode==='merged'?MERGE:BASE,isDefault:true,rules:{required:mode==='actions'||mode==='status'?[failedCheck(mode).identity]:[],strict:false,upToDate:true,constraints:[]}}}]}],
      branches:[{repo:REPO,name:'occurrence-owner',state:{kind:'present',head:HEAD}}],
      maintenance:mode==='pending'?[]:[{pr:PR,result:{kind:'maintainable',basis:{headRepo:REPO,headBranch:'occurrence-owner',viewerPermission:'WRITE',author:'source-author',maintainerCanModify:true,authorization:{kind:'authorAuthorized',evidence:'Author explicitly authorized maintenance of this exact PR.'}}}}],
      commits:mode==='merged'?[{repo:REPO,ancestor:MERGE,descendant:MERGE,result:'contains'}]:[],
      checkAttempts:mode==='actions'?[{repo:REPO,workflowRunId:702,attempt:1,head:HEAD}]:[],createdIssues:[],
    };
    const made = createAgenda({op:'convene',mode:'execute',parent:null,entries:[{issue:ISSUE,target:{repo:REPO,base:'main'},designOnly:false,adoptPr:mode==='actions'||mode==='status'?PR:null}]},this.facts,10,'34123412-3412-4412-8412-341234123412');
    if(!made.ok)throw new Error(`Independent source fixture rejected: ${JSON.stringify(made.error)}`);
    this.state = made.value;
  }

  get input():Inputs {
    return {
      facts:{kind:'available',generation:1,observedAt:this.time,scope:{issues:[ISSUE],prs:this.facts.prs.map(pr=>pr.ref),repos:[{repo:REPO,bases:['main']}],branches:[{repo:REPO,name:'occurrence-owner'}],commits:this.facts.commits.map(pair=>({repo:pair.repo,ancestor:pair.ancestor,descendant:pair.descendant})),checkRuns:this.facts.checkAttempts.map(run=>({repo:run.repo,runId:run.workflowRunId})),creations:[]},facts:this.facts},
      host:{runId:MAIN.runId,main:MAIN,seats:this.seats,turnEnds:[],preflight:{ok:true,value:{asyncEnabled:true,isolationEnabled:true,asyncManager:true,gitCwd:'/tmp/recurring-obligations',agents:[{name:'task:free',blocking:false}]}}},
      policy:{text:'Keep each source occurrence and accepted repair obligation distinct.',ownerAgent:'task:free',gateAgent:'task:free'},
    };
  }
  get unit():Unit {const unit=this.state.units[0];if(!unit)throw new Error('Missing public unit');return unit;}
  get member():Member {const member=this.unit.members[0];if(!member)throw new Error('Missing public member');return member;}
  project():readonly Ticket[] {return tickets(this.state,this.input);}
  ticket(id:TicketId):Ticket {
    const found=this.project().find(ticket=>ticket.id===id);
    if(!found)throw new Error(`Missing actionable ticket ${id}: ${this.diagnostic()}`);
    return found;
  }
  diagnostic():string {return JSON.stringify({version:this.state.version,member:this.member,cases:this.state.cases,tickets:this.project().map(ticket=>({id:ticket.id,revision:ticket.revision,runDisposition:ticket.runDisposition}))});}
  invoke(event:Event):Transition {const result=transition(this.state,this.input,event);if(result.kind==='next')this.state=result.state;return result;}
  accept(event:Event):Transition {
    const result=this.invoke(event);
    if(result.kind==='rejected')throw new Error(`Public event rejected: ${JSON.stringify({event,error:result.error})}\n${this.diagnostic()}`);
    return result;
  }
  observe():void {this.accept({kind:'observe'});}
  stable():void {
    const state=this.state;
    const before=JSON.stringify(state);
    for(let observation=0;observation<3;observation++) {
      this.time++;
      expect(this.invoke({kind:'observe'}),this.diagnostic()).toEqual({kind:'same',reply:null});
      expect(this.state).toBe(state);
      expect(JSON.stringify(this.state)).toBe(before);
    }
  }
  body(body:string):void {this.issue.body=body;this.issue.bodyHash=digest(body);this.issue.updatedAt=this.time++;}
  currentCase(kind:DecisionCase['subject']['kind']):DecisionCase {
    const current=this.state.cases.filter(item=>item.subject.kind===kind&&item.state.kind==='open');
    expect(current.length,`Exactly one current actionable ${kind}: ${this.diagnostic()}`).toBe(1);
    const item=current[0];if(!item)throw new Error(`No current ${kind}`);
    const ticket=this.ticket(`case:${item.id}`);
    expect(ticket.holder.kind).toBe('main');
    expect(ticket.revision).toBe(item.contentVersion);
    expect(ticket.runDisposition).toBe('mustRun');
    return item;
  }
  event(ticket:Ticket,payload:ProtocolReply,caller:Caller=MAIN):ReplyEvent {return {kind:'reply',caller,ticket:ticket.id,revision:ticket.revision,payload,acceptedAt:this.time++};}
  acceptedReply(event:ReplyEvent):Accepted {
    const result=this.accept(event);
    if(result.kind==='rejected'||!result.reply)throw new Error('Expected an accepted public reply receipt');
    expect(result.reply.outcome).toBe('accepted');
    return {event,result:result.reply};
  }
  decide(item:DecisionCase,decision:CaseDecision):Accepted {return this.acceptedReply(this.event(this.ticket(`case:${item.id}`),{kind:'decision',decision}));}
  replay(accepted:Accepted):void {
    const state=this.state;
    const before=JSON.stringify(state);
    expect(this.invoke(accepted.event),this.diagnostic()).toEqual({kind:'same',reply:accepted.result});
    expect(this.state).toBe(state);
    expect(JSON.stringify(this.state)).toBe(before);
  }
  owner():Caller {
    const id=this.member.ownerRequestId;
    const request=this.state.requests.find(request=>request.id===id);
    if(!request)throw new Error(`Missing public owner request: ${this.diagnostic()}`);
    let seat=this.seats.find(seat=>seat.requestedName===request.name);
    if(!seat) {
      seat={agentId:'occurrence-owner-seat',requestedName:request.name,parentId:MAIN.agentId,sessionId:'occurrence-owner-session',createdAt:this.time++,status:'running',plan:'disabled',streaming:false};
      this.seats.push(seat);
      this.acceptedReply(this.event(this.ticket(`spawn:${request.id}`),{kind:'spawned',agentId:seat.agentId}));
    }
    if(!seat.sessionId)throw new Error('Independent owner observation requires a real session identity');
    return {agentId:seat.agentId,sessionId:seat.sessionId,parentId:MAIN.agentId,runId:MAIN.runId,kind:'sub',depth:1};
  }
  repair():Accepted {
    const caller=this.owner();
    const work=this.member.work;if(!work)throw new Error(`Missing repair work: ${this.diagnostic()}`);
    const ticket=this.ticket(`work:${work.id}`);
    expect(ticket.runDisposition).toBe('mustRun');
    return this.acceptedReply(this.event(ticket,{kind:'submit',branch:this.pr.headBranch,head:HEAD,title:this.pr.title,body:this.pr.body,template:'fourLayer',retryNote:'Evidence repaired at the same remote HEAD; the required source check remains independently observable.'},caller));
  }
  confirmPublication():void {
    const ready=this.state.effects.filter(effect=>effect.action.kind==='publishPr'&&effect.state.kind==='ready');
    expect(ready.length,this.diagnostic()).toBe(1);
    const effect=ready[0];if(!effect||effect.action.kind!=='publishPr')throw new Error('No current publish intention');
    // The external source reports the exact requested publication. No Agenda
    // binding or effect state is manufactured by this fixture.
    this.pr.title=effect.action.submission.payload.title;
    this.pr.body=effect.action.body;
    this.pr.bodyHash=digest(this.pr.body);
    this.pr.updatedAt=this.time++;
    this.accept({kind:'effectSatisfied',id:effect.id,result:{kind:'published',pr:PR}});
    this.observe();
  }
  postMerge():GateJob {
    const job=this.unit.postMerge;
    if(!job)throw new Error(`Missing fresh postMerge obligation: ${this.diagnostic()}`);
    expect(job.kind).toBe('postMerge');
    expect(job.status.kind).toBe('requested');
    expect(this.ticket(`gate:${job.id}`).runDisposition).toBe('mustRun');
    return job;
  }
}

function expectRejectedUnchanged(c:Recurrence,event:ReplyEvent,kind:'premiseChanged'|'staleRevision'):void {
  const state=c.state;
  const result=c.invoke(event);
  expect(result.kind,c.diagnostic()).toBe('rejected');
  if(result.kind!=='rejected')throw new Error(`Expected ${kind}`);
  expect(result.error.kind).toBe(kind);
  expect(c.state).toBe(state);
}

describe('independent recurring source and accepted-repair obligations',()=>{
  test('pending h0→h1→h0→h1 creates current decisions while preserving the same OwnerWork',()=>{
    const c=new Recurrence('pending');c.observe();c.stable();
    const work=c.member.work;if(!work)throw new Error('Initial public source must create work');
    const receipts:Accepted[]=[];
    const occurrences:string[]=[];
    for(const body of [H1,H0,H1]) {
      c.body(body);c.observe();
      const item=c.currentCase('unexpectedSourceChange');
      expect(occurrences).not.toContain(`${item.id}:${item.contentVersion}`);
      occurrences.push(`${item.id}:${item.contentVersion}`);
      expect(item.bodyBaselines).toContainEqual({issue:ISSUE,hash:digest(body)});
      expect(c.member.work?.id).toBe(work.id);
      expect(c.ticket(`work:${work.id}`).runDisposition).toBe('mayWait');
      c.stable();
      for(const receipt of receipts)c.replay(receipt);
      const accepted=c.decide(item,{kind:'keepWork',basis:'Accept this current source contract and preserve the existing implementation obligation.'});
      receipts.push(accepted);
      expect(c.member.contract.bodyHash).toBe(digest(body));
      expect(c.member.work?.id).toBe(work.id);
      expect(c.ticket(`work:${work.id}`).runDisposition).toBe('mustRun');
      c.observe();c.stable();
      for(const receipt of receipts)c.replay(receipt);
    }
    expect(occurrences.length).toBe(3);
  });

  test('merged h0→h1→h0→h1 produces fresh postMerge obligations, never an old OwnerWork',()=>{
    const c=new Recurrence('merged');c.observe();
    expect(c.member.terminal.kind).toBe('merged');
    expect(c.member.work).toBeNull();
    let previous=c.postMerge();c.stable();
    const receipts:Accepted[]=[];
    const occurrences:string[]=[];
    for(const body of [H1,H0,H1]) {
      c.body(body);c.observe();
      const item=c.currentCase('unexpectedSourceChange');
      expect(occurrences).not.toContain(`${item.id}:${item.contentVersion}`);
      occurrences.push(`${item.id}:${item.contentVersion}`);
      expect(c.member.work).toBeNull();
      c.stable();
      for(const receipt of receipts)c.replay(receipt);
      receipts.push(c.decide(item,{kind:'keepWork',basis:'Retain the actual merge and verify it against this current source contract.'}));
      expect(c.member.contract.bodyHash).toBe(digest(body));
      expect(c.member.terminal.kind).toBe('merged');
      expect(c.member.work).toBeNull();
      c.observe();
      const fresh=c.postMerge();
      expect(fresh.id).not.toBe(previous.id);
      if(fresh.stamp.kind!=='postMerge')throw new Error('Public postMerge job must retain its typed scope');
      expect(fresh.stamp.members.some(item=>item.member.bodyHash===digest(body))).toBe(true);
      previous=fresh;c.stable();
      for(const receipt of receipts)c.replay(receipt);
      expect(c.project().some(ticket=>ticket.id.startsWith('work:'))).toBe(false);
    }
  });

  const checkKinds:readonly ('actions'|'status')[] = ['actions','status'];
  for(const kind of checkKinds) {
    test(`${kind}: first accepted repair→Main fix→second accepted same-HEAD repair needs a new checks decision`,()=>{
      const c=new Recurrence(kind);c.observe();
      const failure=c.pr.checks;
      const firstWork=c.member.work;if(!firstWork)throw new Error('First required-check failure must open owner repair');
      const first=c.repair();
      expect(c.member.work).toBeNull();
      c.confirmPublication();
      const firstCase=c.currentCase('checks');c.stable();
      expect(firstCase.subject.kind).toBe('checks');
      if(firstCase.subject.kind!=='checks')throw new Error('Expected check subject');
      if(failure.kind!=='failing')throw new Error('Required source failure fixture lost');
      expect(firstCase.subject.failures).toEqual(failure.required);
      const mainFix=c.decide(firstCase,{kind:'fix',basis:'The source attempt still fails; perform a second real repair and supply new evidence.'});
      const secondWork=c.member.work;if(!secondWork)throw new Error('Main fix must create the next owner obligation');
      expect(secondWork.id).not.toBe(firstWork.id);
      c.replay(mainFix);
      expect(c.member.work?.id).toBe(secondWork.id);
      c.observe();c.stable();
      const second=c.repair();
      expect(second.event.ticket).not.toBe(first.event.ticket);
      expect(c.pr.head).toBe(HEAD);
      expect(c.pr.checks).toEqual(failure);
      expect(c.member.work).toBeNull();
      c.confirmPublication();
      const recurring=c.currentCase('checks');
      expect(recurring.id).not.toBe(firstCase.id);
      expect(recurring.receipt).toBeNull();
      expect(recurring.subject.kind).toBe('checks');
      if(recurring.subject.kind!=='checks')throw new Error('Expected recurring source check subject');
      expect(recurring.subject.failures).toEqual(failure.required);
      c.stable();
      c.replay(mainFix);
      expect(c.currentCase('checks').id).toBe(recurring.id);
      expect(c.member.work).toBeNull();
      c.replay(second);
      expect(c.currentCase('checks').id).toBe(recurring.id);
      expect(c.member.work).toBeNull();
      c.stable();
    });
  }

  test('Main cannot accept a changed source premise before observe or an old unaccepted revision afterward',()=>{
    const c=new Recurrence('pending');c.observe();
    c.body(H1);c.observe();
    const item=c.currentCase('unexpectedSourceChange');
    const old=c.event(c.ticket(`case:${item.id}`),{kind:'decision',decision:{kind:'keepWork',basis:'This answer was prepared against h1, not the later source body.'}});
    c.body(H2);
    expectRejectedUnchanged(c,old,'premiseChanged');
    expect(c.member.contract.bodyHash).toBe(digest(H0));
    c.observe();
    const refreshed=c.state.cases.find(current=>current.id===item.id);
    if(!refreshed)throw new Error('Current source case identity disappeared without an accepted decision');
    expect(refreshed.contentVersion).toBeGreaterThan(item.contentVersion);
    expectRejectedUnchanged(c,old,'staleRevision');
    expect(c.member.contract.bodyHash).toBe(digest(H0));
    expect(c.member.work).not.toBeNull();
    c.stable();
  });
});
