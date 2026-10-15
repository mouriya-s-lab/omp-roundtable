import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createAgenda, parseAgenda, tickets, transition} from '../src/domain/index.ts';
import type {Agenda, AmendmentIntent, Caller, CaseDecision, DecisionCase, DraftSpec, Effect, Entry, Event, Facts, Inputs, Insertion, IssueRef, ProtocolReply, Receipt, Ticket} from '../src/domain/index.ts';

const repo = {owner:'acceptance', name:'provenance'};
const target = {repo, base:'main'};
const main:Caller = {agentId:'main', sessionId:'main-session', parentId:null, runId:'provenance-run', kind:'main', depth:0};
const head = 'a'.repeat(40);
const issue = (number:number):IssueRef => ({repo, number});
const entry = (number:number):Entry => ({issue:issue(number), target, designOnly:false, adoptPr:null});
const hash = (value:string):string => createHash('sha256').update(value).digest('hex');
function canonical(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Only serialized protocol values have digests');
  return encoded;
}
const digest = (value:ProtocolReply):string => hash(canonical(value));
function required<T>(value:T|null|undefined, label:string):T {
  if (value === null || value === undefined) throw new Error(`Missing ${label}`);
  return value;
}
function pending(amendment:AmendmentIntent) {
  if (amendment.state.kind !== 'pending') throw new Error(`Expected pending amendment, got ${amendment.state.kind}`);
  return amendment.state;
}
function applying(item:DecisionCase) {
  if (item.state.kind !== 'applying') throw new Error(`Expected applying case, got ${item.state.kind}`);
  return item.state;
}
function bodyEffect(effect:Effect) {
  if (effect.action.kind !== 'replaceBody') throw new Error('Expected replacement effect');
  return effect.action;
}

