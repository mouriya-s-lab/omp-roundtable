import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createAgenda, parseAgenda, tickets, transition} from '../src/domain/index.ts';
import type {
  Agenda, Caller, CaseDecision, DecisionCase, DomainRef, Effect, Entry, Event,
  Facts, HostSeat, Inputs, IssueRef, ProtocolReply, ReplyResult, Repo, Ticket, Transition,
} from '../src/domain/index.ts';

// Independent consumer fixtures; normal states are built only through public transitions.
const REPO:Repo={owner:'IdentityAudit',name:'delivery'};
const OTHER:Repo={owner:'IdentityAudit',name:'unrelated'};
const MEMBER:IssueRef={repo:REPO,number:21};
const FUTURE:IssueRef={repo:REPO,number:22};
const INSERTED:IssueRef={repo:REPO,number:23};
const PR:IssueRef={repo:REPO,number:101};
const HEAD='1'.repeat(40);
const BASE='a'.repeat(40);
const AGENDA='44556677-8899-4123-8123-123456789abc';
const MAIN:Caller={agentId:'main',sessionId:'main-session',parentId:null,runId:'identity-run',kind:'main',depth:0};
const hash=(body:string):string=>createHash('sha256').update(body).digest('hex');
const entry=(issue:IssueRef,adoptPr:IssueRef|null=null):Entry=>({issue,target:{repo:issue.repo,base:'main'},designOnly:false,adoptPr});
const QUESTION:ProtocolReply={kind:'claim',claim:{kind:'question',reproduction:'The required implementation route is ambiguous',readings:['Keep the existing clause','Amend the clause before implementation'],earliestGap:'Contract route',proposal:'Main chooses the explicit route'}};
const DRAFT={repo:REPO,title:'Separate obligation',body:'Deliver the distinct obligation without erasing the original',target:{repo:REPO,base:'main'},designOnly:false};

type ReplyObservation={before:Agenda;after:Agenda;event:Event & {kind:'reply'};reply:ReplyResult};

function allocated(state:Agenda):DomainRef[] {
  const refs:DomainRef[]=[];
  for(const unit of state.units){
    refs.push({kind:'unit',id:unit.id});
    if(unit.postMerge)refs.push({kind:'gate',id:unit.postMerge.id});
    for(const member of unit.members){
      if(member.work)refs.push({kind:'work',id:member.work.id});
      for(const gate of [member.review,member.accept])if(gate)refs.push({kind:'gate',id:gate.id});
    }
  }
  if(state.closure)refs.push({kind:'gate',id:state.closure.id});
  for(const work of state.designWorks)refs.push({kind:'work',id:work.id});
  for(const item of state.cases)refs.push({kind:'case',id:item.id});
  for(const item of state.drafts)refs.push({kind:'draft',id:item.id});
  for(const item of state.amendments)refs.push({kind:'amendment',id:item.id});
  for(const item of state.effects)refs.push({kind:'effect',id:item.id});
  for(const item of state.requests)refs.push({kind:'request',id:item.id});
  if(state.report)refs.push({kind:'work',id:state.report.id});
  return refs;
}
const refKeys=(refs:readonly DomainRef[]):string[]=>refs.map(ref=>`${ref.kind}:${ref.id}`).sort();

