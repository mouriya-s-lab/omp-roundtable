import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createAgenda, parseAgenda, parsePortInput, tickets, transition} from '../src/domain/index.ts';
import type {Agenda, Caller, CaseDecision, DecisionCase, Effect, EffectResult, Event, Facts, GateJob, HostSeat, Inputs, Insertion, IssueRef, IssueSnapshot, Member, ProtocolReply, Ticket, Transition} from '../src/domain/index.ts';

// Independent source/registry fixtures: no author fixtures or transition internals.
const repo = {owner:'FindingAcceptance', name:'terminal-transfer'};
const target = {repo, base:'main'};
const original:IssueRef = {repo, number:11};
const parent:IssueRef = {repo, number:10};
const correction:IssueRef = {repo, number:12};
const adopted:IssueRef = {repo, number:21};
const correctionPr:IssueRef = {repo, number:22};
const sha = (digit:string):string => digit.repeat(40);
const head = sha('a');
const originalMerge = sha('b');
const correctionHead = sha('c');
const correctionMerge = sha('d');
const hash = (body:string):string => createHash('sha256').update(body).digest('hex');
const sameRef = (left:IssueRef, right:IssueRef):boolean => left.repo.owner===right.repo.owner && left.repo.name===right.repo.name && left.number===right.number;
const must = <T>(value:T|undefined|null, label:string):T => {
  if(value===undefined || value===null) throw new Error(`Missing ${label}`);
  return value;
};
const issue = (ref:IssueRef, body:string):IssueSnapshot => ({ref, body, bodyHash:hash(body), updatedAt:1000, state:'open', lastClose:null, lastReopen:null, children:[]});
const correctionSpec = {repo, title:'Repair the accepted independent finding', body:'The valid original finding must be implemented and independently verified.', target, designOnly:false};

type TraceRow = {event:Event; result:string; version:number; cases:readonly {id:string; subject:string; state:string}[]; effects:readonly {id:string; action:string; state:string; attempt:number}[]};
class Scenario {
  state:Agenda;
  facts:Facts;
  seats:HostSeat[] = [];
  readonly trace:TraceRow[] = [];
  readonly main:Caller = {agentId:'finding-main', sessionId:'finding-main-session', parentId:null, runId:'finding-run', kind:'main', depth:0};
  time = 1100;

  constructor() {
    const sourceParent = issue(parent, 'Deliver original and all required corrections.');
    sourceParent.children = [original];
    this.facts = {
      viewer:'FindingAcceptance', issues:[sourceParent, issue(original, 'The implementation must preserve the documented behavior.')],
      prs:[{ref:adopted, headRepo:repo, headBranch:'authorized-adoption', head, target, title:'Authorized original implementation', body:'Closes #11', bodyHash:hash('Closes #11'), updatedAt:1000, state:{kind:'open'}, closes:[original], mergeable:'yes', checks:{kind:'passing',required:[]}}],
      links:[{issue:original, pr:adopted}],
      repos:[{repo, defaultBranch:'main', defaultHead:sha('1'), bases:[{name:'main', state:{kind:'present',head:sha('1'),isDefault:true,rules:{required:[],strict:false,upToDate:true,constraints:[]}}},{name:'release',state:{kind:'present',head:sha('2'),isDefault:false,rules:{required:[],strict:false,upToDate:true,constraints:[]}}}]}],
      branches:[{repo, name:'authorized-adoption', state:{kind:'present',head}}],
      maintenance:[{pr:adopted,result:{kind:'maintainable',basis:{headRepo:repo,headBranch:'authorized-adoption',viewerPermission:'ADMIN',author:'FindingAcceptance',maintainerCanModify:true,authorization:{kind:'actorIsAuthor',actor:'FindingAcceptance'}}}}],
      commits:[], checkAttempts:[], createdIssues:[],
    };
    const created = createAgenda({op:'convene', mode:'execute', parent, entries:[{issue:original,target,designOnly:false,adoptPr:adopted}]}, this.facts, 1000, '839b6ab0-70b6-49bc-a095-2b23fb391ac0');
    if(!created.ok) throw new Error(JSON.stringify(created.error));
    this.state = created.value;
    this.assertParsed('createAgenda');
    this.observe();
  }