class Fixture {
  facts:Facts = {
    viewer:'acceptance',
    issues:[1,2,3,4,90].map(number=>({ref:issue(number), body:`contract ${number}`, bodyHash:hash(`contract ${number}`), updatedAt:10, state:'open', lastClose:null, lastReopen:null, children:number===90?[issue(1),issue(2)]:[]})),
    prs:[], links:[],
    repos:[{repo, defaultBranch:'main', defaultHead:head, bases:[{name:'main', state:{kind:'present', head, isDefault:true, rules:{required:[], strict:false, upToDate:false, constraints:[]}}}]}],
    branches:[], maintenance:[], commits:[], checkAttempts:[], createdIssues:[],
  };
  host:Inputs['host'] = {runId:main.runId, main, seats:[], turnEnds:[], preflight:{ok:true,value:{asyncEnabled:true,isolationEnabled:true,asyncManager:true,gitCwd:'/tmp/provenance-acceptance',agents:[{name:'task:high',blocking:false},{name:'task:mid',blocking:false}]}}};
  state:Agenda;
  time = 100;
  constructor() {
    const result=createAgenda({op:'convene',mode:'execute',parent:issue(90),entries:[entry(1),entry(2)]},this.facts,10,'7b648f9d-ecda-4f86-b35d-f58e36b215dd');
    if (!result.ok) throw new Error(`Convene rejected: ${result.error.kind}: ${result.error.message}`);
    this.state=result.value;
    this.event({kind:'observe'});
  }
  get input():Inputs {
    return {facts:{kind:'available',generation:1,observedAt:this.time,scope:{issues:this.facts.issues.map(snapshot=>snapshot.ref),prs:[],repos:[{repo,bases:['main']}],branches:[],commits:this.facts.commits.map(({repo,ancestor,descendant})=>({repo,ancestor,descendant})),checkRuns:[],creations:[]},facts:this.facts},host:this.host,policy:{text:'Independent acceptance policy',ownerAgent:'task:high',gateAgent:'task:mid'}};
  }
  event(event:Event) {
    const result=transition(this.state,this.input,event);
    if (result.kind==='rejected') throw new Error(`${event.kind} rejected: ${result.error.kind}: ${result.error.message}`);
    if (result.kind==='next') this.state=result.state;
    return result.reply;
  }
  ticket(id:string):Ticket {return required(tickets(this.state,this.input).find(ticket=>ticket.id===id),id);}
  reply(ticket:Ticket,payload:ProtocolReply,caller:Caller=main) {
    return required(this.event({kind:'reply',caller,ticket:ticket.id,revision:ticket.revision,payload,acceptedAt:++this.time}),'reply result');
  }
  claim(kind:'split'|'question'):DecisionCase {
    const request=required(this.state.requests.find(request=>request.role==='owner'),'owner request');
    const owner:Caller={agentId:'owner',sessionId:'owner-session',parentId:main.agentId,runId:main.runId,kind:'sub',depth:1};
    this.host={...this.host,seats:[{agentId:owner.agentId,sessionId:owner.sessionId,parentId:main.agentId,requestedName:request.name,createdAt:20,status:'idle',plan:'disabled',streaming:false}]};
    this.reply(this.ticket(`spawn:${request.id}`),{kind:'spawned',agentId:owner.agentId});
    const work=required(this.state.units[0]?.members[0]?.work,'initial owner work');
    this.reply(this.ticket(`work:${work.id}`),{kind:'claim',claim:kind==='split'?{kind:'split',proposal:'Keep the original contract and transfer independent work'}:{kind:'question',reproduction:'Two body contracts disagree',readings:['Keep old clauses','Adopt new clauses'],earliestGap:'Contract scope',proposal:'Main must amend both exact affected issues'}},owner);
    return required(this.state.cases.find(item=>item.subject.kind==='claim'),'claim case');
  }
  decide(caseId:string,decision:CaseDecision) {
    return this.reply(this.ticket(`case:${caseId}`),{kind:'decision',decision});
  }
  setBody(ref:IssueRef,body:string) {
    const source=required(this.facts.issues.find(snapshot=>snapshot.ref.number===ref.number),'issue source');
    source.body=body;source.bodyHash=hash(body);source.updatedAt=++this.time;
  }
  failBody(effectId:string,conflict=false) {
    const effect=required(this.state.effects.find(effect=>effect.id===effectId),'body effect');
    if (conflict) {
      this.setBody(bodyEffect(effect).edit.issue,'External Main-compatible revision');
      this.event({kind:'effectFailed',id:effect.id,attempt:effect.attempt,error:{kind:'precondition',message:'Source body changed before write'},outcome:'knownFailed'});
    } else {
      this.event({kind:'effectStarted',id:effect.id,attempt:effect.attempt+1,startedAt:++this.time});
      const started=required(this.state.effects.find(item=>item.id===effectId),'started effect');
      this.event({kind:'effectFailed',id:effectId,attempt:started.attempt,error:{kind:'permission',message:'Write rejected before mutation'},outcome:'knownFailed'});
    }
    return required(this.state.cases.find(item=>item.subject.kind==='effectFailure'&&item.subject.effectId===effectId),'failure case');
  }
  confirmBody(effectId:string) {
    const effect=required(this.state.effects.find(effect=>effect.id===effectId),'ready body effect');
    const action=bodyEffect(effect);
    this.event({kind:'effectStarted',id:effectId,attempt:effect.attempt+1,startedAt:++this.time});
    this.setBody(action.edit.issue,action.edit.body);
    const current=required(this.state.effects.find(item=>item.id===effectId),'executing effect');
    this.event({kind:'effectConfirmed',id:effectId,attempt:current.attempt,result:{kind:'bodyReplaced',issue:action.edit.issue,hash:hash(action.edit.body)}});
  }
}