class PublicClient {
  state:Agenda;
  readonly facts:Facts;
  readonly seats:HostSeat[]=[];
  readonly turnEnds:{agentId:string;runId:string;messageId:string}[]=[];
  readonly trace:unknown[]=[];
  time=1000;
  constructor(adopted=false){
    this.facts={viewer:REPO.owner,issues:[MEMBER,FUTURE,INSERTED].map(ref=>{const body=`Deliver member ${ref.number}`;return {ref,body,bodyHash:hash(body),updatedAt:1,state:'open',lastClose:null,lastReopen:null,children:[]};}),prs:[],links:[],repos:[{repo:REPO,defaultBranch:'main',defaultHead:BASE,bases:[{name:'main',state:{kind:'present',head:BASE,isDefault:true,rules:{required:[],strict:false,upToDate:true,constraints:[]}}}]}],branches:[{repo:REPO,name:'identity-change',state:{kind:'present',head:HEAD}}],maintenance:[],commits:[],checkAttempts:[],createdIssues:[]};
    if(adopted){
      const body='Deliver implementation\n\nCloses IdentityAudit/delivery#21';
      this.facts.prs.push({ref:PR,headRepo:REPO,headBranch:'identity-change',head:HEAD,target:{repo:REPO,base:'main'},title:'Deliver implementation',body,bodyHash:hash(body),updatedAt:1,state:{kind:'open'},closes:[MEMBER],mergeable:'yes',checks:{kind:'passing',required:[]}});
      this.facts.maintenance.push({pr:PR,result:{kind:'maintainable',basis:{headRepo:REPO,headBranch:'identity-change',viewerPermission:'WRITE',author:REPO.owner,maintainerCanModify:true,authorization:{kind:'actorIsAuthor',actor:REPO.owner}}}});
    }
    const result=createAgenda({op:'convene',mode:'execute',parent:null,entries:[entry(MEMBER,adopted?PR:null),entry(FUTURE)]},this.facts,10,AGENDA);
    if(!result.ok)throw new Error(`Convene failed: ${JSON.stringify(result.error)}`);
    this.state=result.value;
    this.observe();
  }
  get input():Inputs {
    const creations=this.state.effects.flatMap(effect=>effect.action.kind==='createIssue'&&effect.state.kind==='uncertain'?[{repo:effect.action.spec.repo,since:Math.floor(effect.state.startedAt/1000)*1000,title:effect.action.spec.title,body:effect.action.spec.body,actor:effect.action.actor}]:[]);
    return {facts:{kind:'available',generation:1,observedAt:this.time,scope:{issues:this.facts.issues.map(issue=>issue.ref),prs:this.facts.prs.map(pr=>pr.ref),repos:[{repo:REPO,bases:['main']}],branches:[{repo:REPO,name:'identity-change'}],commits:[],checkRuns:[],creations},facts:this.facts},host:{runId:MAIN.runId,main:MAIN,seats:this.seats,turnEnds:this.turnEnds,preflight:{ok:true,value:{asyncEnabled:true,isolationEnabled:true,asyncManager:true,gitCwd:'/tmp/agenda-identities',agents:[{name:'task:free',blocking:false}]}}},policy:{text:'Keep each exact delivery obligation and allocation identity.',ownerAgent:'task:free',gateAgent:'task:free'}};
  }
  invoke(event:Event):Transition {
    const result=transition(this.state,this.input,event);
    this.trace.push({event,result:result.kind==='rejected'?result.error:{kind:result.kind,reply:result.reply},version:this.state.version});
    if(result.kind==='next')this.state=result.state;
    return result;
  }
  accept(event:Event):Transition {
    const result=this.invoke(event);
    if(result.kind==='rejected')throw new Error(`Public transition rejected: ${JSON.stringify({error:result.error,trace:this.trace})}`);
    return result;
  }
  observe():void {this.accept({kind:'observe'});}
  get member(){const member=this.state.units.flatMap(unit=>unit.members).find(member=>member.ref.number===MEMBER.number);if(!member)throw new Error('Original member missing');return member;}
  ticket(id:string):Ticket {
    const ticket=tickets(this.state,this.input).find(ticket=>ticket.id===id);
    if(!ticket)throw new Error(`Missing public ticket ${id}: ${JSON.stringify({state:this.state,trace:this.trace})}`);
    return ticket;
  }
  work():Ticket {if(!this.member.work)throw new Error('Missing original work');return this.ticket(`work:${this.member.work.id}`);}
  bind(ticket:Ticket):Caller {
    if(ticket.holder.kind==='main')return MAIN;
    const requestId=ticket.holder.requestId;
    const request=this.state.requests.find(request=>request.id===requestId);
    if(!request)throw new Error('Missing seat request');
    let seat=this.seats.find(seat=>seat.requestedName===request.name);
    if(!seat){seat={agentId:`seat-${this.seats.length+1}`,requestedName:request.name,parentId:MAIN.agentId,sessionId:`session-${this.seats.length+1}`,createdAt:this.time++,status:'running',plan:'disabled',streaming:false};this.seats.push(seat);}
    if(request.binding.kind==='unbound')this.accept({kind:'reply',caller:MAIN,ticket:`spawn:${request.id}`,revision:1,payload:{kind:'spawned',agentId:seat.agentId},acceptedAt:this.time++});
    if(!seat.sessionId)throw new Error('Fixture seat has no session');
    return {agentId:seat.agentId,sessionId:seat.sessionId,parentId:MAIN.agentId,runId:MAIN.runId,kind:'sub',depth:1};
  }
  reply(ticket:Ticket,payload:ProtocolReply):ReplyObservation {
    const caller=this.bind(ticket);
    const before=structuredClone(this.state);
    const event:Event & {kind:'reply'}={kind:'reply',caller,ticket:ticket.id,revision:ticket.revision,payload,acceptedAt:this.time++};
    const result=this.accept(event);
    if(result.kind==='rejected'||!result.reply)throw new Error('Accepted reply has no result');
    return {before,after:structuredClone(this.state),event,reply:structuredClone(result.reply)};
  }
  case(kind:DecisionCase['subject']['kind']):DecisionCase {
    const item=this.state.cases.find(item=>item.subject.kind===kind&&(item.state.kind==='open'||item.state.kind==='awaitingExternal'));
    if(!item)throw new Error(`Missing ${kind} case: ${JSON.stringify(this.trace)}`);
    return item;
  }
  decide(item:DecisionCase,decision:CaseDecision):ReplyObservation {return this.reply(this.ticket(`case:${item.id}`),{kind:'decision',decision});}
  question():void {this.reply(this.work(),QUESTION);}
  finding():void {
    const gate=this.member.review;if(!gate)throw new Error('Missing adopted review');
    this.reply(this.ticket(`gate:${gate.id}`),{kind:'verdict',ok:false,note:'Implementation does not satisfy the stated behavior'});
  }
  effect(kind:Effect['action']['kind']):Effect {
    const effect=this.state.effects.find(effect=>effect.action.kind===kind&&effect.state.kind==='ready');
    if(!effect)throw new Error(`Missing ready ${kind}: ${JSON.stringify(this.trace)}`);
    return effect;
  }
  start(effect:Effect):void {this.accept({kind:'effectStarted',id:effect.id,attempt:effect.attempt+1,startedAt:this.time++});}
  fail(effect:Effect,outcome:'knownFailed'|'uncertain'):void {this.start(effect);this.accept({kind:'effectFailed',id:effect.id,attempt:effect.attempt+1,error:{kind:outcome==='uncertain'?'uncertainOutcome':'permission',message:'Independent transport fixture failure'},outcome});}
  context(label:string):string {return `${label}\n${JSON.stringify({state:this.state,trace:this.trace})}`;}
}

