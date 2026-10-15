import {createHash} from 'node:crypto';
import {describe, expect, test} from 'bun:test';
import {createAgenda, parseAgenda, parsePortInput, tickets, transition} from '../src/domain/index.ts';
import type {Agenda, Caller, CommitObservation, DomainError, Event, Facts, HostSeat, Inputs, Member, PrSubmit, ProtocolReply, Repo, Ticket, Transition} from '../src/domain/index.ts';

const upstream: Repo = {owner:'ContractMaintainers',name:'project'};
const fork: Repo = {owner:'AuthorizedContributor',name:'project'};
const unrelated: Repo = {owner:'OtherOrganization',name:'project'};
const issue = {repo:upstream,number:17};
const adoptedPr = {repo:upstream,number:31};
const baseHead = '1'.repeat(40);
const adoptedHead = '2'.repeat(40);
const designSha = '3'.repeat(40);
const submittedHead = '4'.repeat(40);
const otherHead = '5'.repeat(40);
const branch = 'repair/fork-design';
const runId = 'fork-design-run';
const hash = (body:string):string => createHash('sha256').update(body).digest('hex');
const main: Caller = {agentId:'main',sessionId:'main-session',parentId:null,runId,kind:'main',depth:0};
const owner: Caller = {agentId:'owner',sessionId:'owner-session',parentId:main.agentId,runId,kind:'sub',depth:1};

type Trace = {label:string;event:Event['kind'];result:Transition['kind'];version:number;work:string|null;revision:number|null;required:Member['contract']['requirements'];cases:readonly string[];effects:readonly string[];error:DomainError['kind']|null};
type ProofCase = {name:string;proofs:(head:string)=>CommitObservation[];head?:string;accepted:boolean};

function fixtureFacts():Facts {
  const issueBody = 'Preserve target-repository design responsibility when repairing the authorized fork PR.';
  const prBody = 'Adopted implementation requiring design repair.\n\nCloses #17';
  const rules = {required:[],strict:false,upToDate:false,constraints:[]};
  return {
    viewer:'RiriAgent',
    issues:[{ref:issue,body:issueBody,bodyHash:hash(issueBody),updatedAt:10,state:'open',lastClose:null,lastReopen:null,children:[]}],
    prs:[{ref:adoptedPr,headRepo:fork,headBranch:branch,head:adoptedHead,target:{repo:upstream,base:'main'},title:'Adopted fork implementation',body:prBody,bodyHash:hash(prBody),updatedAt:11,state:{kind:'open'},closes:[issue],mergeable:'no',checks:{kind:'passing',required:[]}}],
    links:[{issue,pr:adoptedPr}],
    repos:[upstream,fork,unrelated].map(repo=>({repo,defaultBranch:'main',defaultHead:baseHead,bases:[{name:'main',state:{kind:'present',head:baseHead,isDefault:true,rules}},{name:'release',state:{kind:'present',head:baseHead,isDefault:false,rules}}]})),
    branches:[{repo:fork,name:branch,state:{kind:'present',head:adoptedHead}},{repo:upstream,name:'design/remote-contract',state:{kind:'present',head:designSha}}],
    maintenance:[{pr:adoptedPr,result:{kind:'maintainable',basis:{headRepo:fork,headBranch:branch,viewerPermission:'WRITE',author:'AuthorizedContributor',maintainerCanModify:true,authorization:{kind:'authorAuthorized',evidence:'The PR author explicitly authorized RiriAgent to continue this exact fork PR.'}}}}],
    commits:[],checkAttempts:[],createdIssues:[],
  };
}

class Scenario {
  state: Agenda;
  facts: Facts = fixtureFacts();
  seats: HostSeat[] = [];
  trace: Trace[] = [];