  input():Inputs {
    return {
      facts:{kind:'available',generation:this.time,observedAt:this.time,scope:{issues:this.facts.issues.map(item=>item.ref),prs:this.facts.prs.map(item=>item.ref),repos:[{repo,bases:['main','release']}],branches:this.facts.branches.map(item=>({repo:item.repo,name:item.name})),commits:this.facts.commits.map(item=>({repo:item.repo,ancestor:item.ancestor,descendant:item.descendant})),checkRuns:[],creations:this.state.effects.flatMap(effect=>effect.action.kind==='createIssue'?[{repo:effect.action.spec.repo,since:0,title:effect.action.spec.title,body:effect.action.spec.body,actor:effect.action.actor}]:[])},facts:this.facts},
      host:{runId:this.main.runId, main:this.main, seats:this.seats, turnEnds:[],preflight:{ok:true,value:{asyncEnabled:true,isolationEnabled:true,asyncManager:true,gitCwd:'/tmp/external-finding-acceptance',agents:[{name:'task:test',blocking:false}]}}},
      policy:{text:'Independent lifecycle regression policy.',ownerAgent:'task:test',gateAgent:'task:test'},
    };
  }

  details(label:string):string {return `${label}\n${JSON.stringify(this.trace,null,2)}`;}
  assertParsed(label:string):void {
    const parsed = parseAgenda(JSON.parse(JSON.stringify(this.state)));
    if(!parsed.ok) throw new Error(this.details(`${label}: parseAgenda ${JSON.stringify(parsed.error)}`));
  }
  apply(event:Event):Transition {
    const previous = this.state.version;
    const result = transition(this.state, this.input(), event);
    if(result.kind==='next') {
      expect(result.state.version, this.details('version must advance exactly once')).toBe(previous+1);
      this.state = result.state;
    }
    this.trace.push({event,result:result.kind==='rejected'?`${result.kind}:${result.error.kind}:${result.error.message}`:result.kind,version:this.state.version,cases:this.state.cases.map(item=>({id:item.id,subject:item.subject.kind,state:item.state.kind})),effects:this.state.effects.map(item=>({id:item.id,action:item.action.kind,state:item.state.kind,attempt:item.attempt}))});
    this.assertParsed(event.kind);
    return result;
  }
  next(event:Event):Extract<Transition,{kind:'next'}> {
    const result = this.apply(event);
    if(result.kind!=='next') throw new Error(this.details(`Expected next, received ${JSON.stringify(result)}`));
    return result;
  }
  observe():void {
    const result = this.apply({kind:'observe'});
    if(result.kind==='rejected') throw new Error(this.details('Observation rejected'));
  }
  member(ref:IssueRef=original):Member {return must(this.state.units.flatMap(unit=>unit.members).find(item=>sameRef(item.ref,ref)),`member ${ref.number}`);}
  sourceIssue(ref:IssueRef):IssueSnapshot {return must(this.facts.issues.find(item=>sameRef(item.ref,ref)),`source issue ${ref.number}`);}
  currentCase(id:string):DecisionCase {return must(this.state.cases.find(item=>item.id===id),'case');}
  ticket(id:string):Ticket {return must(tickets(this.state,this.input()).find(ticket=>ticket.id===id),`ticket ${id}`);}
  reply(ticket:Ticket, payload:ProtocolReply, caller:Caller=this.main):Transition {
    return this.apply({kind:'reply',caller,ticket:ticket.id,revision:ticket.revision,payload,acceptedAt:++this.time});
  }
  accept(ticket:Ticket,payload:ProtocolReply,caller:Caller=this.main):void {
    const result = this.reply(ticket,payload,caller);
    if(result.kind!=='next') throw new Error(this.details(`Reply not accepted: ${JSON.stringify(result)}`));
    expect(result.reply?.outcome).toBe(payload.kind==='report'?'reported':payload.kind==='claim'?'claimOpened':'accepted');
  }
  bind(ticket:Ticket):Caller {
    const holder = ticket.holder;
    if(holder.kind!=='seat') throw new Error('Expected actual child seat ticket');
    const request = must(this.state.requests.find(item=>item.id===holder.requestId),'request');
    const agentId = `seat-${request.id}`;
    const sessionId = `session-${request.id}`;
    this.seats.push({agentId,sessionId,requestedName:request.name,parentId:this.main.agentId,createdAt:++this.time,status:'running',plan:'disabled',streaming:false});
    this.accept(this.ticket(`spawn:${request.id}`),{kind:'spawned',agentId});
    return {agentId,sessionId,parentId:this.main.agentId,runId:this.main.runId,kind:'sub',depth:1};
  }
  gate(kind:'review'|'accept', ref:IssueRef=original):GateJob {return must(this.member(ref)[kind],kind);}
  notOk(kind:'review'|'accept'):string {
    const gate = this.gate(kind);
    expect(gate.status.kind).toBe('requested');
    const ticket = this.ticket(`gate:${gate.id}`);
    const caller = this.bind(ticket);
    this.accept(this.ticket(ticket.id),{kind:'verdict',ok:false,note:`Independent ${kind} found a reproducible implementation defect.`},caller);
    const finding = must(this.state.cases.find(item=>item.subject.kind==='findings'&&item.subject.jobId===gate.id),'accepted finding');
    expect(finding.subject).toEqual({kind:'findings',jobId:gate.id,gateKind:kind,stamp:gate.stamp,note:`Independent ${kind} found a reproducible implementation defect.`});
    expect(this.gate(kind).receipt?.ticket).toBe(ticket.id);
    expect(finding.state.kind).toBe('open');
    return finding.id;
  }
  decision(id:string, decision:CaseDecision):Transition {return this.reply(this.ticket(`case:${id}`),{kind:'decision',decision});}
  acceptDecision(id:string, decision:CaseDecision):void {
    this.accept(this.ticket(`case:${id}`),{kind:'decision',decision});
  }
  mergeOriginal():void {
    const pr = must(this.facts.prs.find(item=>sameRef(item.ref,adopted)),'adopted PR');
    expect(pr.head).toBe(head);
    expect(pr.target).toEqual(target);
    pr.state = {kind:'merged',sha:originalMerge,at:++this.time};
    pr.updatedAt = this.time;
    const source = this.sourceIssue(original);
    source.state = 'closed'; source.lastClose = {id:'external-exact-close',at:this.time};
    this.defaultHead(originalMerge);
    this.observe();
  }
  defaultHead(value:string):void {
    const snapshot = must(this.facts.repos[0],'repo'); snapshot.defaultHead=value;
    const base = must(snapshot.bases.find(item=>item.name==='main'),'main base');
    if(base.state.kind!=='present') throw new Error('main missing');
    base.state.head=value;
  }
  insertion(kind:'draft'|'existing'):Insertion {
    const position = {kind:'correctionOf' as const,unitId:must(this.state.units[0],'original unit').id};
    return kind==='draft'?{kind:'draft',draft:correctionSpec,position}:{kind:'existing',entry:{issue:correction,target,designOnly:false,adoptPr:null},position};
  }
  start(effect:Effect):number {
    expect(effect.state.kind).toBe('ready');
    const attempt = effect.attempt+1;
    this.next({kind:'effectStarted',id:effect.id,attempt,startedAt:++this.time});
    expect(must(this.state.effects.find(item=>item.id===effect.id),'executing effect').state.kind).toBe('executing');
    return attempt;
  }
  confirm(id:string,attempt:number,result:EffectResult):void {this.next({kind:'effectConfirmed',id,attempt,result});}
  createCorrection(draftId:string):void {
    const draft = must(this.state.drafts.find(item=>item.id===draftId),'draft');
    const effect = must(this.state.effects.find(item=>item.id===draft.creationEffectId),'create effect');
    expect(effect.action).toEqual({kind:'createIssue',draftId,spec:correctionSpec,actor:this.facts.viewer});
    const attempt = this.start(effect); // durable executing BEFORE the source creates anything
    const createdAt = ++this.time;
    const source = issue(correction,correctionSpec.body);
    source.updatedAt = createdAt;
    this.facts.issues.push(source);
    this.facts.createdIssues.push({issue:correction,title:correctionSpec.title,body:correctionSpec.body,actor:this.facts.viewer,createdAt});
    this.confirm(effect.id,attempt,{kind:'created',issue:correction});
    this.observe();
  }
  attachCorrection(effect:Effect):void {
    expect(effect.action.kind).toBe('attachChild');
    const attempt = this.start(effect);
    this.sourceIssue(parent).children.push(correction);
    this.confirm(effect.id,attempt,{kind:'attached',parent,child:correction});
    this.observe();
  }
  deliverCorrection(designCommit:string|null=null):void {
    const member = this.member(correction);
    const work = must(member.work,'correction owner work');
    const workTicket = this.ticket(`work:${work.id}`);
    expect(workTicket.runDisposition).toBe('mustRun');
    const owner = this.bind(workTicket);
    this.facts.branches.push({repo,name:'correction-delivery',state:{kind:'present',head:correctionHead}});
    if(designCommit) this.facts.commits.push({repo,ancestor:designCommit,descendant:correctionHead,result:'contains'});
    this.accept(this.ticket(workTicket.id),{kind:'submit',branch:'correction-delivery',head:correctionHead,title:'Implement original independent finding',body:`Closes ${correction.repo.owner}/${correction.repo.name}#${correction.number}\n\n## Evidence\nThe independently reproduced defect is repaired.`,template:'fourLayer',retryNote:null},owner);
    const publish = must(this.state.effects.find(item=>item.action.kind==='publishPr'&&sameRef(item.action.member,correction)&&item.state.kind==='ready'),'publish correction');
    if(publish.action.kind!=='publishPr') throw new Error('publish action');
    const publication = publish.action;
    const publishAttempt = this.start(publish);
    this.facts.prs.push({ref:correctionPr,headRepo:repo,headBranch:'correction-delivery',head:correctionHead,target,title:publication.submission.payload.title,body:publication.body,bodyHash:hash(publication.body),updatedAt:++this.time,state:{kind:'open'},closes:[correction],mergeable:'yes',checks:{kind:'passing',required:[]}});
    this.facts.links.push({issue:correction,pr:correctionPr});
    this.facts.maintenance.push({pr:correctionPr,result:{kind:'maintainable',basis:{headRepo:repo,headBranch:'correction-delivery',viewerPermission:'ADMIN',author:this.facts.viewer,maintainerCanModify:true,authorization:{kind:'systemCreated',effectId:publish.id}}}});
    this.confirm(publish.id,publishAttempt,{kind:'published',pr:correctionPr});
    this.observe();
    for(const kind of ['review','accept'] as const) {
      const gate = this.gate(kind,correction);
      const ticket = this.ticket(`gate:${gate.id}`);
      const caller = this.bind(ticket);
      this.accept(this.ticket(ticket.id),{kind:'verdict',ok:true,note:`The real correction ${kind} passes independently.`},caller);
    }
    this.observe();
    const merge = must(this.state.effects.find(item=>item.action.kind==='merge'&&sameRef(item.action.member,correction)&&item.state.kind==='ready'),'correction merge');
    const mergeAttempt = this.start(merge);
    const pr = must(this.facts.prs.find(item=>sameRef(item.ref,correctionPr)),'correction PR');
    pr.state={kind:'merged',sha:correctionMerge,at:++this.time};
    pr.updatedAt=this.time;
    const source = this.sourceIssue(correction); source.state='closed'; source.lastClose={id:'correction-merge-close',at:this.time};
    this.defaultHead(correctionMerge);
    this.facts.commits.push({repo,ancestor:originalMerge,descendant:correctionMerge,result:'contains'});
    if(designCommit) this.facts.commits.push({repo,ancestor:designCommit,descendant:correctionMerge,result:'contains'});
    this.confirm(merge.id,mergeAttempt,{kind:'merged',pr:correctionPr,merge:{repo,sha:correctionMerge},at:this.time});
    this.observe();
  }
}