function expectCreated(client:PublicClient,observation:ReplyObservation,required:readonly DomainRef['kind'][]):void {
  const beforeIds=new Set(allocated(observation.before).map(ref=>ref.id));
  const delta=allocated(observation.after).filter(ref=>!beforeIds.has(ref.id));
  const context=client.context('ReplyResult.created must equal the actual public-state allocation delta');
  expect(refKeys(observation.reply.created),context).toEqual(refKeys(delta));
  expect(new Set(observation.reply.created.map(ref=>ref.id)).size,context).toBe(observation.reply.created.length);
  for(const kind of required)expect(delta.some(ref=>ref.kind===kind),context).toBe(true);
  for(const ref of observation.reply.created)expect(beforeIds.has(ref.id),context).toBe(false);
  client.observe();
  const beforeReplay=structuredClone(client.state);
  const replay=client.invoke(observation.event);
  expect(replay.kind,client.context('Exact replay must not allocate or rewrite')).toBe('same');
  if(replay.kind!=='rejected')expect(replay.reply,context).toEqual(observation.reply);
  expect(client.state,context).toEqual(beforeReplay);
}

function designSeed():PublicClient {
  const client=new PublicClient();client.question();
  client.decide(client.case('claim'),{kind:'amend',amendment:{kind:'designGap',affected:[MEMBER],bodyEdits:[{issue:MEMBER,expectedHash:client.member.contract.bodyHash,body:'Specify the amended implementation route'}],route:{kind:'withPr',member:MEMBER}}});
  return client;
}
function draftSeed():PublicClient {
  const client=new PublicClient(true);client.finding();client.decide(client.case('findings'),{kind:'outOfScope',draft:DRAFT});return client;
}
function callRetrySeed():PublicClient {
  const client=new PublicClient();
  client.reply(client.work(),{kind:'submit',branch:'identity-change',head:HEAD,title:'Deliver implementation',body:'Deliver implementation\n\nCloses IdentityAudit/delivery#21',template:'fourLayer',retryNote:null});
  const effect=client.effect('publishPr');client.fail(effect,'knownFailed');
  client.decide(client.case('effectFailure'),{kind:'retry',effectId:effect.id,attempt:1});return client;
}
function absenceRetrySeed():PublicClient {
  const client=draftSeed();const effect=client.effect('createIssue');client.fail(effect,'uncertain');
  client.decide(client.case('effectFailure'),{kind:'retryAfterAbsence',effectId:effect.id,attempt:1});return client;
}
function preflightRetrySeed():PublicClient {
  const client=designSeed();const effect=client.effect('replaceBody');
  const source=client.facts.issues.find(issue=>issue.ref.number===MEMBER.number);if(!source)throw new Error('Missing source');
  source.body='A later external contract';source.bodyHash=hash(source.body);source.updatedAt=client.time++;
  client.accept({kind:'effectFailed',id:effect.id,attempt:0,error:{kind:'precondition',message:'Exact body compare failed before sending'},outcome:'knownFailed'});
  client.decide(client.case('effectFailure'),{kind:'retry',effectId:effect.id,attempt:0});return client;
}
function deliveryRetrySeed():PublicClient {
  const client=new PublicClient();const caller=client.bind(client.work());
  const seat=client.seats.find(seat=>seat.agentId===caller.agentId);if(!seat)throw new Error('Missing bound seat');
  seat.status='parked';client.observe();const effect=client.effect('wake');client.start(effect);
  client.accept({kind:'effectConfirmed',id:effect.id,attempt:1,result:{kind:'delivered',agentId:caller.agentId,messageId:`${effect.id}:1`,outcome:'woken'}});
  client.turnEnds.push({agentId:caller.agentId,runId:MAIN.runId,messageId:`${effect.id}:1`});client.observe();
  const request=client.state.requests.find(request=>request.role==='owner');if(!request)throw new Error('Missing owner request');
  client.decide(client.case('hostPrecondition'),{kind:'retryHost',requestId:request.id});return client;
}