  constructor() {
    const created = createAgenda({op:'convene',mode:'execute',parent:null,entries:[{issue,target:{repo:upstream,base:'main'},designOnly:false,adoptPr:adoptedPr}]},this.facts,20,'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    if(!created.ok)throw new Error(`Convene rejected: ${JSON.stringify(created.error)}`);
    this.state = created.value;
    this.assertParsed();
    expect(this.member.baseline).toEqual({kind:'adopted',pr:adoptedPr,acceptedHead:adoptedHead});
    expect(this.member.binding).toEqual({kind:'registered',pr:adoptedPr,headRepo:fork,branch,origin:'adopted'});
    expect(this.member.work).toBeNull();
  }

  get member():Member {
    const member = this.state.units[0]?.members[0];
    if(!member)throw new Error('The convened member disappeared');
    return member;
  }

  input():Inputs {
    return {
      facts:{kind:'available',generation:1,scope:{issues:[issue],prs:this.facts.prs.map(pr=>pr.ref),repos:this.facts.repos.map(snapshot=>({repo:snapshot.repo,bases:snapshot.bases.map(base=>base.name)})),branches:this.facts.branches.map(({repo,name})=>({repo,name})),commits:this.facts.commits.map(({repo,ancestor,descendant})=>({repo,ancestor,descendant})),checkRuns:[],creations:[]},observedAt:30,facts:this.facts},
      host:{runId,main,seats:this.seats,turnEnds:[],preflight:{ok:true,value:{asyncEnabled:true,isolationEnabled:true,asyncManager:true,gitCwd:'/tmp/roundtable-fork-design',agents:[{name:'task:free',blocking:false}]}}},
      policy:{text:'Independent deterministic public-domain contract test; no model is invoked.',ownerAgent:'task:free',gateAgent:'task:free'},
    };
  }

  assertParsed():void {
    const parsed = parseAgenda(this.state);
    if(!parsed.ok)throw new Error(`Public state parser rejected reached state: ${JSON.stringify(parsed.error)}`);
    expect(parsed.value).toEqual(this.state);
  }

  step(label:string,event:Event):Transition {
    const before = structuredClone(this.state);
    const result = transition(this.state,this.input(),event);
    const after = result.kind==='next'?result.state:this.state;
    const member = after.units[0]?.members[0];
    this.trace.push({label,event:event.kind,result:result.kind,version:after.version,work:member?.work?.id??null,revision:member?.work?.contentVersion??null,required:member?.contract.requirements??[],cases:after.cases.map(item=>`${item.subject.kind}:${item.state.kind}`),effects:after.effects.map(effect=>`${effect.action.kind}:${effect.state.kind}`),error:result.kind==='rejected'?result.error.kind:null});
    expect(this.state).toEqual(before);
    if(result.kind==='next') {
      expect(result.state.version).toBe(before.version+1);
      this.state = result.state;
      this.assertParsed();
    } else expect(this.state.version).toBe(before.version);
    return result;
  }

  next(label:string,event:Event):void {
    const result = this.step(label,event);
    if(result.kind!=='next')throw new Error(`${label} expected next, received ${JSON.stringify(result)}`);
  }

  ticket(reply:ProtocolReply['kind'],holder:'main'|'seat'):Ticket {
    const matches = tickets(this.state,this.input()).filter(ticket=>ticket.allowedReplies.includes(reply)&&ticket.holder.kind===holder);
    expect(matches).toHaveLength(1);
    const ticket = matches[0];
    if(!ticket)throw new Error(`Missing ${holder} ${reply} ticket`);
    return ticket;
  }

  reply(label:string,ticket:Ticket,payload:ProtocolReply,caller:Caller):Transition {
    const parsed = parsePortInput({op:'reply',ticket:ticket.id,revision:ticket.revision,reply:payload});
    if(!parsed.ok)throw new Error(`Public input parser rejected ${label}: ${JSON.stringify(parsed.error)}`);
    if(parsed.value.op!=='reply')throw new Error('Reply parser changed operation');
    return this.step(label,{kind:'reply',caller,ticket:parsed.value.ticket,revision:parsed.value.revision,payload:parsed.value.reply,acceptedAt:40+this.trace.length});
  }

  acceptedReply(label:string,ticket:Ticket,payload:ProtocolReply,caller:Caller):void {
    const result = this.reply(label,ticket,payload,caller);
    if(result.kind!=='next'||result.reply?.outcome!==(payload.kind==='claim'?'claimOpened':'accepted'))throw new Error(`${label} expected accepted reply, received ${JSON.stringify(result)}`);
  }

  reachDesignRequirement():void {
    this.next('observe adopted fork conflict',{kind:'observe'});
    const originalWork = this.member.work?.id;
    expect(originalWork).toBeDefined();
    expect(this.member.work?.reasons).toContainEqual({kind:'conflict',base:baseHead});
    const request = this.state.requests.find(request=>request.role==='owner');
    if(!request)throw new Error('Conflict did not request the owner seat');
    this.seats = [{agentId:owner.agentId,requestedName:request.name,parentId:main.agentId,sessionId:owner.sessionId,createdAt:31,status:'running',plan:'disabled',streaming:true}];
    this.acceptedReply('bind exact authorized owner seat',this.ticket('spawned','main'),{kind:'spawned',agentId:owner.agentId},main);
    this.acceptedReply('owner asks target design question',this.ticket('submit','seat'),{kind:'claim',claim:{kind:'question',reproduction:'The adopted fork implementation lacks the target design contract.',readings:['The design belongs to the upstream repository.','A fork SHA alone is sufficient proof.'],earliestGap:'The upstream design responsibility is not yet defined.',proposal:'Main supplies a real upstream design commit carried with this PR.'}},owner);
    expect(this.ticket('submit','seat').runDisposition).toBe('mayWait');
    this.acceptedReply('Main accepts withPr design amendment',this.ticket('decision','main'),{kind:'decision',decision:{kind:'amend',amendment:{kind:'designGap',affected:[issue],bodyEdits:[],route:{kind:'withPr',member:issue}}}},main);
    expect(this.member.work?.id).toBe(originalWork);
    expect(this.state.amendments[0]?.state.kind).toBe('pending');
    this.acceptedReply('Main submits source verified upstream design commit',this.ticket('designCommit','main'),{kind:'designCommit',commit:{repo:upstream,sha:designSha}},main);
    this.next('observe effective amendment and owner release',{kind:'observe'});
    expect(this.state.amendments[0]?.state.kind).toBe('effective');
    expect(this.state.cases[0]?.state.kind).toBe('resolved');
    expect(this.member.work?.id).toBe(originalWork);
    expect(this.member.work?.required).toEqual([{repo:upstream,sha:designSha}]);
    expect(this.member.contract.requirements).toHaveLength(1);
    expect(this.member.contract.requirements[0]).toMatchObject({commit:{repo:upstream,sha:designSha},carrier:{kind:'member',member:issue},route:{kind:'withPr',member:issue}});
    expect(this.ticket('submit','seat').runDisposition).toBe('mustRun');
    expect(this.ticket('submit','seat').revision).toBeGreaterThan(1);
  }

  sourceHead(head:string):void {
    this.facts = {...this.facts,prs:this.facts.prs.map(pr=>({...pr,head,mergeable:'yes'})),branches:this.facts.branches.map(remote=>remote.repo.owner===fork.owner&&remote.name===branch?{...remote,state:{kind:'present',head}}:remote)};
  }

  submit(head:string,overrides:Partial<PrSubmit>={}):Transition {
    return this.reply('owner submits exact fork branch',this.ticket('submit','seat'),{kind:'submit',branch,head,title:'Carry upstream design through authorized fork',body:'Implemented and verified the target design contract.\n\nCloses #17',template:'fourLayer',retryNote:null,...overrides},owner);
  }
}

function exercise(name:string,run:(scenario:Scenario)=>void):void {
  const scenario = new Scenario();
  try {
    scenario.reachDesignRequirement();
    run(scenario);
    console.log(JSON.stringify({scenario:name,trace:scenario.trace}));
  } catch(error) {
    console.error(JSON.stringify({scenario:name,trace:scenario.trace}));
    throw error;
  }
}

function proof(repo:Repo,ancestor=designSha,descendant=submittedHead,result:CommitObservation['result']='contains'):CommitObservation {
  return {repo,ancestor,descendant,result};
}

const proofCases:readonly ProofCase[] = [
  {name:'exact target-repository proof accepts a distinct fork head',proofs:head=>[proof(upstream,designSha,head)],accepted:true},
  {name:'fork-only proof with identical SHA pair cannot discharge target responsibility',proofs:head=>[proof(fork,designSha,head)],accepted:false},
  {name:'unrelated repo with the same name and SHA pair cannot discharge target responsibility',proofs:head=>[proof(unrelated,designSha,head)],accepted:false},
  {name:'absent target containment proof is rejected',proofs:()=>[],accepted:false},
  {name:'explicit target notContained cannot be overridden by fork contains',proofs:head=>[proof(upstream,designSha,head,'notContained'),proof(fork,designSha,head)],accepted:false},
  {name:'explicit target missing cannot be overridden by fork contains',proofs:head=>[proof(upstream,designSha,head,'missing'),proof(fork,designSha,head)],accepted:false},
  {name:'proof for the wrong target ancestor is rejected',proofs:head=>[proof(upstream,otherHead,head)],accepted:false},
  {name:'proof for the wrong target descendant is rejected',proofs:()=>[proof(upstream,designSha,otherHead)],accepted:false},
  {name:'reversed target ancestry is rejected',proofs:head=>[proof(upstream,head,designSha)],accepted:false},
  {name:'exact target proof is not vetoed by a negative fork lookup',proofs:head=>[proof(upstream,designSha,head),proof(fork,designSha,head,'missing')],accepted:true},
  {name:'equal SHAs across repositories still require an explicit target proof',head:designSha,proofs:()=>[],accepted:false},
  {name:'equal SHAs plus only fork proof are not cross-repository evidence',head:designSha,proofs:head=>[proof(fork,designSha,head)],accepted:false},
  {name:'equal SHAs with exact target proof may be accepted',head:designSha,proofs:head=>[proof(upstream,designSha,head)],accepted:true},
];

describe('authorized adopted fork PR retains exact target-repository design responsibility',()=>{
  for(const row of proofCases)test(row.name,()=>exercise(row.name,scenario=>{
    const head = row.head??submittedHead;
    scenario.sourceHead(head);
    scenario.facts = {...scenario.facts,commits:row.proofs(head)};
    const originalWork = structuredClone(scenario.member.work);
    const originalVersion = scenario.state.version;
    const result = scenario.submit(head);
    if(row.accepted) {
      expect(result.kind).toBe('next');
      if(result.kind!=='next')throw new Error(`Exact source proof rejected: ${JSON.stringify(result)}`);
      expect(result.reply?.outcome).toBe('accepted');
      expect(scenario.member.work).toBeNull();
      expect(scenario.member.baseline).toMatchObject({kind:'submitted',submission:{workId:originalWork?.id,payload:{head,branch}}});
      expect(scenario.member.binding.kind).toBe('publishing');
      const publication = scenario.state.effects.filter(effect=>effect.action.kind==='publishPr');
      expect(publication).toHaveLength(1);
      expect(publication[0]).toMatchObject({state:{kind:'ready'},action:{kind:'publishPr',pr:adoptedPr,headRepo:fork,target:{repo:upstream,base:'main'},submission:{workId:originalWork?.id,payload:{head}}}});
      const action = publication[0]?.action;
      if(action?.kind!=='publishPr')throw new Error('Accepted submission omitted its durable publication');
      expect(action.body).toContain(`https://github.com/${upstream.owner}/${upstream.name}/commit/${designSha}`);
      expect(scenario.state.effects.some(effect=>effect.action.kind==='merge')).toBe(false);
      expect(tickets(scenario.state,scenario.input()).some(ticket=>ticket.allowedReplies.includes('verdict'))).toBe(false);
    } else {
      expect(result.kind).toBe('rejected');
      if(result.kind!=='rejected')throw new Error('Submission without exact source proof was accepted');
      expect(result.error.kind).toBe('missingDesignCommit');
      expect(scenario.state.version).toBe(originalVersion);
      expect(scenario.member.work).toEqual(originalWork);
      expect(scenario.member.baseline).toEqual({kind:'adopted',pr:adoptedPr,acceptedHead:adoptedHead});
      expect(scenario.state.effects.some(effect=>effect.action.kind==='publishPr'||effect.action.kind==='merge')).toBe(false);
    }
  }));

  const sourceChanges:readonly {name:string;change:(scenario:Scenario)=>void;payload?:Partial<PrSubmit>}[] = [
    {name:'actual fork remote branch has a different head',change:scenario=>{scenario.facts = {...scenario.facts,branches:scenario.facts.branches.map(remote=>remote.repo.owner===fork.owner&&remote.name===branch?{...remote,state:{kind:'present',head:otherHead}}:remote)};}},
    {name:'actual fork branch is missing despite a same-named target branch',change:scenario=>{scenario.facts = {...scenario.facts,branches:[...scenario.facts.branches.map(remote=>remote.repo.owner===fork.owner&&remote.name===branch?{...remote,state:{kind:'missing'} as const}:remote),{repo:upstream,name:branch,state:{kind:'present',head:submittedHead}}]};}},
    {name:'registered PR has advanced beyond submitted branch head',change:scenario=>{scenario.facts = {...scenario.facts,prs:scenario.facts.prs.map(pr=>({...pr,head:otherHead}))};}},
    {name:'registered PR base changed to another existing base',change:scenario=>{scenario.facts = {...scenario.facts,prs:scenario.facts.prs.map(pr=>({...pr,target:{repo:upstream,base:'release'}}))};}},
    {name:'closed adopted PR is not replaced by a similar open PR',change:scenario=>{const current=scenario.facts.prs[0];if(!current)throw new Error('Missing source PR');scenario.facts = {...scenario.facts,prs:[{...current,state:{kind:'closed'}},{...current,ref:{repo:upstream,number:32}}]};}},
    {name:'another real fork branch cannot replace the registered PR branch',change:scenario=>{scenario.facts = {...scenario.facts,branches:[...scenario.facts.branches,{repo:fork,name:'other/repair',state:{kind:'present',head:submittedHead}}]};},payload:{branch:'other/repair'}},
    {name:'stale submitted SHA cannot use a proof for an older head',change:()=>{},payload:{head:adoptedHead}},
  ];
  for(const row of sourceChanges)test(`exact design proof does not bypass ${row.name}`,()=>exercise(row.name,scenario=>{
    scenario.sourceHead(submittedHead);
    scenario.facts = {...scenario.facts,commits:[proof(upstream),proof(upstream,designSha,adoptedHead)]};
    row.change(scenario);
    const work = structuredClone(scenario.member.work);
    const result = scenario.submit(submittedHead,row.payload);
    expect(result.kind).toBe('rejected');
    if(result.kind!=='rejected')throw new Error('Design proof bypassed current branch/PR/target checks');
    expect(result.error.kind).toBe('premiseChanged');
    expect(scenario.member.work).toEqual(work);
    expect(scenario.state.effects.some(effect=>effect.action.kind==='publishPr'||effect.action.kind==='merge')).toBe(false);
  }));
});