function expectRejected(scenario:Scenario,id:string,decision:CaseDecision):void {
  const before = JSON.stringify(scenario.state);
  const result = scenario.decision(id,decision);
  expect(result.kind,scenario.details(`Must reject ${decision.kind}`)).toBe('rejected');
  if(result.kind==='rejected') expect(result.error.kind).toBe('invalidDecision');
  expect(JSON.stringify(scenario.state)).toBe(before);
}
function expectSourceMergeWithoutSubmit(scenario:Scenario,id:string):void {
  const member=scenario.member();
  expect(member.terminal).toEqual({kind:'merged',pr:adopted,merge:{repo,sha:originalMerge},at:must(scenario.sourceIssue(original).lastClose,'observed close event').at});
  expect(member.baseline).toEqual({kind:'adopted',pr:adopted,acceptedHead:head});
  expect(member.ownerReceipt).toBeNull();
  expect(member.ownerTerminal).toBeNull();
  expect(member.work).toBeNull();
  expect(scenario.currentCase(id).state.kind).toBe('open');
  expect(scenario.ticket(`case:${id}`).runDisposition).toBe('mustRun');
  expect(scenario.state.units[0]?.postMerge).toBeNull();
}

describe('independent findings survive exact external merges',()=>{
  for(const kind of ['review','accept'] as const) {
    test(`${kind} not-ok remains a real unresolved finding after external exact merge`,()=>{
      const s=new Scenario(); const id=s.notOk(kind); const subject=structuredClone(s.currentCase(id).subject);
      s.mergeOriginal(); expectSourceMergeWithoutSubmit(s,id);
      s.observe();
      expect(s.currentCase(id).subject).toEqual(subject);
      expect(s.currentCase(id).state.kind).toBe('open');
      expect(s.member().work).toBeNull();
    });
    test(`${kind} valid finding transfers through actual draft/create/attach/correction delivery`,()=>{
      const s=new Scenario(); const id=s.notOk(kind); s.mergeOriginal(); expectSourceMergeWithoutSubmit(s,id);
      const insertion=s.insertion('draft');
      s.acceptDecision(id,{kind:'correct',insertion});
      const draft=must(s.state.drafts.find(item=>item.caseId===id),'correction draft');
      expect(draft.purpose).toBe('correction'); expect(draft.position).toEqual(insertion.position);
      expect(draft.scope).toEqual({kind:'unit',unitId:must(s.state.units[0],'original unit').id});
      expect(draft.parent).toEqual(parent); expect(draft.state.kind).toBe('proposed');
      expect(s.currentCase(id).state).toEqual({kind:'applying',decision:{kind:'correct',insertion},required:[{kind:'draft',draftId:draft.id}]});
      expect(s.currentCase(id).receipt?.result.created).toContainEqual({kind:'draft',id:draft.id});
      expect(s.currentCase(id).receipt?.result.created).toContainEqual({kind:'effect',id:draft.creationEffectId});
      s.observe(); expect(s.currentCase(id).state.kind).toBe('applying');
      expect(s.state.units[0]?.postMerge).toBeNull();
      s.createCorrection(draft.id);
      const registered=must(s.state.drafts.find(item=>item.id===draft.id),'registered draft');
      expect(registered.state).toEqual({kind:'registered',issue:correction});
      expect(s.currentCase(id).state.kind).toBe('applying');
      expect(s.state.units[0]?.members).toHaveLength(1);
      const attachment=must(s.state.effects.find(item=>item.action.kind==='attachChild'&&item.action.owner.kind==='draft'&&item.action.owner.draftId===draft.id),'draft attachment');
      expect(registered.attachmentEffectIds).toEqual([attachment.id]);
      s.attachCorrection(attachment);
      expect(s.state.drafts.find(item=>item.id===draft.id)?.state).toEqual({kind:'placed',member:correction});
      expect(s.currentCase(id).state).toEqual({kind:'resolved',result:{kind:'correct',insertion}});
      expect(s.member().work).toBeNull(); expect(s.member().ownerReceipt).toBeNull();
      expect(s.state.units).toHaveLength(1); expect(s.state.units[0]?.members.map(item=>item.ref)).toEqual([original,correction]);
      expect(s.member(correction).work?.reasons).toEqual([{kind:'initial'}]);
      expect(s.state.units[0]?.postMerge).toBeNull();
      s.deliverCorrection();
      const postMerge=must(s.state.units[0]?.postMerge,'full-unit postMerge');
      expect(postMerge.status.kind).toBe('requested');
      if(postMerge.stamp.kind!=='postMerge') throw new Error('Expected postMerge stamp');
      expect(postMerge.stamp.members.map(item=>({ref:item.member.member,kind:item.terminal.kind}))).toEqual([{ref:original,kind:'merged'},{ref:correction,kind:'merged'}]);
      expect(postMerge.stamp.repos).toEqual([{repo,commit:correctionMerge,merges:[originalMerge,correctionMerge]}]);
      expect(s.member().ownerReceipt).toBeNull();
    });
  }

  for(const kind of ['upholdOwner','upholdMain'] as const) {
    test(`merged finding rejects ${kind} instead of manufacturing impossible original work`,()=>{
      const s=new Scenario(); const id=s.notOk('review'); s.mergeOriginal();
      expectRejected(s,id,{kind,basis:'The finding is valid, but the original PR has already merged.'});
      expect(s.member().work).toBeNull(); expect(s.state.designWorks).toHaveLength(0);
    });
    test(`ordinary pending finding retains ${kind}`,()=>{
      const s=new Scenario(); const id=s.notOk('review');
      s.acceptDecision(id,{kind,basis:'Repair the still-open original implementation.'});
      expect(s.member().terminal.kind).toBe('pending'); expect(s.member().work).not.toBeNull();
      if(kind==='upholdMain') {expect(s.state.designWorks).toHaveLength(1); expect(s.currentCase(id).state.kind).toBe('applying');}
      else expect(s.currentCase(id).state.kind).toBe('resolved');
    });
  }
  test('ordinary pending finding still permits a real rejection, not a fabricated gate pass',()=>{
    const s=new Scenario(); const id=s.notOk('accept');
    s.acceptDecision(id,{kind:'reject',basis:'The independent reproduction disproves this particular finding.'});
    expect(s.currentCase(id).state.kind).toBe('resolved'); expect(s.member().work).toBeNull();
    expect(s.gate('accept').status).toEqual({kind:'cancelled',reason:'superseded'});
    s.observe(); expect(s.gate('accept').status.kind).toBe('requested');
  });
  test('correct cannot bypass a finding while the original PR is still open',()=>{
    const s=new Scenario(); const id=s.notOk('review');
    expectRejected(s,id,{kind:'correct',insertion:s.insertion('draft')});
    expect(s.state.drafts).toHaveLength(0); expect(s.member().terminal.kind).toBe('pending');
  });
  test('merged finding only accepts correctionOf its own original unit',()=>{
    const s=new Scenario(); const id=s.notOk('review'); s.mergeOriginal();
    expectRejected(s,id,{kind:'correct',insertion:{kind:'draft',draft:correctionSpec,position:{kind:'outsideAgenda'}}});
    expectRejected(s,id,{kind:'correct',insertion:{kind:'draft',draft:correctionSpec,position:{kind:'after',unitId:must(s.state.units[0],'unit').id}}});
  });
  test('existing correction waits for the actual parent attachment before placement',()=>{
    const s=new Scenario(); const id=s.notOk('accept'); s.mergeOriginal();
    s.facts.issues.push(issue(correction,correctionSpec.body));
    const insertion=s.insertion('existing');if(insertion.kind!=='existing')throw new Error('Expected the exact existing correction intent');s.acceptDecision(id,{kind:'correct',insertion});
    const attachment=must(s.state.effects.find(item=>item.action.kind==='attachChild'&&item.action.owner.kind==='insertion'&&item.action.owner.caseId===id),'existing correction attachment');
    expect(attachment.action).toEqual({kind:'attachChild',owner:{kind:'insertion',caseId:id,insertion},parent,child:correction});
    expect(s.currentCase(id).state).toEqual({kind:'applying',decision:{kind:'correct',insertion},required:[{kind:'effect',effectId:attachment.id}]});
    expect(s.currentCase(id).receipt?.result.created).toContainEqual({kind:'effect',id:attachment.id});
    expect(s.state.units[0]?.members).toHaveLength(1); expect(s.state.units[0]?.postMerge).toBeNull();
    s.attachCorrection(attachment);
    expect(s.currentCase(id).state.kind).toBe('resolved');
    expect(s.state.units[0]?.members.map(item=>item.ref)).toEqual([original,correction]);
    expect(s.member(correction).work).not.toBeNull(); expect(s.member().work).toBeNull();
    expect(s.state.units[0]?.postMerge).toBeNull();
  });
  test('terminal correction cannot transfer a finding about a different accepted head',()=>{
    const s=new Scenario(); const id=s.notOk('review');
    const pr=must(s.facts.prs.find(item=>sameRef(item.ref,adopted)),'original PR');
    pr.head=sha('e'); pr.state={kind:'merged',sha:originalMerge,at:++s.time}; pr.updatedAt=s.time;
    const branch=must(s.facts.branches[0],'adopted branch'); branch.state={kind:'present',head:pr.head};
    const source=s.sourceIssue(original); source.state='closed'; source.lastClose={id:'different-head-close',at:s.time};
    s.defaultHead(originalMerge); s.observe();
    expect(s.member().terminal.kind).toBe('merged'); expect(s.currentCase(id).state.kind).toBe('open');
    expectRejected(s,id,{kind:'correct',insertion:s.insertion('draft')});
    expect(s.state.drafts).toHaveLength(0);
  });
  test('an unrelated merged PR on the wrong target does not end original member or finding',()=>{
    const s=new Scenario(); const id=s.notOk('review');
    const wrong=structuredClone(must(s.facts.prs[0],'original PR'));
    wrong.ref={repo,number:99}; wrong.target={repo,base:'release'}; wrong.state={kind:'merged',sha:sha('e'),at:++s.time};
    s.facts.prs.push(wrong); s.facts.links.push({issue:original,pr:wrong.ref});
    s.observe();
    expect(s.member().terminal.kind).toBe('pending'); expect(s.member().ownerReceipt).toBeNull();
    expect(s.currentCase(id).state.kind).toBe('open'); expect(s.state.units[0]?.postMerge).toBeNull();
    expectRejected(s,id,{kind:'correct',insertion:s.insertion('draft')});
  });
});