function readyAccepted(client:PublicClient):Effect & {state:Extract<Effect['state'],{kind:'ready'}>} {
  const effect=client.state.effects.find(effect=>effect.state.kind==='ready'&&effect.state.provenance.kind==='accepted');
  if(!effect||effect.state.kind!=='ready')throw new Error(`Missing accepted retry: ${client.context('retry seed')}`);
  return {...effect,state:effect.state};
}
function expectValid(client:PublicClient):void {expect(parseAgenda(client.state).ok,client.context('Publicly produced seed must parse before corruption')).toBe(true);}
function expectInvalid(value:unknown,label:string,client:PublicClient):void {
  const result=parseAgenda(value);expect(result.ok,client.context(label)).toBe(false);
  if(!result.ok){expect(result.error.path.length).toBeGreaterThan(0);expect(result.error.reason.length).toBeGreaterThan(0);}
}

// Boundary-only recursive replacement keeps all identity references coherent, so a
// wrong-kind/ordinal rejection cannot be explained by a newly dangling reference.
function renameBoundary(value:unknown,from:string,to:string):unknown {
  if(typeof value==='string')return value===from?to:value.endsWith(`:${from}`)?`${value.slice(0,-from.length)}${to}`:value;
  if(Array.isArray(value))return value.map(item=>renameBoundary(item,from,to));
  if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,renameBoundary(item,from,to)]));
  return value;
}
function corruptRetry(client:PublicClient,change:(effect:Effect)=>void):Agenda {
  expectValid(client);const copy=structuredClone(client.state);const id=readyAccepted(client).id;
  const effect=copy.effects.find(effect=>effect.id===id);if(!effect)throw new Error('Missing retry copy');change(effect);return copy;
}

