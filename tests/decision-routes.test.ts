import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createAgenda, parseAgenda, parsePortInput, tickets, transition} from '../src/domain/index.ts';
import type {
  Agenda, Caller, CaseDecision, DecisionCase, DesignRoute, DraftSpec, Effect,
  EffectResult, Entry, Event, Facts, GateJob, HostSeat, Inputs, IssueRef,
  IssueSnapshot, Member, PrSnapshot, ProtocolReply, Repo, ShaRef, Ticket, Transition,
} from '../src/domain/index.ts';

// Consumer-owned fixtures: no author fixtures, private helpers, old state machines,
// GitHub operations, model calls, or production modules other than the public index.
const A: Repo = {owner:'RouteAudit', name:'implementation'};
const B: Repo = {owner:'RouteAudit', name:'other'};
const HEAD = '1'.repeat(40);
const DEFAULT = 'a'.repeat(40);
const DESIGN = 'd'.repeat(40);
const MERGE = 'b'.repeat(40);
const ORIGINAL: IssueRef = {repo:A, number:11};
const LATER: IssueRef = {repo:A, number:12};
const THIRD: IssueRef = {repo:A, number:13};
const PARENT: IssueRef = {repo:A, number:10};
const PR: IssueRef = {repo:A, number:101};
const ID = '12345678-1234-4123-8123-123456789abc';
const MAIN: Caller = {agentId:'main',sessionId:'main-session',parentId:null,runId:'audit-run',kind:'main',depth:0};
const hash = (body:string):string => createHash('sha256').update(body).digest('hex');
const same = (left:IssueRef,right:IssueRef):boolean => left.number===right.number && left.repo.owner===right.repo.owner && left.repo.name===right.repo.name;
const issue = (ref:IssueRef, body=`Deliver ${ref.number}`):IssueSnapshot => ({ref,body,bodyHash:hash(body),updatedAt:1,state:'open',lastClose:null,lastReopen:null,children:[]});
const entry = (ref:IssueRef, designOnly=false, base='main', adoptPr:IssueRef|null=null):Entry => ({issue:ref,target:{repo:ref.repo,base},designOnly,adoptPr});
const draft = (repo:Repo=A, designOnly=true):DraftSpec => ({repo,title:'Carry the exact design',body:'Deliver the original design commit without replacing its obligation',target:{repo,base:'main'},designOnly});
const question: ProtocolReply = {kind:'claim',claim:{kind:'question',reproduction:'The specification does not select the design route',readings:['Implement old contract','Implement amended contract'],earliestGap:'Required design clause',proposal:'Main chooses an explicit amendment'}};

function independentFacts(refs:readonly IssueRef[]):Facts {
  return {
    viewer: A.owner,
    issues:refs.map(ref=>issue(ref)),prs:[],links:[],
    repos:[A,B].map(repo=>({repo,defaultBranch:'main',defaultHead:DEFAULT,bases:['main','release'].map(name=>({name,state:{kind:'present',head:DEFAULT,isDefault:name==='main',rules:{required:[],strict:false,upToDate:true,constraints:[]}}}))})),
    branches:[{repo:A,name:'owner-change',state:{kind:'present',head:HEAD}}],
    maintenance:[],commits:[],checkAttempts:[],createdIssues:[],
  };
}
function pull(ref:IssueRef=PR, member:IssueRef=ORIGINAL, base='main'):PrSnapshot {
  const body=`Deliver audited behavior\n\nCloses ${member.repo.owner}/${member.repo.name}#${member.number}`;
  return {ref,headRepo:member.repo,headBranch:'owner-change',head:HEAD,target:{repo:member.repo,base},title:'Deliver audited behavior',body,bodyHash:hash(body),updatedAt:1,state:{kind:'open'},closes:[member],mergeable:'yes',checks:{kind:'passing',required:[]}};
}