test('merged Main-design finding waits for default design commit and real correction placement',()=>{
  const s=new Scenario(); const id=s.notOk('review'); s.mergeOriginal();
  const insertion=s.insertion('draft');
  const clauses=['The original independent finding requires a Main-authored design correction before implementation.'];
  const ticket=s.ticket(`case:${id}`);
  // Parse at the public input boundary: this also exercises schema admission without a cast.
  const portInput={op:'reply',ticket:ticket.id,revision:ticket.revision,reply:{kind:'decision',decision:{kind:'correctDesign',insertion,clauses}}};
  const parsed=parsePortInput(portInput);
  if(!parsed.ok) throw new Error(s.details(`correctDesign public parser rejected input ${JSON.stringify(portInput)}: ${JSON.stringify(parsed.error)}`));
  if(parsed.value.op!=='reply') throw new Error('Expected parsed reply');
  s.accept(ticket,parsed.value.reply);
  const amendment=must(s.state.amendments.find(item=>item.caseId===id),'design correction amendment');
  expect(s.state.amendments.filter(item=>item.caseId===id)).toHaveLength(1);
  const design=must(s.state.designWorks.find(item=>item.parentCaseId===id),'Main design work');
  expect(design.route).toEqual({kind:'defaultFirst',repo});
  expect(design.clauses).toEqual(clauses); expect(design.result).toBeNull();
  expect(s.ticket(`work:${design.id}`).holder).toEqual({kind:'main'});
  const draft=must(s.state.drafts.find(item=>item.caseId===id),'design correction draft');
  expect(s.state.drafts.filter(item=>item.caseId===id)).toHaveLength(1);
  expect(s.currentCase(id).state).toEqual({kind:'applying',decision:{kind:'correctDesign',insertion,clauses},required:[{kind:'amendment',id:amendment.id}]});
  expect(s.member().work).toBeNull(); expect(s.member().ownerReceipt).toBeNull();
  s.createCorrection(draft.id);
  const attachment=must(s.state.effects.find(item=>item.action.kind==='attachChild'&&item.action.owner.kind==='draft'&&item.action.owner.draftId===draft.id),'design correction attachment');
  s.attachCorrection(attachment);
  expect(s.state.units[0]?.members).toHaveLength(1);
  expect(s.state.drafts.find(item=>item.id===draft.id)?.state).toEqual({kind:'registered',issue:correction});
  expect(s.currentCase(id).state.kind).toBe('applying');
  expect(s.state.units[0]?.postMerge).toBeNull();
  const commit={repo,sha:sha('f')};
  // Main's real remote design commit exists, but not on default: it cannot satisfy defaultFirst.
  s.facts.branches.push({repo,name:'main-design-correction',state:{kind:'present',head:commit.sha}});
  s.facts.commits.push({repo,ancestor:commit.sha,descendant:originalMerge,result:'notContained'});
  const missing=s.reply(s.ticket(`work:${design.id}`),{kind:'designCommit',commit});
  expect(missing.kind,s.details('defaultFirst must require actual default containment')).toBe('rejected');
  if(missing.kind==='rejected') expect(missing.error.kind).toBe('missingDesignCommit');
  expect(s.currentCase(id).state.kind).toBe('applying');
  expect(s.state.units[0]?.members).toHaveLength(1);
  s.defaultHead(commit.sha);
  s.facts.commits.push({repo,ancestor:originalMerge,descendant:commit.sha,result:'contains'});
  s.accept(s.ticket(`work:${design.id}`),{kind:'designCommit',commit});
  s.observe();
  expect(s.state.amendments.find(item=>item.id===amendment.id)?.state.kind).toBe('effective');
  expect(s.state.drafts.find(item=>item.id===draft.id)?.state).toEqual({kind:'placed',member:correction});
  expect(s.currentCase(id).state.kind).toBe('resolved');
  const owner=must(s.member(correction).work,'design correction owner work');
  expect(owner.required).toContainEqual(commit);
  expect(s.member(correction).contract.requirements).toContainEqual(expect.objectContaining({caseId:id,commit,carrier:{kind:'member',member:correction},route:{kind:'defaultFirst',repo}}));
  expect(s.ticket(`work:${owner.id}`).brief).toContain(clauses.join('\n'));
  expect(s.member().work).toBeNull(); expect(s.member().ownerReceipt).toBeNull();
  expect(s.state.units[0]?.postMerge).toBeNull();
  s.deliverCorrection(commit.sha);
  const postMerge=must(s.state.units[0]?.postMerge,'design correction full-unit postMerge');
  expect(postMerge.status.kind).toBe('requested');
  if(postMerge.stamp.kind!=='postMerge') throw new Error('Expected postMerge');
  expect(postMerge.stamp.members.map(item=>item.member.member)).toEqual([original,correction]);
  const postTicket=s.ticket(`gate:${postMerge.id}`);
  const verifier=s.bind(postTicket);
  s.accept(s.ticket(postTicket.id),{kind:'verdict',ok:true,note:'Both original implementation and design-bearing correction pass at the actual integrated merge.'},verifier);
  s.observe();
  const closure=must(s.state.closure,'fresh parent closure');
  const closureTicket=s.ticket(`gate:${closure.id}`);
  const closer=s.bind(closureTicket);
  s.accept(s.ticket(closureTicket.id),{kind:'verdict',ok:true,note:'The real parent children and full corrected unit satisfy the parent contract.'},closer);
  s.observe();
  const close=must(s.state.effects.find(effect=>effect.action.kind==='setIssueState'&&sameRef(effect.action.issue,parent)&&!effect.action.open&&effect.state.kind==='ready'),'parent close effect');
  const attempt=s.start(close);
  const parentSource=s.sourceIssue(parent);
  parentSource.state='closed'; parentSource.lastClose={id:'verified-parent-close',at:++s.time}; parentSource.updatedAt=s.time;
  s.confirm(close.id,attempt,{kind:'issueState',issue:parent,open:false,event:parentSource.lastClose});
  s.observe();
  const report=must(s.state.report,'final report');
  s.accept(s.ticket(`work:${report.id}`),{kind:'report',summary:'Original exact external merge and real correction are independently verified, Main design is on default, and the parent is source-confirmed closed.'});
  expect(s.state.lifecycle).toBe('completed');
  expect(s.member().work).toBeNull(); expect(s.member().ownerReceipt).toBeNull();
  expect(s.state.designWorks.find(item=>item.id===design.id)?.receipt?.ticket).toBe(`work:${design.id}`);
  expect(tickets(s.state,s.input())).toEqual([]);
});