describe('public allocation receipts',()=>{
  for(const decision of ['upholdOwner','upholdMain'] as const)test(`${decision} reports newly allocated implementation/design work and excludes adopted objects`,()=>{
    const client=new PublicClient(true);client.finding();
    const observation=client.decide(client.case('findings'),{kind:decision,basis:'The independent finding is upheld'});
    expectCreated(client,observation,['work']);
    if(decision==='upholdMain')expect(allocated(observation.after).filter(ref=>ref.kind==='work'&&!allocated(observation.before).some(old=>old.id===ref.id))).toHaveLength(2);
  });
  test('design amendment includes Main work, amendment and body effect but not the prior owner work',()=>{
    const client=new PublicClient();client.question();
    const observation=client.decide(client.case('claim'),{kind:'amend',amendment:{kind:'designGap',affected:[MEMBER],bodyEdits:[{issue:MEMBER,expectedHash:client.member.contract.bodyHash,body:'Use the explicit design route'}],route:{kind:'withPr',member:MEMBER}}});
    expectCreated(client,observation,['work','amendment','effect']);
  });
  test('split reports its accepted objects but never retroactively adds a later placed unit to the receipt',()=>{
    const client=new PublicClient();client.reply(client.work(),{kind:'claim',claim:{kind:'split',proposal:'Move an independent obligation to its exact existing issue'}});
    const unit=client.state.units.find(unit=>unit.members.some(member=>member.ref.number===MEMBER.number));if(!unit)throw new Error('Missing insertion anchor');
    const observation=client.decide(client.case('claim'),{kind:'split',bodyEdit:{issue:MEMBER,expectedHash:client.member.contract.bodyHash,body:'Only the original implementation obligation remains'},insertions:[{kind:'existing',entry:entry(INSERTED),position:{kind:'after',unitId:unit.id}}]});
    expectCreated(client,observation,['amendment','effect']);
    expect(observation.reply.created.some(ref=>ref.kind==='unit')).toBe(false);
    const effect=client.effect('replaceBody');if(effect.action.kind!=='replaceBody')throw new Error('Expected split body effect');
    const edit=effect.action.edit;client.start(effect);
    const issue=client.facts.issues.find(issue=>issue.ref.number===edit.issue.number);if(!issue)throw new Error('Missing source issue');
    issue.body=edit.body;issue.bodyHash=hash(edit.body);
    client.accept({kind:'effectConfirmed',id:effect.id,attempt:effect.attempt+1,result:{kind:'bodyReplaced',issue:edit.issue,hash:hash(edit.body)}});
    client.observe();
    expect(client.state.units.length).toBe(observation.before.units.length+1);
    const replay=client.invoke(observation.event);expect(replay.kind).toBe('same');if(replay.kind!=='rejected')expect(replay.reply).toEqual(observation.reply);
  });
  test('out-of-scope decision reports draft and creation effect, not its existing gates/requests/case',()=>{
    const client=new PublicClient(true);client.finding();
    expectCreated(client,client.decide(client.case('findings'),{kind:'outOfScope',draft:DRAFT}),['draft','effect']);
  });
  test('a rejected finding allocates nothing in the accepted reply; later fresh gates do not alter its replay',()=>{
    const client=new PublicClient(true);client.finding();
    const observation=client.decide(client.case('findings'),{kind:'reject',basis:'Independent evidence refutes this finding'});
    expect(observation.reply.created,client.context('Rejection must not claim prior identities')).toEqual([]);
    expectCreated(client,observation,[]);
    expect(client.member.review?.id).not.toBe(observation.before.units[0]?.members[0]?.review?.id);
  });
  test('confirmed-delivery retry reports only its new effect and replay retains that original identity',()=>{
    const client=deliveryRetrySeed();const item=client.state.cases.find(item=>item.subject.kind==='hostPrecondition');
    if(!item?.receipt)throw new Error('Missing host retry receipt');
    const created=item.receipt.result.created;
    const old=client.state.effects.find(effect=>effect.state.kind==='confirmed');
    const fresh=readyAccepted(client);
    expect(created,client.context('Confirmed wake retry creates one fresh delivery intention')).toEqual([{kind:'effect',id:fresh.id}]);
    expect(created.some(ref=>ref.id===old?.id)).toBe(false);
    const replay=client.invoke({kind:'reply',caller:MAIN,ticket:item.receipt.ticket,revision:item.receipt.revision,payload:{kind:'decision',decision:{kind:'retryHost',requestId:fresh.action.kind==='wake'?fresh.action.requestId:''}},acceptedAt:client.time++});
    expect(replay.kind).toBe('same');if(replay.kind!=='rejected')expect(replay.reply).toEqual(item.receipt.result);
  });
});