class Consumer {
  state:Agenda;
  readonly facts:Facts;
  readonly seats:HostSeat[]=[];
  readonly trace:unknown[]=[];
  time=100;
  constructor(entries:readonly Entry[]=[entry(ORIGINAL)], parent:IssueRef|null=null, source?:Facts) {
    this.facts=source??independentFacts(entries.map(item=>item.issue));
    const result=createAgenda({op:'convene',mode:'execute',parent,entries:[...entries]},this.facts,10,ID);
    if(!result.ok)throw new Error(`convene ${JSON.stringify(result.error)}`);
    this.state=result.value;
  }
  get input():Inputs {
    return {facts:{kind:'available',generation:1,observedAt:this.time,scope:{issues:this.facts.issues.map(item=>item.ref),prs:this.facts.prs.map(item=>item.ref),repos:this.facts.repos.map(item=>({repo:item.repo,bases:item.bases.map(base=>base.name)})),branches:this.facts.branches.map(item=>({repo:item.repo,name:item.name})),commits:this.facts.commits.map(item=>({repo:item.repo,ancestor:item.ancestor,descendant:item.descendant})),checkRuns:[],creations:[]},facts:this.facts},host:{runId:MAIN.runId,main:MAIN,seats:this.seats,turnEnds:[],preflight:{ok:true,value:{asyncEnabled:true,isolationEnabled:true,asyncManager:true,gitCwd:'/tmp/route-audit',agents:[{name:'task:free',blocking:false}]}}},policy:{text:'Independent public consumer audit. Preserve every original obligation.',ownerAgent:'task:free',gateAgent:'task:free'}};
  }
  member(ref:IssueRef=ORIGINAL):Member {
    const member=this.state.units.flatMap(unit=>unit.members).find(item=>same(item.ref,ref));
    if(!member)throw new Error(`Missing member ${JSON.stringify(ref)}`);
    return member;
  }
  source(ref:IssueRef=ORIGINAL):IssueSnapshot {
    const result=this.facts.issues.find(item=>same(item.ref,ref));
    if(!result)throw new Error(`Missing source ${JSON.stringify(ref)}`);
    return result;
  }
  project():readonly Ticket[] { return tickets(this.state,this.input); }
  invoke(event:Event):Transition {
    const result=transition(this.state,this.input,event);
    this.trace.push({event,result:result.kind==='rejected'?result.error:{kind:result.kind,reply:result.reply}});
    if(result.kind==='next')this.state=result.state;
    return result;
  }
  accept(event:Event):Transition {
    const result=this.invoke(event);
    if(result.kind==='rejected')throw new Error(`Public route rejected: ${JSON.stringify({event,error:result.error,trace:this.trace})}`);
    return result;
  }
  observe():void {this.accept({kind:'observe'});}
  bind(requestId:string):Caller {
    const request=this.state.requests.find(item=>item.id===requestId);
    if(!request)throw new Error(`Missing request ${requestId}`);
    let seat=this.seats.find(item=>item.requestedName===request.name);
    if(!seat){seat={agentId:`seat-${this.seats.length+1}`,requestedName:request.name,parentId:MAIN.agentId,sessionId:`session-${this.seats.length+1}`,createdAt:this.time++,status:'running',plan:'disabled',streaming:false};this.seats.push(seat);}
    if(request.binding.kind==='unbound')this.accept({kind:'reply',caller:MAIN,ticket:`spawn:${request.id}`,revision:1,payload:{kind:'spawned',agentId:seat.agentId},acceptedAt:this.time++});
    if(!seat.sessionId)throw new Error('Own fixture always has a session');
    return {agentId:seat.agentId,sessionId:seat.sessionId,parentId:MAIN.agentId,runId:MAIN.runId,kind:'sub',depth:1};
  }
  reply(ticket:Ticket,payload:ProtocolReply):Transition {
    const caller=ticket.holder.kind==='main'?MAIN:this.bind(ticket.holder.requestId);
    return this.invoke({kind:'reply',caller,ticket:ticket.id,revision:ticket.revision,payload,acceptedAt:this.time++});
  }
  acceptReply(ticket:Ticket,payload:ProtocolReply):void {
    const result=this.reply(ticket,payload);
    if(result.kind==='rejected')throw new Error(`Public reply rejected: ${JSON.stringify({ticket:ticket.id,payload,error:result.error,trace:this.trace})}`);
  }
  ticket(id:string):Ticket {
    const ticket=this.project().find(item=>item.id===id);
    if(!ticket)throw new Error(`No public ticket ${id}: ${JSON.stringify(this.summary())}`);
    return ticket;
  }
  work(ref:IssueRef=ORIGINAL):Ticket { const work=this.member(ref).work;if(!work)throw new Error(`No work: ${JSON.stringify(this.summary())}`);return this.ticket(`work:${work.id}`); }
  case(kind:DecisionCase['subject']['kind']):DecisionCase {
    const found=this.state.cases.find(item=>item.subject.kind===kind&&(item.state.kind==='open'||item.state.kind==='awaitingExternal'));
    if(!found)throw new Error(`No ${kind} case: ${JSON.stringify(this.summary())}`);
    return found;
  }
  decide(item:DecisionCase,decision:CaseDecision):void {this.acceptReply(this.ticket(`case:${item.id}`),{kind:'decision',decision});}
  beginDesign(route:DesignRoute, bodyEdits:readonly {issue:IssueRef;expectedHash:string;body:string}[]=[]):string {
    this.observe();this.acceptReply(this.work(),question);
    this.decide(this.case('claim'),{kind:'amend',amendment:{kind:'designGap',affected:[ORIGINAL],bodyEdits:[...bodyEdits],route}});
    const work=this.state.designWorks.at(-1);if(!work)throw new Error('Accepted amendment did not create design work');return work.id;
  }
  rejectableRoute(route:DesignRoute):Transition {
    this.observe();this.acceptReply(this.work(),question);
    const item=this.case('claim');
    const proposed=this.reply(this.ticket(`case:${item.id}`),{kind:'decision',decision:{kind:'amend',amendment:{kind:'designGap',affected:[ORIGINAL],bodyEdits:[],route}}});
    if(proposed.kind==='rejected')return proposed;
    const work=this.state.designWorks.at(-1);
    if(!work)throw new Error('Accepted design route has no actionable design work');
    this.remote();return this.design(work.id);
  }
  remote(commit:ShaRef={repo:A,sha:DESIGN}):void {this.facts.commits.push({repo:commit.repo,ancestor:commit.sha,descendant:commit.sha,result:'contains'});}
  design(id:string,commit:ShaRef={repo:A,sha:DESIGN}):Transition {return this.reply(this.ticket(`work:${id}`),{kind:'designCommit',commit});}
  body(ref:IssueRef,body:string):void {const source=this.source(ref);source.body=body;source.bodyHash=hash(body);source.updatedAt=this.time++;}
  noCode(ref:IssueRef=ORIGINAL):void {
    this.accept({kind:'mainNoCode',caller:MAIN,member:ref,bodyHash:this.source(ref).bodyHash,reason:'This exact current member needs no code',acceptedAt:this.time++});
  }
  effect(kind:Effect['action']['kind']):Effect {
    const effect=this.state.effects.find(item=>item.action.kind===kind&&item.state.kind==='ready');
    if(!effect)throw new Error(`No ready ${kind}: ${JSON.stringify(this.summary())}`);return effect;
  }
  start(effect:Effect):void {this.accept({kind:'effectStarted',id:effect.id,attempt:effect.attempt+1,startedAt:this.time++});}
  confirm(effect:Effect,result:EffectResult):void {this.accept({kind:'effectConfirmed',id:effect.id,attempt:this.state.effects.find(item=>item.id===effect.id)!.attempt,result});}
  satisfy(effect:Effect,result:EffectResult):void {this.accept({kind:'effectSatisfied',id:effect.id,result});}
  submit(ref:IssueRef=ORIGINAL,template:'fourLayer'|'docOnly'='fourLayer'):void {
    this.acceptReply(this.work(ref),{kind:'submit',branch:'owner-change',head:HEAD,title:'Deliver audited behavior',body:`Deliver audited behavior\n\nCloses ${ref.repo.owner}/${ref.repo.name}#${ref.number}`,template,retryNote:null});
  }
  publish(ref:IssueRef=ORIGINAL):void {
    const effect=this.effect('publishPr');if(effect.action.kind!=='publishPr')throw new Error('Unreachable fixture narrowing');
    const pr=pull(PR,ref,effect.action.target.base);pr.body=effect.action.body;pr.bodyHash=hash(pr.body);this.facts.prs.push(pr);
    this.authorize(pr);this.satisfy(effect,{kind:'published',pr:pr.ref});this.observe();
  }
  authorize(pr:PrSnapshot):void {
    this.facts.maintenance.push({pr:pr.ref,result:{kind:'maintainable',basis:{headRepo:pr.headRepo,headBranch:pr.headBranch,viewerPermission:'WRITE',author:'audit-owner',maintainerCanModify:true,authorization:{kind:'authorAuthorized',evidence:'Explicit author handoff for this exact PR'}}}});
  }
  gate(job:GateJob|null,ok=true):void {if(!job)throw new Error(`No expected gate: ${JSON.stringify(this.summary())}`);this.acceptReply(this.ticket(`gate:${job.id}`),{kind:'verdict',ok,note:ok?'Independent verification passed':'Independent verification failed'});}
  close(ref:IssueRef=ORIGINAL):void {const source=this.source(ref);source.state='closed';source.lastClose={id:`close-${ref.number}-${this.time}`,at:this.time++};}
  summary():unknown {return {version:this.state.version,members:this.state.units.flatMap(unit=>unit.members.map(member=>({ref:member.ref,work:member.work,terminal:member.terminal,requirements:member.contract.requirements}))),cases:this.state.cases,effects:this.state.effects.map(effect=>({id:effect.id,action:effect.action.kind,state:effect.state})),drafts:this.state.drafts,amendments:this.state.amendments};}
  context(label:string):string {return `${label}\n${JSON.stringify({state:this.summary(),trace:this.trace})}`;}
}