function draftSpec(label:string):DraftSpec {return {repo,title:`Transferred ${label}`,body:`Independent obligation ${label}`,target,designOnly:false};}
function splitFixture() {
  const f=new Fixture();const claim=f.claim('split');
  const anchor=required(f.state.units[0],'anchor').id;
  const insertions:Insertion[]=[
    {kind:'existing',entry:entry(3),position:{kind:'before',unitId:anchor}},
    {kind:'draft',draft:draftSpec('A'),position:{kind:'after',unitId:anchor}},
    {kind:'existing',entry:entry(4),position:{kind:'after',unitId:anchor}},
    {kind:'draft',draft:draftSpec('B'),position:{kind:'correctionOf',unitId:anchor}},
  ];
  const decision:CaseDecision={kind:'split',bodyEdit:{issue:issue(1),expectedHash:hash('contract 1'),body:'Original narrowed obligation'},insertions};
  const result=f.decide(claim.id,decision);
  return {f,caseId:claim.id,decision,result,amendment:required(f.state.amendments[0],'split amendment')};
}
function designFixture() {
  const f=new Fixture();const claim=f.claim('question');
  const decision:CaseDecision={kind:'amend',amendment:{kind:'designGap',affected:[issue(1),issue(2)],bodyEdits:[{issue:issue(1),expectedHash:hash('contract 1'),body:'Revised first obligation'},{issue:issue(2),expectedHash:hash('contract 2'),body:'Revised second obligation'}],route:{kind:'withPr',member:issue(1)}}};
  const result=f.decide(claim.id,decision);
  return {f,caseId:claim.id,decision,result,amendment:required(f.state.amendments[0],'design amendment')};
}
function retryFixture() {
  const context=designFixture();
  const effectId=required(pending(context.amendment).requiredEffectIds[0],'first body effect');
  const failure=context.f.failBody(effectId);
  const effect=required(context.f.state.effects.find(effect=>effect.id===effectId),'failed effect');
  const decision:CaseDecision={kind:'retry',effectId,attempt:effect.attempt};
  const result=context.f.decide(failure.id,decision);
  return {...context,effectId,failureId:failure.id,retryDecision:decision,retryResult:result};
}
function rejectsMutation(state:Agenda,mutate:(copy:Agenda)=>void) {
  expect(parseAgenda(state).ok).toBe(true);
  const copy=structuredClone(state);
  mutate(copy);
  const result=parseAgenda(copy);
  expect(result.ok).toBe(false);
  if (!result.ok) {expect(result.error.path.length).toBeGreaterThan(0);expect(result.error.reason.length).toBeGreaterThan(0);}
}
function exactReceipt(receipt:Receipt,item:DecisionCase,decision:CaseDecision,state:Agenda) {
  expect(receipt.ticket).toBe(`case:${item.id}`);
  expect(receipt.revision).toBe(item.contentVersion);
  expect(receipt.digest).toBe(digest({kind:'decision',decision}));
  expect(receipt.result.ticket).toBe(receipt.ticket);
  expect(receipt.result.outcome).toBe('accepted');
  expect(receipt.result.acceptedVersion).toBeGreaterThan(0);
  expect(receipt.result.acceptedVersion).toBeLessThanOrEqual(state.version);
}