describe('persisted allocation identity boundaries',()=>{
  test('different kind IDs cannot reuse a single global ordinal',()=>{
    const client=new PublicClient();expectValid(client);
    const unit=client.state.units[0];const work=client.member.work;if(!unit||!work)throw new Error('Missing public identities');
    const ordinal=unit.id.split('/').at(-1);
    expectInvalid(renameBoundary(client.state,work.id,`${AGENDA}/work/${ordinal}`),'Distinct unit/work strings must not reuse one global ordinal',client);
  });
  const seeds:[string,()=>PublicClient,DomainRef['kind']][]=[
    ['unit',()=>new PublicClient(),'unit'],['owner work',()=>new PublicClient(),'work'],
    ['gate',()=>new PublicClient(true),'gate'],['request',()=>new PublicClient(),'request'],
    ['case',()=>{const c=new PublicClient();c.question();return c;},'case'],
    ['design work',designSeed,'work'],['amendment',designSeed,'amendment'],
    ['draft',draftSeed,'draft'],['effect',draftSeed,'effect'],
  ];
  for(const [label,seed,kind]of seeds)test(`${label} rejects a coherent reference graph with the wrong allocated kind prefix`,()=>{
    const client=seed();expectValid(client);
    const ref=label==='design work'?client.state.designWorks.map(work=>({kind:'work' as const,id:work.id}))[0]:allocated(client.state).find(ref=>ref.kind===kind);
    if(!ref)throw new Error(`Missing ${label} identity`);
    const badKind=kind==='unit'?'work':'unit';
    expectInvalid(renameBoundary(client.state,ref.id,ref.id.replace(`/${kind}/`,`/${badKind}/`)),`${label} identity prefix must match its domain kind`,client);
  });
});

