import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createAgenda, parseAgenda, parsePortInput, tickets, transition} from '../src/domain/index.ts';
import type {Agenda, Caller, CaseDecision, DecisionCase, Effect, EffectResult, Entry, Event, Facts, Inputs, Insertion, IssueRef, IssueSnapshot, Member, ProtocolReply, Ticket} from '../src/domain/index.ts';

const repo = {owner:'SplitAcceptance', name:'obligations'};
const original:IssueRef = {repo, number:1};
const parent:IssueRef = {repo, number:90};
const hash = (body:string):string => createHash('sha256').update(body).digest('hex');
const entry = (number:number):Entry => ({issue:{repo,number}, target:{repo,base:'main'}, designOnly:false, adoptPr:null});
const issue = (number:number, body=`Existing prerequisite ${number}`):IssueSnapshot => ({ref:{repo,number},body,bodyHash:hash(body),updatedAt:100,state:'open',lastClose:null,lastReopen:null,children:[]});
const main:Caller = {agentId:'Main',sessionId:'main-session',parentId:null,runId:'split-run',kind:'main',depth:0};
const owner:Caller = {agentId:'OriginalOwner',sessionId:'owner-session',parentId:'Main',runId:'split-run',kind:'sub',depth:1};

class World {
  state:Agenda;
  facts:Facts;
  input:Inputs;
  trace:string[] = [];
  clock = 1_000;

  constructor(withParent=false, withFuture=false) {
    const body = 'Deliver the original product obligation; split prerequisites do not remove it.';
    this.facts = {viewer:'SplitAcceptance',issues:[issue(1,body),...Array.from({length:7},(_,i)=>issue(i+2))],prs:[],links:[],repos:[{repo,defaultBranch:'main',defaultHead:'a'.repeat(40),bases:[{name:'main',state:{kind:'present',head:'a'.repeat(40),isDefault:true,rules:{required:[],strict:false,upToDate:true,constraints:[]}}}]}],branches:[],maintenance:[],commits:[],checkAttempts:[],createdIssues:[]};
    if(withParent)this.facts.issues.push({...issue(parent.number,'Parent umbrella'),children:[original,...withFuture?[entry(8).issue]:[]]});
    this.input = {facts:{kind:'available',generation:1,observedAt:100,scope:{issues:this.facts.issues.map(item=>item.ref),prs:[],repos:[{repo,bases:['main']}],branches:[],commits:[],checkRuns:[],creations:[]},facts:this.facts},host:{runId:main.runId,main,seats:[],turnEnds:[],preflight:{ok:true,value:{asyncEnabled:true,isolationEnabled:true,asyncManager:true,gitCwd:'/tmp/split-acceptance',agents:[{name:'task:free',blocking:false}]}}},policy:{text:'Preserve the entire original obligation and require all split prerequisites.',ownerAgent:'task:free',gateAgent:'task:free'}};
    const created = createAgenda({op:'convene',mode:'execute',parent:withParent?parent:null,entries:[entry(1),...withFuture?[entry(8)]:[]]},this.facts,100,'32000000-0000-4000-8000-000000000001');
    if(!created.ok)throw new Error(JSON.stringify(created.error));
    this.state=created.value;
    this.settle();
    const request=this.state.requests.find(item=>item.id===this.member(1).ownerRequestId);
    if(!request)throw new Error('Initial runnable owner request missing');
    this.input.host.seats=[{agentId:owner.agentId,requestedName:request.name,parentId:main.agentId,sessionId:owner.sessionId,createdAt:101,status:'running',plan:'disabled',streaming:true}];
    this.reply(this.ticket(`spawn:${request.id}`),{kind:'spawned',agentId:owner.agentId});
  }