describe('accepted amendment provenance through public lifecycle',()=>{
  test('split binds the accepted Main decision, receipt, ordered mixed insertions, exact drafts and every required effect',()=>{
    const {f,caseId,decision,result,amendment}=splitFixture();
    const item=required(f.state.cases.find(item=>item.id===caseId),'split case');
    expect(applying(item)).toEqual({kind:'applying',decision,required:[{kind:'amendment',id:amendment.id}]});
    exactReceipt(required(item.receipt,'split receipt'),item,decision,f.state);
    expect(item.receipt?.result).toEqual(result);
    expect(amendment.caseId).toBe(caseId);expect(amendment.affected).toEqual([issue(1)]);
    if (decision.kind!=='split') throw new Error('Split decision missing');
    expect(pending(amendment).bodyEdits).toEqual([decision.bodyEdit]);
    expect(pending(amendment).designWork).toBeNull();
    expect(pending(amendment).insertions).toEqual(decision.insertions.map(insertion=>insertion.kind==='existing'?insertion:{kind:'draft',draftId:required(f.state.drafts.find(draft=>draft.spec.title===insertion.draft.title),'draft').id}));
    for (const insertion of decision.insertions) if (insertion.kind==='draft') {
      const draft=required(f.state.drafts.find(draft=>draft.spec.title===insertion.draft.title),'exact draft');
      expect(draft.spec).toEqual(insertion.draft);expect(draft.position).toEqual(insertion.position);expect(draft.caseId).toBe(caseId);
    }
    const effects=pending(amendment).requiredEffectIds.map(id=>required(f.state.effects.find(effect=>effect.id===id),'required effect'));
    expect(effects.map(effect=>effect.action)).toEqual([
      {kind:'replaceBody',amendmentId:amendment.id,edit:decision.bodyEdit},
      ...decision.insertions.filter(insertion=>insertion.kind==='existing').map(insertion=>({kind:'attachChild' as const,owner:{kind:'insertion' as const,caseId,insertion},parent:issue(90),child:insertion.entry.issue})),
    ]);
    expect(parseAgenda(f.state)).toEqual({ok:true,value:f.state});
  });

  const splitMutations:{name:string;mutate:(state:Agenda)=>void}[]=[
    {name:'missing accepted applying decision',mutate:s=>{required(s.cases.find(c=>c.id===s.amendments[0]?.caseId),'case').state={kind:'open'};}},
    {name:'missing accepted receipt',mutate:s=>{required(s.cases.find(c=>c.id===s.amendments[0]?.caseId),'case').receipt=null;}},
    {name:'different original split decision',mutate:s=>{const decision=applying(required(s.cases.find(c=>c.id===s.amendments[0]?.caseId),'case')).decision;if(decision.kind==='split')decision.bodyEdit.body='Unauthorized replacement';}},
    {name:'unrelated affected member',mutate:s=>{required(s.amendments[0],'amendment').affected=[issue(2)];}},
    {name:'missing insertion',mutate:s=>{pending(required(s.amendments[0],'amendment')).insertions.pop();}},
    {name:'reordered mixed insertions',mutate:s=>{pending(required(s.amendments[0],'amendment')).insertions.reverse();}},
    {name:'unrelated existing child entry',mutate:s=>{const insertion=pending(required(s.amendments[0],'amendment')).insertions.find(i=>i.kind==='existing');if(insertion?.kind==='existing')insertion.entry={...insertion.entry,designOnly:true};}},
    {name:'unrelated draft child',mutate:s=>{const refs=pending(required(s.amendments[0],'amendment')).insertions;const drafts=refs.filter(i=>i.kind==='draft');required(drafts[0],'first draft ref').draftId=required(drafts[1],'second draft ref').draftId;}},
    {name:'different draft specification',mutate:s=>{const draft=required(s.drafts[0],'draft');draft.spec={...draft.spec,body:'Unrelated child obligation'};}},
    {name:'different draft position',mutate:s=>{required(s.drafts[0],'draft').position={kind:'outsideAgenda'};}},
    {name:'missing required body effect',mutate:s=>{pending(required(s.amendments[0],'amendment')).requiredEffectIds.shift();}},
    {name:'unrelated existing creation effect as body reference',mutate:s=>{pending(required(s.amendments[0],'amendment')).requiredEffectIds[0]=required(s.drafts[0],'draft').creationEffectId;}},
    {name:'different body target in both pending edit and effect',mutate:s=>{const amendment=required(s.amendments[0],'amendment');const state=pending(amendment);const id=required(state.requiredEffectIds[0],'body id');state.bodyEdits[0]={...required(state.bodyEdits[0],'edit'),body:'Unaccepted target'};const action=bodyEffect(required(s.effects.find(e=>e.id===id),'effect'));action.edit={...action.edit,body:'Unaccepted target'};}},
  ];
  for(const {name,mutate} of splitMutations)test(`rejects ${name}`,()=>{const {f}=splitFixture();rejectsMutation(f.state,mutate);});

  test('rejects a draft rebound to another real case',()=>{
    const {f,amendment}=splitFixture();
    const failure=f.failBody(required(pending(amendment).requiredEffectIds[0],'body effect'));
    rejectsMutation(f.state,s=>{required(s.drafts[0],'draft').caseId=failure.id;});
  });

  for(const kind of ['existing','draft'] as const)test(`acceptanceMethod amend preserves its exact ${kind} transfer`,()=>{
    const f=new Fixture();const claim=f.claim('question');
    const position={kind:'after' as const,unitId:required(f.state.units[0],'anchor').id};
    const transfer:Insertion=kind==='existing'?{kind:'existing',entry:entry(3),position}:{kind:'draft',draft:draftSpec('acceptance transfer'),position};
    const decision:CaseDecision={kind:'amend',amendment:{kind:'acceptanceMethod',affected:[issue(1)],bodyEdits:[{issue:issue(1),expectedHash:hash('contract 1'),body:'Transferred acceptance method'}],transfer}};
    f.decide(claim.id,decision);
    const amendment=required(f.state.amendments[0],'amendment');
    const item=required(f.state.cases.find(item=>item.id===claim.id),'accepted case');
    expect(applying(item)).toEqual({kind:'applying',decision,required:[{kind:'amendment',id:amendment.id}]});
    exactReceipt(required(item.receipt,'amend receipt'),item,decision,f.state);
    if(decision.kind!=='amend')throw new Error('Missing amendment decision');
    expect(amendment.affected).toEqual(decision.amendment.affected);
    expect(pending(amendment).bodyEdits).toEqual(decision.amendment.bodyEdits);
    expect(pending(amendment).designWork).toBeNull();
    expect(pending(amendment).insertions).toEqual(transfer.kind==='existing'?[transfer]:[{kind:'draft',draftId:required(f.state.drafts[0],'draft').id}]);
    expect(parseAgenda(f.state)).toEqual({ok:true,value:f.state});
    rejectsMutation(f.state,s=>{pending(required(s.amendments[0],'amendment')).insertions=[];});
  });

  test('design amendment binds affected members, exact edits and design route to its accepted decision',()=>{
    const {f,caseId,decision,amendment}=designFixture();
    if(decision.kind!=='amend'||decision.amendment.kind!=='designGap')throw new Error('Expected design amendment');
    const item=required(f.state.cases.find(item=>item.id===caseId),'case');
    exactReceipt(required(item.receipt,'amend receipt'),item,decision,f.state);
    expect(applying(item).decision).toEqual(decision);
    expect(amendment.affected).toEqual(decision.amendment.affected);
    expect(pending(amendment).bodyEdits).toEqual(decision.amendment.bodyEdits);
    expect(pending(amendment).insertions).toEqual([]);
    const work=required(f.state.designWorks.find(work=>work.id===pending(amendment).designWork),'design work');
    expect(work.parentCaseId).toBe(caseId);expect(work.affected).toEqual(decision.amendment.affected);expect(work.route).toEqual(decision.amendment.route);
    expect(pending(amendment).requiredEffectIds.map(id=>bodyEffect(required(f.state.effects.find(effect=>effect.id===id),'body effect')))).toEqual(decision.amendment.bodyEdits.map(edit=>({kind:'replaceBody',amendmentId:amendment.id,edit})));
    expect(parseAgenda(f.state).ok).toBe(true);
  });
  test('rejects a design route changed consistently in work but not accepted Main decision',()=>{
    const {f}=designFixture();rejectsMutation(f.state,s=>{required(s.designWorks[0],'design work').route={kind:'defaultFirst',repo};});
  });
  test('rejects reordered affected members rather than silently rebinding design responsibility',()=>{
    const {f}=designFixture();rejectsMutation(f.state,s=>{const amendment=required(s.amendments[0],'amendment');const work=required(s.designWorks[0],'work');amendment.affected=[...amendment.affected].reverse();work.affected=[...work.affected].reverse();});
  });
  test('rejects a missing design child',()=>{const {f}=designFixture();rejectsMutation(f.state,s=>{pending(required(s.amendments[0],'amendment')).designWork=null;});});
});