describe('ready retry provenance boundaries',()=>{
  for(const [label,seed]of [['failed-call retry',callRetrySeed],['unstarted preflight retry',preflightRetrySeed],['absence retry',absenceRetrySeed],['confirmed-delivery retry',deliveryRetrySeed]] as const){
    test(`${label} is a legal public seed and rejects a missing authorization case`,()=>{
      const client=seed();
      const copy=corruptRetry(client,effect=>{if(effect.state.kind==='ready'&&effect.state.provenance.kind==='accepted')effect.state.provenance.caseId=`${AGENDA}/case/${client.state.nextId+10}`;});
      expectInvalid(copy,'Accepted retry must reference the actual retained accepting case',client);
    });
  }
  test('retry case must authorize the exact effect rather than any existing case',()=>{
    const client=preflightRetrySeed();const unrelated=client.state.cases.find(item=>item.subject.kind==='claim');if(!unrelated)throw new Error('Missing unrelated existing case');
    const copy=corruptRetry(client,effect=>{if(effect.state.kind==='ready'&&effect.state.provenance.kind==='accepted')effect.state.provenance.caseId=unrelated.id;});
    expectInvalid(copy,'An existing design claim is not the accepting effectFailure case',client);
  });
  test('accepted authorization cannot masquerade as an initial intention',()=>{
    const client=callRetrySeed();const copy=corruptRetry(client,effect=>{effect.state={kind:'ready',provenance:{kind:'initial'}};});
    expectInvalid(copy,'Retry authorization requires retained acceptance provenance',client);
  });
  test('initial authorization cannot masquerade as an accepted retry',()=>{
    const client=callRetrySeed();const copy=corruptRetry(client,effect=>{effect.authorization='initial';});
    expectInvalid(copy,'Accepted retry provenance cannot pair with initial authorization',client);
  });
  test('call provenance received identity must match the action kind',()=>{
    const client=callRetrySeed();const copy=corruptRetry(client,effect=>{if(effect.state.kind==='ready'&&effect.state.provenance.kind==='accepted'&&effect.state.provenance.previous.kind==='call')effect.state.provenance.previous.received={kind:'issue',issue:MEMBER};});
    expectInvalid(copy,'A publishPr retry cannot retain an issue creation identity',client);
  });
  test('call provenance received identity cannot cross repositories',()=>{
    const client=callRetrySeed();const copy=corruptRetry(client,effect=>{if(effect.state.kind==='ready'&&effect.state.provenance.kind==='accepted'&&effect.state.provenance.previous.kind==='call')effect.state.provenance.previous.received={kind:'pr',pr:{repo:OTHER,number:101}};});
    expectInvalid(copy,'A publishPr retry cannot retain a PR identity from another repository',client);
  });
  test('absence retry cannot retain an actually received issue identity',()=>{
    const client=absenceRetrySeed();const copy=corruptRetry(client,effect=>{if(effect.state.kind==='ready'&&effect.state.provenance.kind==='accepted'&&effect.state.provenance.previous.kind==='call')effect.state.provenance.previous.received={kind:'issue',issue:INSERTED};});
    expectInvalid(copy,'A returned identity makes absence authorization inapplicable',client);
  });
  test('delivery provenance rejects a missing prior effect',()=>{
    const client=deliveryRetrySeed();const copy=corruptRetry(client,effect=>{if(effect.state.kind==='ready'&&effect.state.provenance.kind==='accepted'&&effect.state.provenance.previous.kind==='delivery')effect.state.provenance.previous.effectId=`${AGENDA}/effect/${client.state.nextId+10}`;});
    expectInvalid(copy,'Confirmed delivery retry must retain its actual original effect',client);
  });
  test('delivery provenance cannot refer to the new retry itself',()=>{
    const client=deliveryRetrySeed();const copy=corruptRetry(client,effect=>{if(effect.state.kind==='ready'&&effect.state.provenance.kind==='accepted'&&effect.state.provenance.previous.kind==='delivery')effect.state.provenance.previous.effectId=effect.id;});
    expectInvalid(copy,'The new ready wake is not a confirmed original delivery',client);
  });
  test('call acceptance cannot predate the actual prior call',()=>{
    const client=callRetrySeed();const copy=corruptRetry(client,effect=>{if(effect.state.kind==='ready'&&effect.state.provenance.kind==='accepted'&&effect.state.provenance.previous.kind==='call')effect.state.provenance.acceptedAt=effect.state.provenance.previous.startedAt-1;});
    expectInvalid(copy,'Retried call acceptance must be causally after its original attempt',client);
  });
});