  member(number:number):Member {
    const found=this.state.units.flatMap(unit=>unit.members).find(item=>item.ref.number===number);
    if(!found)throw new Error(`Member ${number} missing`);
    return found;
  }
  ticket(id:Ticket['id']):Ticket {
    const found=tickets(this.state,this.input).find(item=>item.id===id);
    if(!found)throw new Error(`Ticket ${id} missing`);
    return found;
  }
  workTicket(number=1):Ticket {
    const work=this.member(number).work;
    if(!work)throw new Error(`Open work for ${number} missing`);
    return this.ticket(`work:${work.id}`);
  }
  step(event:Event) {
    const result=transition(this.state,this.input,event);
    this.trace.push(JSON.stringify({event,result:result.kind,error:result.kind==='rejected'?result.error:null,version:result.kind==='next'?result.state.version:this.state.version}));
    if(result.kind==='next')this.state=result.state;
    return result;
  }
  accept(event:Event):void {
    const result=this.step(event);
    expect(result.kind,`Transition must accept ${event.kind}`).toBe('next');
  }
  settle():void {
    for(let count=0;count<12;count++) {
      const result=this.step({kind:'observe'});
      if(result.kind==='same')return;
      expect(result.kind,'Observation must not reject').toBe('next');
    }
    throw new Error('Observation did not reach a fixed point in 12 transitions; no fair-response edge was added');
  }
  reply(ticket:Ticket,payload:ProtocolReply,caller:Caller=main):void {
    const parsed=parsePortInput({op:'reply',ticket:ticket.id,revision:ticket.revision,reply:payload});
    expect(parsed.ok,'The independent client must send a valid public reply').toBe(true);
    this.accept({kind:'reply',caller,ticket:ticket.id,revision:ticket.revision,payload,acceptedAt:this.clock++});
  }
  split(insertions:[Insertion,...Insertion[]]):{caseId:string;decision:CaseDecision;workId:string} {
    const workId=this.member(1).work!.id;
    this.reply(this.workTicket(),{kind:'claim',claim:{kind:'split',proposal:'Keep the original obligation; register every independent prerequisite in this exact order.'}},owner);
    const item=this.state.cases.find(item=>item.subject.kind==='claim'&&item.subject.claim.kind==='split');
    if(!item)throw new Error('Split claim must create its public case');
    const decision:CaseDecision={kind:'split',bodyEdit:{issue:original,expectedHash:this.facts.issues.find(item=>item.ref.number===1)!.bodyHash,body:'Deliver the retained original product obligation after every explicit split prerequisite.'},insertions};
    this.reply(this.ticket(`case:${item.id}`),{kind:'decision',decision});
    return {caseId:item.id,decision,workId};
  }
  decisionCase(caseId:string):DecisionCase {
    const found=this.state.cases.find(item=>item.id===caseId);
    if(!found)throw new Error(`Case ${caseId} missing`);
    return found;
  }
  effect(id:string):Effect {
    const found=this.state.effects.find(item=>item.id===id);
    if(!found)throw new Error(`Effect ${id} missing`);
    return found;
  }
  bodyEffect():Effect {
    const found=this.state.effects.find(effect=>effect.action.kind==='replaceBody');
    if(!found)throw new Error('Split must atomically create the body replacement intention');
    return found;
  }
  mutate(id:string,result:EffectResult,sourceMutation:()=>void):void {
    const effect=this.effect(id);
    expect(effect.state.kind).toBe('ready');
    const attempt=effect.attempt+1;
    this.accept({kind:'effectStarted',id,attempt,startedAt:this.clock++});
    // The client checkpoints the executing event before simulating the source write.
    // A domain trace is not a claim about filesystem fsync or controller durability.
    const checkpoint=parseAgenda(JSON.parse(JSON.stringify(this.state)));
    expect(checkpoint.ok,'The pre-mutation executing checkpoint must be a valid persisted Agenda').toBe(true);
    if(!checkpoint.ok)throw new Error(JSON.stringify(checkpoint.error));
    this.state=checkpoint.value;
    expect(this.effect(id).state.kind).toBe('executing');
    sourceMutation();
    this.accept({kind:'effectConfirmed',id,attempt,result});
  }
  replaceBody():void {
    const effect=this.bodyEffect();
    if(effect.action.kind!=='replaceBody')throw new Error('Unexpected body action');
    const edit=effect.action.edit;
    this.mutate(effect.id,{kind:'bodyReplaced',issue:edit.issue,hash:hash(edit.body)},()=>{
      const current=this.facts.issues.find(item=>item.ref.number===edit.issue.number)!;
      current.body=edit.body;current.bodyHash=hash(edit.body);current.updatedAt=this.clock++;
    });
  }
  createDraft(index:number,number:number):void {
    const draft=this.state.drafts[index];
    if(!draft)throw new Error(`Draft ${index} missing`);
    this.mutate(draft.creationEffectId,{kind:'created',issue:{repo,number}},()=>{
      this.facts.issues.push(issue(number,draft.spec.body));
      this.facts.createdIssues.push({issue:{repo,number},title:draft.spec.title,body:draft.spec.body,actor:this.facts.viewer,createdAt:this.clock++});
    });
    this.settle();
  }
  attachDraft(index:number):void {
    const draft=this.state.drafts[index];
    if(!draft)throw new Error(`Draft ${index} missing`);
    const effect=this.state.effects.find(effect=>effect.action.kind==='attachChild'&&effect.action.owner.kind==='draft'&&effect.action.owner.draftId===draft.id);
    if(!effect||effect.action.kind!=='attachChild')throw new Error('Registered draft must request its actual parent attachment');
    const action=effect.action;
    this.mutate(effect.id,{kind:'attached',parent:action.parent,child:action.child},()=>this.facts.issues.find(item=>item.ref.number===action.parent.number)!.children.push(action.child));
  }
  attachExisting(number:number):void {
    const effect=this.state.effects.find(effect=>effect.action.kind==='attachChild'&&effect.action.owner.kind==='insertion'&&effect.action.child.number===number);
    if(!effect||effect.action.kind!=='attachChild')throw new Error('Existing insertion must have its own exact parent attachment intent');
    const action=effect.action;
    this.mutate(effect.id,{kind:'attached',parent:action.parent,child:action.child},()=>this.facts.issues.find(item=>item.ref.number===action.parent.number)!.children.push(action.child));
  }
  noCodeAndClose(number:number):void {
    const source=this.facts.issues.find(item=>item.ref.number===number)!;
    this.accept({kind:'mainNoCode',caller:main,member:source.ref,bodyHash:source.bodyHash,reason:`Independent source examination proves prerequisite ${number} already fulfilled; this does not classify the original product obligation.`,acceptedAt:this.clock++});
    this.settle();
    const effect=this.state.effects.find(effect=>effect.action.kind==='setIssueState'&&effect.action.issue.number===number&&effect.state.kind==='ready');
    if(!effect)throw new Error(`No-code member ${number} must reconcile the real issue close`);
    const closed={id:`close-${number}`,at:this.clock+1};
    this.mutate(effect.id,{kind:'issueState',issue:source.ref,open:false,event:closed},()=>{source.state='closed';source.lastClose=closed;});
    this.settle();
  }
}