function mergedBodyCase():{scenario:Scenario;id:string} {
  const scenario=new Scenario(); scenario.mergeOriginal();
  const source=scenario.sourceIssue(original); source.body+='\nSource contract clarification requires an actual correction.'; source.bodyHash=hash(source.body); source.updatedAt=++scenario.time;
  scenario.observe();
  const item=must(scenario.state.cases.find(item=>item.subject.kind==='unexpectedSourceChange'&&item.subject.cause.reason==='bodyChanged'&&item.state.kind==='open'),'merged body-change case');
  return {scenario,id:item.id};
}
describe('source-body decisions after original merge',()=>{
  test('keepWork acknowledges the new contract without impossible original owner work',()=>{
    const {scenario:s,id}=mergedBodyCase();
    const oldRevision=s.member().contract.revision;
    const oldGate=must(s.state.units[0]?.postMerge,'prior unit postMerge').id;
    s.acceptDecision(id,{kind:'keepWork',basis:'Acknowledge the real new source contract; fresh postMerge must independently verify it.'});
    expect(s.member().work,s.details('keepWork must not reopen work on a merged original PR')).toBeNull();
    expect(s.member().ownerReceipt).toBeNull();
    expect(s.member().contract.revision).toBe(oldRevision+1);
    expect(s.member().contract.bodyHash).toBe(s.sourceIssue(original).bodyHash);
    expect(s.currentCase(id).state.kind).toBe('resolved');
    s.observe();
    const fresh=must(s.state.units[0]?.postMerge,'fresh new-contract postMerge');
    expect(fresh.id).not.toBe(oldGate); expect(fresh.status.kind).toBe('requested');
    if(fresh.stamp.kind!=='postMerge') throw new Error('Expected fresh postMerge');
    expect(fresh.stamp.members[0]?.member).toEqual({member:original,bodyHash:s.sourceIssue(original).bodyHash,contractRevision:oldRevision+1,required:[]});
    expect(s.member().work).toBeNull();
  });
  test('merged source-body obligation remains stable across unchanged observation',()=>{
    const {scenario:s,id}=mergedBodyCase();
    s.observe();
    expect(s.currentCase(id).state.kind,s.details('Merged body-change must not disappear on repeated observe')).toBe('open');
    expect(s.state.cases.filter(item=>item.subject.kind==='unexpectedSourceChange')).toHaveLength(1);
  });
  test('body-change alone is not an independent finding and cannot directly correct',()=>{
    const {scenario:s,id}=mergedBodyCase();
    expectRejected(s,id,{kind:'correct',insertion:s.insertion('draft')});
    expect(s.state.drafts).toHaveLength(0);
    expect(s.member().work).toBeNull();
  });
});