describe('accepted ready retry receipt provenance',()=>{
  test('ready retry has the exact current accepted case decision and receipt',()=>{
    const {f,effectId,failureId,retryDecision,retryResult}=retryFixture();
    const effect=required(f.state.effects.find(effect=>effect.id===effectId),'retry effect');
    const item=required(f.state.cases.find(item=>item.id===failureId),'retry case');
    expect(effect.authorization).toBe('retry');
    expect(effect.state.kind).toBe('ready');
    if(effect.state.kind!=='ready'||effect.state.provenance.kind!=='accepted')throw new Error('Missing accepted retry provenance');
    expect(effect.state.provenance.caseId).toBe(item.id);
    expect(applying(item)).toEqual({kind:'applying',decision:retryDecision,required:[{kind:'effect',effectId}]});
    const receipt=required(item.receipt,'retry receipt');exactReceipt(receipt,item,retryDecision,f.state);
    expect(receipt.result).toEqual(retryResult);expect(receipt.result.acceptedVersion).toBe(f.state.version);
    expect(parseAgenda(f.state)).toEqual({ok:true,value:f.state});
  });
  const receiptMutations:{name:string;mutate:(receipt:Receipt,item:DecisionCase,state:Agenda)=>void}[]=[
    {name:'foreign old nonnull receipt',mutate:(receipt,_item,state)=>{Object.assign(receipt,required(state.cases.find(item=>item.subject.kind==='claim')?.receipt,'older accepted amendment receipt'));}},
    {name:'foreign case ticket',mutate:receipt=>{receipt.ticket='case:foreign';}},
    {name:'stale case revision',mutate:receipt=>{receipt.revision++;}},
    {name:'unrelated payload digest',mutate:receipt=>{receipt.digest=digest({kind:'decision',decision:{kind:'answer',basis:'Not a retry'}});}},
    {name:'changed current retry decision',mutate:(_receipt,item)=>{const decision=applying(item).decision;if(decision.kind==='retry')decision.attempt++;}},
    {name:'foreign result ticket',mutate:receipt=>{receipt.result.ticket='case:foreign';}},
    {name:'nonaccepted result outcome',mutate:receipt=>{receipt.result.outcome='claimOpened';}},
    {name:'accepted version beyond current state',mutate:(receipt,_item,state)=>{receipt.result.acceptedVersion=state.version+1;}},
  ];
  for(const {name,mutate} of receiptMutations)test(`rejects ${name}`,()=>{
    const {f,failureId}=retryFixture();rejectsMutation(f.state,s=>{const item=required(s.cases.find(item=>item.id===failureId),'retry case');mutate(required(item.receipt,'retry receipt'),item,s);});
  });
});