const existing=(number:number,kind:'before'|'after',unitId:string):Insertion=>({kind:'existing',entry:entry(number),position:{kind,unitId}});
const draft=(label:string,kind:'before'|'after',unitId:string):Insertion=>({kind:'draft',draft:{repo,title:`Split ${label}`,body:`Deliver independent ${label} prerequisite without removing the retained product obligation.`,target:{repo,base:'main'},designOnly:false},position:{kind,unitId}});

function scenario(name:string,body:(world:World)=>void,withParent=false,withFuture=false):void {
  test(name,()=>{
    const world=new World(withParent,withFuture);
    try {body(world);} catch(error) {
      console.error(`SPLIT TRACE ${name}\n${world.trace.join('\n')}\nSTATE ${JSON.stringify(world.state)}`);
      throw error;
    }
    console.log(`SPLIT TRACE ${name}: ${world.trace.length} public transitions; final version ${world.state.version}`);
  });
}

describe('public split decision and complete prerequisite responsibility',()=>{
  scenario('retains the actual mixed split and every insertion in one direct amendment',world=>{
    const anchor=world.state.units[0]!.id;
    const insertions:[Insertion,...Insertion[]]=[existing(2,'before',anchor),draft('first','before',anchor),draft('second','after',anchor)];
    const split=world.split(insertions);
    const item=world.decisionCase(split.caseId);
    expect(item.state.kind).toBe('applying');
    if(item.state.kind!=='applying')throw new Error('Split has required external children');
    expect(world.state.amendments).toHaveLength(1);
    const amendment=world.state.amendments[0]!;
    expect(amendment.state.kind).toBe('pending');
    if(amendment.state.kind!=='pending')throw new Error('Body and both issue creations are not confirmed');
    const existingIntent=insertions[0];if(existingIntent.kind!=='existing')throw new Error('This scenario starts with an exact existing insertion');
    expect({decision:item.state.decision,required:item.state.required,insertions:amendment.state.insertions}).toEqual({
      decision:split.decision,
      required:[{kind:'amendment',id:amendment.id}],
      insertions:[existingIntent,...world.state.drafts.map(item=>({kind:'draft' as const,draftId:item.id}))],
    });
    expect(world.state.drafts).toHaveLength(2);
    expect(world.member(1).work!.id).toBe(split.workId);
    expect(world.member(1).terminal).toEqual({kind:'pending'});
    expect(world.workTicket().runDisposition).toBe('mayWait');
  });

  scenario('places the whole mixed group only after the final body/create/attach confirmation',world=>{
    const anchor=world.state.units[0]!.id;
    const split=world.split([existing(2,'before',anchor),draft('first','before',anchor),draft('second','after',anchor)]);
    const noPartialPlacement=()=>{
      expect(world.state.units.flatMap(unit=>unit.members.map(item=>item.ref.number))).toEqual([1]);
      expect(world.state.drafts.every(item=>item.state.kind!=='placed')).toBe(true);
      expect(world.decisionCase(split.caseId).state.kind).toBe('applying');
      expect(world.state.amendments[0]!.state.kind).toBe('pending');
      expect(world.member(1).work!.id).toBe(split.workId);
      expect(world.workTicket().runDisposition).toBe('mayWait');
    };
    noPartialPlacement();
    world.replaceBody();world.settle();noPartialPlacement();
    world.createDraft(0,101);noPartialPlacement();
    world.attachDraft(0);world.settle();noPartialPlacement();
    world.createDraft(1,102);noPartialPlacement();
    // The last attachment remains a durable ready intention: no implicit fairness.
    expect(world.state.effects.some(effect=>effect.action.kind==='attachChild'&&effect.action.child.number===102&&effect.state.kind==='ready')).toBe(true);
    world.settle();noPartialPlacement();
    world.attachDraft(1);world.settle();
    noPartialPlacement();
    world.attachExisting(2);world.settle();
    expect(world.state.units.map(unit=>unit.members.map(item=>item.ref.number))).toEqual([[2,101,1],[102]]);
    expect(world.state.drafts.every(item=>item.state.kind==='placed')).toBe(true);
    expect(world.state.amendments[0]!.state.kind).toBe('effective');
    expect(world.decisionCase(split.caseId).state).toEqual({kind:'resolved',result:split.decision});
    expect(world.member(1).work!.id).toBe(split.workId);
    expect(world.member(1).terminal.kind).toBe('pending');
    expect(world.workTicket().runDisposition).toBe('mayWait');
  },true);

  scenario('holds original WorkId on both before prerequisites until both source termini',world=>{
    const anchor=world.state.units[0]!.id;
    const split=world.split([existing(2,'before',anchor),existing(3,'before',anchor)]);
    world.replaceBody();world.settle();
    expect(world.state.units[0]!.members.map(item=>item.ref.number)).toEqual([2,3,1]);
    expect(world.member(1).work!.holds.flatMap(hold=>hold.kind==='dependency'?[hold.member.number]:[]).sort()).toEqual([2,3]);
    expect(world.member(1).work!.id).toBe(split.workId);
    expect(world.workTicket().runDisposition).toBe('mayWait');
    // End the immediate predecessor first. A second, still-live prerequisite cannot disappear.
    world.noCodeAndClose(3);
    expect(world.member(3).terminal.kind).toBe('noCode');
    expect(world.member(2).terminal.kind).toBe('pending');
    expect(world.member(1).terminal.kind).toBe('pending');
    expect(world.member(1).work!.id).toBe(split.workId);
    expect(world.workTicket().runDisposition).toBe('mayWait');
    const current=world.workTicket();
    const branch='retained-original';
    world.facts.branches.push({repo,name:branch,state:{kind:'present',head:'b'.repeat(40)}});
    const prematureSubmit=world.step({kind:'reply',caller:owner,ticket:current.id,revision:current.revision,payload:{kind:'submit',branch,head:'b'.repeat(40),title:'Retained product delivery',body:'Delivers the retained product obligation.\n\nCloses #1',template:'fourLayer',retryNote:null},acceptedAt:world.clock++});
    expect(prematureSubmit.kind).toBe('rejected');
    if(prematureSubmit.kind==='rejected')expect(prematureSubmit.error.kind).toBe('pendingClaim');
    expect(world.member(1).work!.id).toBe(split.workId);
    expect(world.state.effects.some(effect=>effect.action.kind==='merge'||effect.action.kind==='publishPr')).toBe(false);
    expect(world.member(1).review).toBeNull();expect(world.member(1).accept).toBeNull();
    const heldRevision=world.member(1).work!.contentVersion;
    world.settle();
    expect(world.workTicket().runDisposition).toBe('mayWait');
    world.noCodeAndClose(2);
    expect(world.member(1).work!.id).toBe(split.workId);
    expect(world.member(1).work!.contentVersion).toBe(heldRevision+1);
    expect(world.workTicket().runDisposition).toBe('mustRun');
    expect(world.member(1).terminal.kind).toBe('pending');
    expect(world.state.units[0]!.postMerge).toBeNull();
  });

  scenario('preserves deterministic input order before and after a future anchor',world=>{
    const anchor=world.state.units[1]!.id;
    const split=world.split([existing(2,'before',anchor),draft('before','before',anchor),existing(3,'after',anchor),draft('after','after',anchor)]);
    world.replaceBody();world.settle();
    expect(world.state.units.map(unit=>unit.members.map(item=>item.ref.number))).toEqual([[1],[8]]);
    // Resolve draft creations in reverse order; placement follows accepted input, not completion order.
    world.createDraft(1,102);
    expect(world.state.units.map(unit=>unit.members.map(item=>item.ref.number))).toEqual([[1],[8]]);
    world.createDraft(0,101);world.settle();
    expect(world.state.units.map(unit=>unit.members.map(item=>item.ref.number))).toEqual([[1],[2],[101],[8],[3],[102]]);
    expect(world.decisionCase(split.caseId).state).toEqual({kind:'resolved',result:split.decision});
    expect(world.member(1).work!.id).toBe(split.workId);
    expect(world.member(1).terminal.kind).toBe('pending');
  },false,true);

  scenario('confirms already fulfilled queryable body with effectSatisfied and no invented attempt',world=>{
    const split=world.split([existing(2,'before',world.state.units[0]!.id),existing(3,'before',world.state.units[0]!.id)]);
    const effect=world.bodyEffect();
    if(effect.action.kind!=='replaceBody')throw new Error('Expected body replacement');
    const source=world.facts.issues.find(item=>item.ref.number===1)!;
    source.body=effect.action.edit.body;source.bodyHash=hash(source.body);
    const started=world.step({kind:'effectStarted',id:effect.id,attempt:1,startedAt:world.clock++});
    expect(started.kind).toBe('rejected');
    if(started.kind==='rejected')expect(started.error.kind).toBe('premiseChanged');
    expect(world.effect(effect.id).attempt).toBe(0);
    expect(world.effect(effect.id).state.kind).toBe('ready');
    world.accept({kind:'effectSatisfied',id:effect.id,result:{kind:'bodyReplaced',issue:original,hash:source.bodyHash}});
    expect(world.effect(effect.id).attempt).toBe(0);
    expect(world.effect(effect.id).state.kind).toBe('confirmed');
    world.settle();
    expect(world.decisionCase(split.caseId).state).toEqual({kind:'resolved',result:split.decision});
    expect(world.member(1).work!.id).toBe(split.workId);
    expect(world.workTicket().runDisposition).toBe('mayWait');
  });
});