function expectAccepted(result:Transition,consumer:Consumer,label:string):void {
  expect(result.kind,consumer.context(label)).not.toBe('rejected');
}
function expectRejected(result:Transition,consumer:Consumer,label:string):void {
  expect(result.kind,consumer.context(label)).toBe('rejected');
}

// Every expectation below comes from the approved protocol, not current behavior.
describe('independent public decision routes',()=>{
  test('defaultFirst refuses an existing commit until the exact repository default contains it',()=>{
    const c=new Consumer();const id=c.beginDesign({kind:'defaultFirst',repo:A});c.remote();
    const rejected=c.design(id);expectRejected(rejected,c,'Unlanded defaultFirst must remain design work');
    if(rejected.kind==='rejected')expect(rejected.error.kind).toBe('missingDesignCommit');
    expect(c.state.designWorks[0]?.result).toBeNull();
    c.facts.commits.push({repo:A,ancestor:DESIGN,descendant:DEFAULT,result:'contains'});
    expectAccepted(c.design(id),c,'The same exact commit is now in A/main');c.observe();c.observe();
    expect(c.member().contract.requirements.map(item=>item.commit)).toEqual([{repo:A,sha:DESIGN}]);
    expect(c.state.amendments[0]?.state.kind).toBe('effective');
    expect(c.work().runDisposition).toBe('mustRun');
  });

  test('defaultFirst does not accept same SHA containment reported only for another repository',()=>{
    const c=new Consumer();const id=c.beginDesign({kind:'defaultFirst',repo:A});c.remote();
    c.facts.commits.push({repo:B,ancestor:DESIGN,descendant:DEFAULT,result:'contains'});
    expectRejected(c.design(id),c,'Repository-qualified default containment cannot be borrowed');
    expect(c.member().contract.requirements).toEqual([]);
  });

  test('withPr preserves work identity, requires the exact commit, and accepts source-proven inclusion',()=>{
    const c=new Consumer();c.observe();const original=c.work().id;
    const id=c.beginDesign({kind:'withPr',member:ORIGINAL});c.remote();expectAccepted(c.design(id),c,'withPr remote commit');c.observe();c.observe();
    expect(c.work().id).toBe(original);expect(c.member().work?.required).toEqual([{repo:A,sha:DESIGN}]);
    const payload:ProtocolReply={kind:'submit',branch:'owner-change',head:HEAD,title:'Deliver audited behavior',body:'Closes RouteAudit/implementation#11',template:'fourLayer',retryNote:null};
    expectRejected(c.reply(c.work(),payload),c,'A remote commit alone does not prove the submitted branch carries it');
    c.facts.commits.push({repo:B,ancestor:DESIGN,descendant:HEAD,result:'contains'});
    expectRejected(c.reply(c.work(),payload),c,'Another repository with identical hashes does not satisfy withPr');
    c.facts.commits.push({repo:A,ancestor:DESIGN,descendant:HEAD,result:'contains'});
    expectAccepted(c.reply(c.work(),payload),c,'Exact repo-qualified design is carried by the remote submission');
    expect(c.member().binding.kind).toBe('publishing');expect(c.member().review).toBeNull();
  });

  test('future existing member owns the obligation without broadcasting it to the current implementation',()=>{
    const c=new Consumer([entry(ORIGINAL),entry(LATER)]);const id=c.beginDesign({kind:'future',carrier:LATER});c.remote();
    expectAccepted(c.design(id),c,'Future exact same-repository member');c.observe();c.observe();
    expect(c.member().contract.requirements).toEqual([]);
    expect(c.member(LATER).contract.requirements.map(item=>item.commit)).toEqual([{repo:A,sha:DESIGN}]);
    expect(c.member(LATER).work).toBeNull();expect(c.work().runDisposition).toBe('mustRun');
  });

  test('future route rejects the current member instead of relabeling withPr',()=>{
    const c=new Consumer();
    expectRejected(c.rejectableRoute({kind:'future',carrier:ORIGINAL}),c,'future requires a genuinely later carrier, not current owner');
  });

  test('future existing carrier cannot consume a commit from another repository',()=>{
    const other={repo:B,number:12};const c=new Consumer([entry(ORIGINAL),entry(other)]);
    expectRejected(c.rejectableRoute({kind:'future',carrier:other}),c,'Future carrier must be in the exact commit repository');
  });

  test('future designOnly draft carries its requirement through real creation into a member',()=>{
    const c=new Consumer();const id=c.beginDesign({kind:'future',carrier:draft()});c.remote();expectAccepted(c.design(id),c,'Future designOnly draft');
    const pending=c.state.drafts[0];expect(pending?.requirement?.commit).toEqual({repo:A,sha:DESIGN});
    const creation=c.effect('createIssue');c.start(creation);
    if(creation.action.kind!=='createIssue')throw new Error('Expected the actual draft creation action');
    const executing=c.state.effects.find(effect=>effect.id===creation.id)?.state;
    if(executing?.kind!=='executing')throw new Error('Expected the persisted creation attempt');
    c.facts.issues.push(issue(LATER,draft().body));
    c.facts.createdIssues.push({issue:LATER,title:creation.action.spec.title,body:creation.action.spec.body,actor:creation.action.actor,createdAt:executing.startedAt});
    c.confirm(creation,{kind:'created',issue:LATER});c.observe();c.observe();
    expect(c.state.drafts[0]?.state).toEqual({kind:'placed',member:LATER});
    expect(c.member(LATER).designOnly).toBe(true);
    expect(c.member(LATER).contract.requirements.map(item=>item.commit)).toEqual([{repo:A,sha:DESIGN}]);
    expect(parseAgenda(c.state).ok,c.context('Public generated draft state must round-trip')).toBe(true);
  });

  test('future draft rejects a cross-repository carrier before accepting the design result',()=>{
    const c=new Consumer();
    expectRejected(c.rejectableRoute({kind:'future',carrier:draft(B)}),c,'An A commit cannot be assigned to a B draft even when both repos exist');
  });

  test('future draft requires designOnly rather than an unrelated implementation issue',()=>{
    const c=new Consumer();
    expectRejected(c.rejectableRoute({kind:'future',carrier:draft(A,false)}),c,'Only an explicit designOnly draft can carry future design');
  });

  test('designOnly Member is Main-held yet still submits, publishes, gates, merges and postMerge verifies',()=>{
    const c=new Consumer([entry(ORIGINAL,true)]);c.observe();expect(c.work().holder).toEqual({kind:'main'});expect(c.state.requests).toEqual([]);
    c.submit(ORIGINAL,'docOnly');c.publish();c.gate(c.member().review);c.gate(c.member().accept);c.observe();
    const merge=c.effect('merge');c.start(merge);const pr=c.facts.prs[0]!;pr.state={kind:'merged',sha:MERGE,at:c.time++};c.close();
    c.confirm(merge,{kind:'merged',pr:PR,merge:{repo:A,sha:MERGE},at:pr.state.at});c.observe();c.observe();
    expect(c.member().terminal.kind).toBe('merged');expect(c.state.units[0]?.postMerge?.kind).toBe('postMerge');
    c.gate(c.state.units[0]!.postMerge);c.observe();expect(c.state.report?.state.kind,c.context('DesignOnly is not complete without its normal postMerge')).toBe('requested');
    expect(c.state.requests.some(request=>request.role==='owner')).toBe(false);
  });

  test('body conflict rejects the unsent write; rebase preserves human text and unblocks the original amendment',()=>{
    const c=new Consumer();const originalBody=c.source().bodyHash;
    const id=c.beginDesign({kind:'withPr',member:ORIGINAL},[{issue:ORIGINAL,expectedHash:originalBody,body:'Original amendment target'}]);
    c.remote();expectAccepted(c.design(id),c,'Design accepted before source body conflict');
    const edit=c.effect('replaceBody');c.body(ORIGINAL,'Human concurrent text');
    expectRejected(c.invoke({kind:'effectStarted',id:edit.id,attempt:1,startedAt:c.time++}),c,'Current source CAS must reject before sending');
    c.accept({kind:'effectFailed',id:edit.id,attempt:0,outcome:'knownFailed',error:{kind:'precondition',message:'Source current body differs from expected and target'}});
    c.observe();const failure=c.case('effectFailure');
    const mergedBody='Human concurrent text\n\nRebased agreed amendment';
    c.decide(failure,{kind:'rebaseEdit',effectId:edit.id,expectedHash:c.source().bodyHash,body:mergedBody});
    const rebased=c.state.effects.find(item=>item.id===edit.id)!;c.start(rebased);c.body(ORIGINAL,mergedBody);c.confirm(rebased,{kind:'bodyReplaced',issue:ORIGINAL,hash:c.source().bodyHash});c.observe();c.observe();
    expect(c.state.amendments[0]?.state.kind,c.context('Confirmed rebased replacement must satisfy the same amendment, not wait forever for the abandoned body')).toBe('effective');
    expect(c.member().contract.body).toBe(mergedBody);expect(c.member().work?.required).toEqual([{repo:A,sha:DESIGN}]);expect(c.work().runDisposition).toBe('mustRun');
  });

  test('case body changes reject the stale decision, then expose an actionable newer revision',()=>{
    const c=new Consumer();c.observe();c.acceptReply(c.work(),question);const before=c.case('claim');const old=c.ticket(`case:${before.id}`);
    c.body(ORIGINAL,'Changed requirements from source');
    expectRejected(c.reply(old,{kind:'decision',decision:{kind:'answer',basis:'Answer against the old wording'}}),c,'Old source body is not silently consumed');
    c.observe();const current=c.ticket(`case:${before.id}`);expect(current.revision).toBe(old.revision+1);
    expectAccepted(c.reply(current,{kind:'decision',decision:{kind:'answer',basis:'Answer explicitly against the new source requirements'}}),c,'Freshly reviewed body can be decided');
    expect(c.member().work).not.toBeNull();
  });

  test('orphan can fail twice and still reopens the same exact repo-qualified obligation',()=>{
    const c=new Consumer([entry(ORIGINAL),entry(LATER),entry(THIRD)]);const id=c.beginDesign({kind:'withPr',member:ORIGINAL});c.remote();expectAccepted(c.design(id),c,'Original design');c.observe();c.observe();
    const originalCase=c.state.cases.find(item=>item.id===c.state.designWorks[0]!.parentCaseId)!;
    c.noCode();c.close();c.observe();const orphan=c.case('orphanDesign');expect(orphan.id).toBe(originalCase.id);
    c.decide(orphan,{kind:'assignCarrier',commit:{repo:A,sha:DESIGN},carrier:LATER});
    expect(c.member(LATER).contract.requirements.map(item=>item.commit)).toEqual([{repo:A,sha:DESIGN}]);
    // The current unit must finish before the next becomes eligible for noCode.
    c.observe();c.gate(c.state.units[0]!.postMerge);c.observe();
    c.noCode(LATER);c.close(LATER);c.observe();const reopened=c.case('orphanDesign');
    expect(reopened.id).toBe(originalCase.id);expect(reopened.contentVersion).toBeGreaterThan(orphan.contentVersion);
    expect(reopened.subject.kind==='orphanDesign'?reopened.subject.requirement.commit:null).toEqual({repo:A,sha:DESIGN});
    c.decide(reopened,{kind:'assignCarrier',commit:{repo:A,sha:DESIGN},carrier:THIRD});
    expect(c.member(THIRD).contract.requirements.map(item=>item.commit)).toEqual([{repo:A,sha:DESIGN}]);
  });

  test('orphan assignment rejects a different repository with the identical SHA',()=>{
    const c=new Consumer([entry(ORIGINAL),entry(LATER)]);const id=c.beginDesign({kind:'withPr',member:ORIGINAL});c.remote();expectAccepted(c.design(id),c,'Original design');c.observe();c.observe();c.noCode();c.close();c.observe();
    const orphan=c.case('orphanDesign');
    expectRejected(c.reply(c.ticket(`case:${orphan.id}`),{kind:'decision',decision:{kind:'assignCarrier',commit:{repo:B,sha:DESIGN},carrier:LATER}}),c,'No SHA-only orphan matching');
    expect(c.member(LATER).contract.requirements).toEqual([]);
  });

  test('agendaGap includeExisting inserts the original child, not a replacement draft',()=>{
    const facts=independentFacts([PARENT,ORIGINAL,LATER]);facts.issues.find(item=>same(item.ref,PARENT))!.children=[ORIGINAL,LATER];
    const c=new Consumer([entry(ORIGINAL)],PARENT,facts);c.observe();const gap=c.case('agendaGap');
    c.decide(gap,{kind:'includeExisting',issue:LATER,position:{kind:'after',unitId:c.state.units[0]!.id}});
    expect(c.state.units.flatMap(unit=>unit.members.map(member=>member.ref))).toEqual([ORIGINAL,LATER]);expect(c.state.drafts).toEqual([]);expect(c.member(LATER).work).toBeNull();
    expect(c.state.effects.some(effect=>effect.action.kind==='createIssue')).toBe(false);
  });

  test('agendaGap confirmNoCode records and closes the exact previously-unlisted child',()=>{
    const facts=independentFacts([PARENT,ORIGINAL,LATER]);facts.issues.find(item=>same(item.ref,PARENT))!.children=[ORIGINAL,LATER];
    const c=new Consumer([entry(ORIGINAL)],PARENT,facts);c.observe();const gap=c.case('agendaGap');
    const result=c.reply(c.ticket(`case:${gap.id}`),{kind:'decision',decision:{kind:'confirmNoCode',issue:LATER,bodyHash:c.source(LATER).bodyHash,reason:'Exact child is already satisfied without implementation'}});
    expectAccepted(result,c,'Missing child noCode is a supported agendaGap alternative to includeExisting');
    c.observe();expect(c.state.cases.find(item=>item.id===gap.id)?.state.kind).toBe('resolved');
    expect(c.state.effects.some(effect=>effect.action.kind==='setIssueState'&&same(effect.action.issue,LATER)&&!effect.action.open),c.context('Child must be reconciled at source, not just dropped from closure')).toBe(true);
  });

  test('agendaGap noCode cannot target a different already-listed child',()=>{
    const facts=independentFacts([PARENT,ORIGINAL,LATER]);facts.issues.find(item=>same(item.ref,PARENT))!.children=[ORIGINAL,LATER];
    const c=new Consumer([entry(ORIGINAL)],PARENT,facts);c.observe();const gap=c.case('agendaGap');
    expectRejected(c.reply(c.ticket(`case:${gap.id}`),{kind:'decision',decision:{kind:'confirmNoCode',issue:ORIGINAL,bodyHash:c.source().bodyHash,reason:'Do not misdirect the missing-child decision'}}),c,'Case subject pins the missing child; payload cannot close the unrelated current member');
    expect(c.member().terminal.kind).toBe('pending');
  });

  test('new parent child invalidates an existing closure verdict before it can be accepted',()=>{
    const facts=independentFacts([PARENT,ORIGINAL,LATER]);facts.issues.find(item=>same(item.ref,PARENT))!.children=[ORIGINAL];
    const c=new Consumer([entry(ORIGINAL)],PARENT,facts);c.observe();c.noCode();c.close();c.observe();c.gate(c.state.units[0]!.postMerge);c.observe();
    const old=c.state.closure;expect(old).not.toBeNull();const ticket=c.ticket(`gate:${old!.id}`);c.source(PARENT).children.push(LATER);
    expectRejected(c.reply(ticket,{kind:'verdict',ok:true,note:'Old closure cannot cover a newly attached child'}),c,'Closure input contains the complete current child identity set');
    c.observe();expect(c.case('agendaGap').subject.kind).toBe('agendaGap');
    expect(c.state.effects.some(effect=>effect.action.kind==='setIssueState'&&same(effect.action.issue,PARENT)&&!effect.action.open&&effect.state.kind==='ready')).toBe(false);
  });

  test('non-default base can explicitly adopt an exact-closing authorized PR with empty GitHub closing refs',()=>{
    const facts=independentFacts([ORIGINAL]);const pr=pull(PR,ORIGINAL,'release');pr.closes=[];facts.prs.push(pr);
    facts.maintenance.push({pr:PR,result:{kind:'maintainable',basis:{headRepo:A,headBranch:pr.headBranch,viewerPermission:'WRITE',author:'audit-owner',maintainerCanModify:true,authorization:{kind:'authorAuthorized',evidence:'Explicit adoption authorization'}}}});
    const result=createAgenda({op:'convene',mode:'execute',parent:null,entries:[entry(ORIGINAL,false,'release',PR)]},facts,10,ID);
    expect(result.ok,`Explicit non-default-base adoption, body=${JSON.stringify(pr.body)}, source.closes=[], result=${JSON.stringify(result)}`).toBe(true);
    if(result.ok){const c=new Consumer([entry(ORIGINAL)],null,facts);c.state=result.value;c.observe();expect(c.member().work).toBeNull();expect(c.member().review?.kind).toBe('review');}
  });

  test('non-default adopted merge creates an independent close intent without a second owner obligation',()=>{
    const facts=independentFacts([ORIGINAL]);const pr=pull(PR,ORIGINAL,'release');facts.prs.push(pr);facts.maintenance.push({pr:PR,result:{kind:'maintainable',basis:{headRepo:A,headBranch:pr.headBranch,viewerPermission:'WRITE',author:'audit-owner',maintainerCanModify:true,authorization:{kind:'authorAuthorized',evidence:'Explicit adoption authorization'}}}});
    const c=new Consumer([entry(ORIGINAL,false,'release',PR)],null,facts);c.observe();
    // GitHub can lose closingIssuesReferences on this non-default target; our explicit
    // adoption binding, not a foreign branch-name heuristic, preserves the relation.
    pr.closes=[];pr.state={kind:'merged',sha:MERGE,at:c.time++};c.observe();
    expect(c.member().terminal.kind).toBe('merged');expect(c.member().work).toBeNull();
    const close=c.effect('setIssueState');expect(close.action.kind==='setIssueState'?close.action.issue:null).toEqual(ORIGINAL);
    expect(c.state.units[0]?.postMerge).toBeNull();c.close();c.satisfy(close,{kind:'issueState',issue:ORIGINAL,open:false,event:c.source().lastClose});c.observe();
    expect(c.state.units[0]?.postMerge?.kind).toBe('postMerge');
  });

  test('defaultFirst noCode exposes the exact original migration obligation and accepts its existing migration issue',()=>{
    const c=new Consumer([entry(ORIGINAL)],null,independentFacts([ORIGINAL,LATER]));
    const id=c.beginDesign({kind:'defaultFirst',repo:A});c.remote();c.facts.commits.push({repo:A,ancestor:DESIGN,descendant:DEFAULT,result:'contains'});
    expectAccepted(c.design(id),c,'Design source-confirmed on default');c.observe();c.observe();c.noCode();c.close();c.observe();
    const migration=c.case('migration');
    expect(migration.subject).toEqual({kind:'migration',original:ORIGINAL,commit:{repo:A,sha:DESIGN}});
    c.decide(migration,{kind:'assignMigration',original:ORIGINAL,migration:LATER});
    expect(c.state.units.flatMap(unit=>unit.members.map(member=>member.ref))).toEqual([ORIGINAL,LATER]);expect(c.state.drafts).toEqual([]);
    expect(c.state.effects.some(effect=>effect.action.kind==='createIssue')).toBe(false);
    expect(c.member().terminal.kind).toBe('noCode');expect(c.member(LATER).work).toBeNull();
    c.observe();c.gate(c.state.units[0]!.postMerge);c.observe();
    expect(c.work(LATER).runDisposition,c.context('The inserted original migration issue becomes real runnable work')).toBe('mustRun');
  });

  test('migration decision cannot substitute a different original implementation object',()=>{
    const c=new Consumer([entry(ORIGINAL)],null,independentFacts([ORIGINAL,LATER,THIRD]));
    const id=c.beginDesign({kind:'defaultFirst',repo:A});c.remote();c.facts.commits.push({repo:A,ancestor:DESIGN,descendant:DEFAULT,result:'contains'});
    expectAccepted(c.design(id),c,'Design source-confirmed on default');c.observe();c.observe();c.noCode();c.close();c.observe();
    const migration=c.case('migration');
    expectRejected(c.reply(c.ticket(`case:${migration.id}`),{kind:'decision',decision:{kind:'assignMigration',original:THIRD,migration:LATER}}),c,'The migration case is pinned to ORIGINAL, not a payload-selected lookalike');
    expect(c.state.units.flatMap(unit=>unit.members.map(member=>member.ref))).toEqual([ORIGINAL]);
  });

  test('a failed replacement migration carrier reopens the same original migration obligation',()=>{
    const c=new Consumer([entry(ORIGINAL)],null,independentFacts([ORIGINAL,LATER,THIRD]));
    const id=c.beginDesign({kind:'defaultFirst',repo:A});c.remote();c.facts.commits.push({repo:A,ancestor:DESIGN,descendant:DEFAULT,result:'contains'});
    expectAccepted(c.design(id),c,'Design source-confirmed on default');c.observe();c.observe();c.noCode();c.close();c.observe();
    const migration=c.case('migration');c.decide(migration,{kind:'assignMigration',original:ORIGINAL,migration:LATER});
    c.observe();c.gate(c.state.units[0]!.postMerge);c.observe();c.noCode(LATER);c.close(LATER);c.observe();
    const reopened=c.case('migration');expect(reopened.id).toBe(migration.id);
    expect(reopened.subject).toEqual({kind:'migration',original:ORIGINAL,commit:{repo:A,sha:DESIGN}});
    c.decide(reopened,{kind:'assignMigration',original:ORIGINAL,migration:THIRD});
    const members=c.state.units.flatMap(unit=>unit.members.map(member=>member.ref));
    expect(members).toHaveLength(3);for(const ref of [ORIGINAL,LATER,THIRD])expect(members).toContainEqual(ref);
    expect(c.state.effects.some(effect=>effect.action.kind==='createIssue')).toBe(false);
  });

  test('removing an unaccepted missing child cancels only its obsolete agendaGap case',()=>{
    const facts=independentFacts([PARENT,ORIGINAL,LATER]);facts.issues.find(item=>same(item.ref,PARENT))!.children=[ORIGINAL,LATER];
    const c=new Consumer([entry(ORIGINAL)],PARENT,facts);c.observe();const gap=c.case('agendaGap');const work=c.work().id;
    c.source(PARENT).children=[ORIGINAL];c.observe();
    expect(c.state.cases.find(item=>item.id===gap.id)?.state,c.context('A source-removed missing child is no longer an agenda obligation')).toEqual({kind:'cancelled',reason:'parentRemoved'});
    expect(c.work().id).toBe(work);expect(c.member().terminal.kind).toBe('pending');
  });

  test('withPr cannot silently assign the current design to a different member',()=>{
    const c=new Consumer([entry(ORIGINAL),entry(LATER)]);
    expectRejected(c.rejectableRoute({kind:'withPr',member:LATER}),c,'withPr is current-member delivery, not the future-member route');
  });

  test('an unadopted foreign non-default PR cannot infer a merge relation from its body or branch',()=>{
    const facts=independentFacts([ORIGINAL]);const pr=pull(PR,ORIGINAL,'release');pr.closes=[];facts.prs.push(pr);
    const c=new Consumer([entry(ORIGINAL,false,'release')],null,facts);c.observe();const work=c.work().id;
    pr.state={kind:'merged',sha:MERGE,at:c.time++};c.observe();
    expect(c.member().terminal.kind).toBe('pending');expect(c.work().id).toBe(work);
    expect(c.state.effects.some(effect=>effect.action.kind==='setIssueState')).toBe(false);
  });

  test('public decision parser retains exact existing migration and noCode child identities',()=>{
    const replies:ProtocolReply[]=[{kind:'decision',decision:{kind:'assignMigration',original:ORIGINAL,migration:LATER}},{kind:'decision',decision:{kind:'confirmNoCode',issue:LATER,bodyHash:hash('Deliver 12'),reason:'Exact missing child needs no code'}}];
    for(const reply of replies){const parsed=parsePortInput({op:'reply',ticket:`case:${ID}/case/99`,revision:1,reply});expect(parsed.ok).toBe(true);if(parsed.ok&&parsed.value.op==='reply')expect(parsed.value.reply).toEqual(reply);}
  });
});