test('valid rebaseEdit preserves original Main amendment decision across retry confirmation and effectiveness',()=>{
  const {f,caseId,decision,amendment}=designFixture();
  const originalReceipt=structuredClone(required(f.state.cases.find(item=>item.id===caseId)?.receipt,'original receipt'));
  const ids=[...pending(amendment).requiredEffectIds];const firstId=required(ids[0],'first body effect');const secondId=required(ids[1],'second body effect');
  const originalSecond=structuredClone(required(pending(amendment).bodyEdits[1],'second edit'));
  const failed=f.failBody(firstId,true);
  const revisedBody='Rebased first obligation preserving external edits';
  const rebase:CaseDecision={kind:'rebaseEdit',effectId:firstId,expectedHash:hash('External Main-compatible revision'),body:revisedBody};
  f.decide(failed.id,rebase);
  const originalCase=required(f.state.cases.find(item=>item.id===caseId),'original Main case');
  expect(applying(originalCase).decision).toEqual(decision);expect(originalCase.receipt).toEqual(originalReceipt);
  const currentAmendment=required(f.state.amendments.find(item=>item.id===amendment.id),'current amendment');
  expect(pending(currentAmendment).bodyEdits).toEqual([{issue:issue(1),expectedHash:rebase.expectedHash,body:revisedBody},originalSecond]);
  expect(bodyEffect(required(f.state.effects.find(effect=>effect.id===firstId),'rebased effect')).edit).toEqual(required(pending(currentAmendment).bodyEdits[0],'current rebased edit'));
  expect(parseAgenda(f.state)).toEqual({ok:true,value:f.state});
  f.confirmBody(firstId);
  expect(parseAgenda(f.state)).toEqual({ok:true,value:f.state});
  f.confirmBody(secondId);
  const design=required(f.state.designWorks[0],'design work');
  f.facts.branches.push({repo,name:'accepted-design',state:{kind:'present',head:'d'.repeat(40)}});
  f.reply(f.ticket(`work:${design.id}`),{kind:'designCommit',commit:{repo,sha:'d'.repeat(40)}});
  f.event({kind:'observe'});
  const effective=required(f.state.amendments.find(item=>item.id===amendment.id),'effective amendment');
  expect(effective.state.kind).toBe('effective');
  const finalCase=required(f.state.cases.find(item=>item.id===caseId),'final Main case');
  expect(finalCase.state).toEqual({kind:'resolved',result:decision});expect(finalCase.receipt).toEqual(originalReceipt);
  expect(required(f.state.units[0]?.members[0],'first member').contract.body).toBe(revisedBody);
  expect(required(f.state.units[1]?.members[0],'second member').contract.body).toBe(originalSecond.body);
  expect(parseAgenda(f.state)).toEqual({ok:true,value:f.state});
});
