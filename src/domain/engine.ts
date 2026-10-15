import type {Action,Agenda,Amendment,ApplyingRef,CaseDecision,CaseSubject,Context,ConveneInput,DecisionCase,DeliveryAnchor,DesignRequirement,DomainError,DomainRef,Effect,EffectCancelReason,EffectResult,Entry,Event,Facts,GateJob,GateKind,GateStamp,HoldRef,HostObservation,Inputs,Insertion,IssueRef,Member,OwnerPhase,OwnerWork,PortError,PrSnapshot,ProtocolReply,Receipt,ReplyResult,Result,SeatRequest,ShaRef,SourceChangeCause,SourceCondition,Ticket,Transition,Unit,VerifyRepo,WorkReason} from './model.ts';
import {agendaIdSchema,conveneSchema,factsSchema} from './model.ts';
import {availability,bodyHash,canonical,caseOpen,contains,digest,domainObjects,effectOpen,exactClosingBody,gateOf,headContains,issueStateBaselineMatches,memberEnded,memberOf,memberStamp,nextId,publicationAssociation,refKey,repoKey,sameRef,sameRepo,sourceMergedPr,unitEnded,unitOf,verificationContinuity,verificationTargets} from './identity.ts';
import {parseEvent} from './parse.ts';
import {tickets} from './tickets.ts';
import {applyDecision} from './decisions.ts';
import {callerOwns,candidateFor,mainCaller} from './tickets.ts';

const contextOf=(member:Member):Context=>({kind:'member',member:member.ref});
function error(kind:DomainError['kind'],message:string):DomainError{return {kind,message,current:null};}
function source(input:Inputs):Facts|undefined{return input.facts.kind==='available'?input.facts.facts:undefined;}
function issueOf(input:Inputs,ref:IssueRef){return source(input)?.issues.find(issue=>sameRef(issue.ref,ref));}
function prOf(input:Inputs,ref:IssueRef){return source(input)?.prs.find(pr=>sameRef(pr.ref,ref));}
function baseOf(input:Inputs,member:Member){return source(input)?.repos.find(repo=>sameRepo(repo.repo,member.target.repo))?.bases.find(base=>base.name===member.target.base);}
function boundPr(member:Member,input:Inputs):PrSnapshot|undefined {
  const ref=member.binding.kind==='registered'?member.binding.pr:member.binding.kind==='publishing'&&member.binding.previous.kind==='registered'?member.binding.previous.pr:null;
  return ref?prOf(input,ref):undefined;
}
function acceptedHead(member:Member):string|null {
  switch(member.baseline.kind){case 'none':return null;case 'adopted':return member.baseline.acceptedHead;case 'submitted':return member.baseline.submission.payload.head;}
}
function initializeMember(entry:Entry,facts:Facts):Result<Member,DomainError> {
  const issue=facts.issues.find(item=>sameRef(item.ref,entry.issue));
  const base=facts.repos.find(item=>sameRepo(item.repo,entry.target.repo))?.bases.find(item=>item.name===entry.target.base);
  if(!issue||base?.state.kind!=='present')return {ok:false,error:error('premiseChanged','Issue or target base is unavailable')};
  const member:Member={ref:entry.issue,target:entry.target,designOnly:entry.designOnly,contract:{revision:1,bodyHash:issue.bodyHash,body:issue.body,requirements:[]},baseline:{kind:'none'},binding:{kind:'none'},work:null,terminal:{kind:'pending'},ownerTerminal:null,ownerReceipt:null,ownerRequestId:null,review:null,accept:null,rulings:[],fixedChecks:[],reconciledEvent:null};
  if(entry.adoptPr){
    const pr=facts.prs.find(item=>sameRef(item.ref,entry.adoptPr!));
    const maintenance=facts.maintenance.find(item=>sameRef(item.pr,entry.adoptPr!));
    if(!pr||pr.state.kind!=='open'||!sameRepo(pr.target.repo,entry.target.repo)||pr.target.base!==entry.target.base||maintenance?.result.kind!=='maintainable')return {ok:false,error:error('premiseChanged','Adoption requires an open, authorized, source-maintainable exact target PR')};
    if(!(pr.closes.length===1&&sameRef(pr.closes[0]!,entry.issue))&&!(pr.closes.length===0&&!base.state.isDefault&&exactClosingBody(pr.body,entry.issue,pr.target.repo)))return {ok:false,error:error('premiseChanged','Adoption must close exactly this member')};
    member.baseline={kind:'adopted',pr:pr.ref,acceptedHead:pr.head};
    member.binding={kind:'registered',pr:pr.ref,headRepo:pr.headRepo,branch:pr.headBranch,origin:'adopted'};
  }
  return {ok:true,value:member};
}
export function createAgenda(input:ConveneInput,facts:Facts,now:number,id:string):Result<Agenda,DomainError> {
  const parsed=conveneSchema.safeParse(input);const read=factsSchema.safeParse(facts);
  if(!parsed.success||!read.success)return {ok:false,error:error('premiseChanged','Invalid convene input or incomplete facts')};
  if(!Number.isSafeInteger(now)||now<0||!agendaIdSchema.safeParse(id).success)return {ok:false,error:error('premiseChanged','Invalid agenda identity or convenedAt')};
  const seen=new Set<string>();
  const units:Unit[]=[];
  let ordinal=1;
  for(const entry of parsed.data.entries){
    if(seen.has(refKey(entry.issue)))return {ok:false,error:error('premiseChanged','Duplicate agenda member')};
    seen.add(refKey(entry.issue));
    const member=initializeMember(entry,read.data);if(!member.ok)return member;
    units.push({id:`${id}/unit/${ordinal++}`,members:[member.value],postMerge:null,rulings:[]});
  }
  if(parsed.data.parent){
    const parent=read.data.issues.find(issue=>sameRef(issue.ref,parsed.data.parent!));
    if(!parent||parsed.data.entries.some(entry=>!parent.children.some(child=>sameRef(child,entry.issue))))return {ok:false,error:error('premiseChanged','Parent source does not contain every convened child')};
  }
  return {ok:true,value:{id,version:1,nextId:ordinal,convenedAt:now,lifecycle:'active',units,parent:input.parent,closure:null,rulings:[],cases:[],designWorks:[],drafts:[],amendments:[],effects:[],requests:[],run:{kind:'detached'},report:null}};
}
function addHold(work:OwnerWork,hold:HoldRef):void {if(!work.holds.some(item=>canonical(item)===canonical(hold)))work.holds.push(hold);}
function invalidateGates(member:Member,reason:'sourceChanged'|'workOpened'|'superseded'):void {
  for(const gate of [member.review,member.accept])if(gate&&gate.status.kind!=='cancelled')gate.status={kind:'cancelled',reason};
}
function newCase(state:Agenda,context:Context,subject:CaseSubject,evidence:string,input:Inputs):DecisionCase {
  const bodyBaselines=caseBodyBaselines(state,context,subject,input);
  return allocateCase(state,context,subject,evidence,bodyBaselines);
}
function caseBodyBaselines(state:Agenda,context:Context,subject:CaseSubject,input:Inputs):DecisionCase['bodyBaselines'] {
  const baselines=context.kind==='member'?[context.member]:context.kind==='unit'?state.units.find(unit=>unit.id===context.unitId)?.members.map(member=>member.ref)??[]:state.parent?[state.parent]:[];
  const claimedGate=subject.kind==='claim'&&subject.ticket.startsWith('gate:')?gateOf(state,subject.ticket.slice(5)):undefined;
  return baselines.flatMap(ref=>{
    const sourceHash=issueOf(input,ref)?.bodyHash;
    const acceptedHash=subject.kind==='claim'?memberOf(state,ref)?.contract.bodyHash??(claimedGate?.stamp.kind==='closure'&&sameRef(claimedGate.stamp.parent,ref)?claimedGate.stamp.bodyHash:undefined):undefined;
    const hash=sourceHash??acceptedHash;return hash?[{issue:ref,hash}]:[];
  });
}
function allocateCase(state:Agenda,context:Context,subject:CaseSubject,evidence:string,bodyBaselines:DecisionCase['bodyBaselines']):DecisionCase {
  const existing=state.cases.find(item=>canonical(item.context)===canonical(context)&&canonical(item.subject)===canonical(subject)&&item.state.kind!=='cancelled');
  if(existing)return existing;
  const item:DecisionCase={id:nextId(state,'case'),contentVersion:1,context,subject,evidence,bodyBaselines,state:{kind:'open'},openedBy:null,receipt:null};
  state.cases.push(item);
  if(context.kind==='member'){
    const member=memberOf(state,context.member);
    if(member?.work&&subject.kind!=='hostPrecondition'&&subject.kind!=='effectFailure')addHold(member.work,{kind:'case',caseId:item.id});
    if(member&&(subject.kind==='unexpectedSourceChange'||subject.kind==='closed'||subject.kind==='reopened'))invalidateGates(member,'sourceChanged');
  }
  return item;
}
function openWork(state:Agenda,member:Member,reason:WorkReason,input:Inputs):OwnerWork {
  const publication=state.effects.find(effect=>effect.action.kind==='publishPr'&&sameRef(effect.action.member,member.ref)&&(effect.state.kind==='ready'||effect.state.kind==='executing'||effect.state.kind==='uncertain'));
  if(member.work){
    const index=member.work.reasons.findIndex(item=>item.kind===reason.kind);
    if(index<0)member.work.reasons.push(reason);else member.work.reasons[index]=reason;
    if(publication)addHold(member.work,{kind:'effect',effectId:publication.id});
    return member.work;
  }
  const base=baseOf(input,member);
  if(base?.state.kind!=='present')throw new Error('openWork requires source target base');
  const pr=boundPr(member,input);
  const branchName=member.binding.kind==='registered'?member.binding.branch:publication?.action.kind==='publishPr'?publication.action.submission.payload.branch:member.baseline.kind==='submitted'?member.baseline.submission.payload.branch:null;
  const headRepo=member.binding.kind==='registered'?member.binding.headRepo:publication?.action.kind==='publishPr'?publication.action.headRepo:member.target.repo;
  const branch=source(input)?.branches.find(branch=>sameRepo(branch.repo,headRepo)&&branch.name===branchName);
  const baseline=pr?.head??(branch?.state.kind==='present'?branch.state.head:base.state.head);
  const work:OwnerWork={id:nextId(state,'work'),member:member.ref,reasons:[reason],required:member.contract.requirements.filter(requirement=>requirement.carrier.kind==='member'&&sameRef(requirement.carrier.member,member.ref)).map(requirement=>requirement.commit),target:member.target,baseline,contentVersion:1,holds:publication?[{kind:'effect',effectId:publication.id}]:[]};
  member.work=work;invalidateChangedGates(member,input);
  for(const item of state.cases)if(canonical(item.context)===canonical(contextOf(member))&&item.state.kind!=='resolved'&&item.state.kind!=='cancelled'&&item.subject.kind!=='effectFailure'&&item.subject.kind!=='hostPrecondition')addHold(work,{kind:'case',caseId:item.id});
  for(const amendment of state.amendments)if(amendment.state.kind==='pending'&&amendment.affected.some(ref=>sameRef(ref,member.ref)))addHold(work,{kind:'amendment',id:amendment.id});
  for(const item of state.cases)if(item.subject.kind==='migration'&&item.state.kind==='resolved'&&item.state.result.kind==='assignMigration'){
    const destination=item.state.result.migration;
    const assigned='number'in destination?sameRef(destination,member.ref):state.drafts.some(draft=>draft.caseId===item.id&&draft.state.kind==='placed'&&sameRef(draft.state.member,member.ref));
    if(assigned){const original=memberOf(state,item.subject.original);work.reasons.push({kind:'sourceChange',caseId:item.id,basis:`Migrate the exact original obligation ${refKey(item.subject.original)} after design ${repoKey(item.subject.commit.repo)}@${item.subject.commit.sha}. ${original?.contract.body??item.evidence}`});}
  }
  return work;
}
function addEffect(state:Agenda,scope:Context,action:Action):Effect {
  const existing=state.effects.find(effect=>canonical(effect.action)===canonical(action)&&effect.state.kind!=='cancelled');
  if(existing)return existing;
  const effect:Effect={id:nextId(state,'effect'),scope,action,attempt:0,authorization:'initial',state:{kind:'ready',provenance:{kind:'initial'}}};
  state.effects.push(effect);return effect;
}
function requestFor(state:Agenda,role:SeatRequest['role'],context:Context,input:Pick<Inputs,'host'>,jobId:string|null=null):SeatRequest {
  if(role==='owner'&&context.kind==='member'){
    const member=memberOf(state,context.member);
    const prior=state.requests.find(request=>request.id===member?.ownerRequestId);
    const priorBinding=prior?.binding;
    const holder=priorBinding?.kind==='bound'?input.host.seats.find(seat=>seat.agentId===priorBinding.agentId):undefined;
    if(prior&&prior.runId===input.host.runId&&(priorBinding?.kind==='unbound'||holder&&holder.status!=='aborted'))return prior;
  }
  const id=nextId(state,'request');const name=`Rt${digest(state.id).slice(0,8)}${role}${state.nextId-1}`;
  const obligation:SeatRequest['obligation']=role==='owner'&&context.kind==='member'?{kind:'owner',member:context.member}:{kind:'gate',jobId:jobId!};
  const request:SeatRequest={id,role,context,obligation,name,assignment:`圆桌席位 ${name}；完整票据由 context 注入；先调 roundtable tickets，再按票据工作`,runId:input.host.runId,binding:{kind:'unbound'},receipt:null};
  state.requests.push(request);
  if(role==='owner'&&context.kind==='member'){const member=memberOf(state,context.member);if(member)member.ownerRequestId=id;}
  return request;
}
function newGate(state:Agenda,kind:GateKind,context:Context,stamp:GateStamp,input:Pick<Inputs,'host'>):GateJob {
  const id=nextId(state,'gate');const request=requestFor(state,kind,context,input,id);
  return {id,kind,context,stamp,requestId:request.id,status:{kind:'requested'},receipt:null};
}
function memberGateStamp(member:Member,pr:PrSnapshot,kind:'review'|'accept'):GateStamp {
  const shared={pr:pr.ref,head:acceptedHead(member)!,target:member.target,member:memberStamp(member),rulings:member.rulings.filter(item=>item.kind===kind&&item.ruling.applicableContractRevision===member.contract.revision).map(item=>item.ruling)};
  return kind==='review'?{kind,...shared,prBodyHash:pr.bodyHash}:{kind,...shared};
}
function invalidateChangedGates(member:Member,input:Inputs):void {
  if(member.terminal.kind==='merged')return;
  const pr=boundPr(member,input);const issue=issueOf(input,member.ref);
  if(!source(input))return;
  for(const kind of ['review','accept'] as const){
    const gate=member[kind];if(!gate||gate.status.kind==='cancelled')continue;
    if(!pr||pr.state.kind!=='open'||gate.stamp.kind!==kind||gate.stamp.head!==pr.head||canonical(pr.target)!==canonical(member.target)||issue?.bodyHash!==member.contract.bodyHash||canonical(gate.stamp)!==canonical(memberGateStamp(member,pr,kind)))gate.status={kind:'cancelled',reason:'sourceChanged'};
  }
}
function gateHolderLost(state:Agenda,gate:GateJob,input:Pick<Inputs,'host'>):boolean {
  if(gate.status.kind!=='requested')return false;
  const request=state.requests.find(request=>request.id===gate.requestId);
  if(!request||request.runId!==input.host.runId)return true;
  const binding=request.binding;
  return binding.kind==='bound'&&!input.host.seats.some(seat=>seat.agentId===binding.agentId&&seat.parentId===binding.parentId&&seat.status!=='aborted');
}
function ensureGate(state:Agenda,member:Member,pr:PrSnapshot,kind:'review'|'accept',input:Inputs):void {
  const stamp=memberGateStamp(member,pr,kind);const old=member[kind];
  if(old&&old.status.kind!=='cancelled'&&!gateHolderLost(state,old,input)&&canonical(old.stamp)===canonical(stamp))return;
  member[kind]=newGate(state,kind,contextOf(member),stamp,input);
}
type VerificationComparison={ancestor:ShaRef;descendant:ShaRef};
function verificationGap(state:Agenda,kind:'postMerge'|'closure',context:Context,comparisons:readonly VerificationComparison[],input:Inputs):void {
  const first=comparisons[0];if(!first)return;
  const subject:CaseSubject={kind,cause:{kind:'ancestry',comparisons:[first,...comparisons.slice(1)]}};
  const gate=context.kind==='unit'?state.units.find(unit=>unit.id===context.unitId)?.postMerge:kind==='closure'?state.closure:null;
  if(gate&&gate.status.kind!=='cancelled')gate.status={kind:'cancelled',reason:'sourceChanged'};
  const prior=state.cases.find(item=>item.subject.kind===kind&&item.subject.cause.kind==='ancestry'&&canonical(item.context)===canonical(context)&&item.state.kind!=='cancelled');
  if(prior){
    if(prior.state.kind==='applying')return;
    if(prior.state.kind==='resolved'||canonical(prior.subject)!==canonical(subject)){prior.subject=subject;prior.state={kind:'open'};prior.contentVersion++;prior.evidence=canonical(comparisons);}
  }else newCase(state,context,subject,`Source proves required merge ancestry is not contained: ${canonical(comparisons)}`,input);
}
function verificationRepos(state:Agenda,unit:Unit,input:Inputs,prior:GateJob|null):VerifyRepo[]|null {
  const facts=source(input);if(!facts)return null;
  const repos=verificationTargets(state,unit,facts,prior);if(!repos)return null;
  const gaps:VerificationComparison[]=[];let complete=true;
  for(const item of repos)for(const sha of item.merges){
    const merge={repo:item.repo,sha};
    if(!contains(input,merge,item.commit)){
      complete=false;
      if(facts.commits.some(pair=>sameRepo(pair.repo,merge.repo)&&pair.ancestor===merge.sha&&pair.descendant===item.commit&&pair.result==='notContained'))gaps.push({ancestor:merge,descendant:{repo:item.repo,sha:item.commit}});
    }
  }
  for(const member of unit.members)for(const requirement of member.contract.requirements){
    let item=repos.find(item=>sameRepo(item.repo,requirement.commit.repo));
    if(!item){
      const repo=facts.repos.find(repo=>sameRepo(repo.repo,requirement.commit.repo));if(!repo)return null;
      item={repo:repo.repo,commit:repo.defaultHead,merges:[]};repos.push(item);
    }
    if(!contains(input,requirement.commit,item.commit)){
      complete=false;
      if(facts.commits.some(pair=>sameRepo(pair.repo,requirement.commit.repo)&&pair.ancestor===requirement.commit.sha&&pair.descendant===item.commit&&pair.result==='notContained'))gaps.push({ancestor:requirement.commit,descendant:{repo:item.repo,sha:item.commit}});
    }
  }
  for(const comparison of verificationContinuity(state,unit,repos,facts)){
    if(contains(input,comparison.ancestor,comparison.descendant.sha))continue;
    complete=false;
    if(facts.commits.some(pair=>sameRepo(pair.repo,comparison.ancestor.repo)&&pair.ancestor===comparison.ancestor.sha&&pair.descendant===comparison.descendant.sha&&pair.result==='notContained'))gaps.push(comparison);
  }
  if(gaps.length)verificationGap(state,'postMerge',{kind:'unit',unitId:unit.id},gaps,input);
  return complete?repos:null;
}
function sourceConditionMet(condition:SourceCondition,input:Inputs):boolean {
  const facts=source(input);if(!facts)return false;
  switch(condition.kind){
    case 'checksSettled':{const pr=prOf(input,condition.pr);return !!pr&&(pr.checks.kind==='passing'||pr.checks.kind==='failing')&&facts.checkAttempts.some(run=>sameRepo(run.repo,condition.pr.repo)&&run.workflowRunId===condition.runId);}
    case 'bodyChanged':return !!issueOf(input,condition.issue)&&issueOf(input,condition.issue)!.bodyHash!==condition.fromHash;
    case 'commitLanded':{const repo=facts.repos.find(repo=>sameRepo(repo.repo,condition.commit.repo));return !!repo&&contains(input,condition.commit,repo.defaultHead);}
    case 'issueState':return issueOf(input,condition.issue)?.state===(condition.open?'open':'closed');
    case 'prChanged':{const pr=prOf(input,condition.pr);return !!pr&&(pr.head!==condition.fromHead||pr.state.kind!=='open');}
    case 'mainRelease':return false;
  }
}
function applyingDone(state:Agenda,ref:ApplyingRef):boolean {
  switch(ref.kind){
    case 'design':return state.designWorks.find(work=>work.id===ref.workId)?.result!==null&&state.designWorks.some(work=>work.id===ref.workId);
    case 'amendment':return state.amendments.find(item=>item.id===ref.id)?.state.kind==='effective';
    case 'effect':return state.effects.find(item=>item.id===ref.effectId)?.state.kind==='confirmed';
    case 'draft':{const draft=state.drafts.find(item=>item.id===ref.draftId);return !!draft&&(draft.state.kind==='placed'||(draft.position.kind==='outsideAgenda'&&draft.state.kind==='registered'&&draft.attachmentEffectIds.every(id=>state.effects.find(effect=>effect.id===id)?.state.kind==='confirmed')));}
  }
}
function classifySource(state:Agenda,input:Inputs):void {
  const facts=source(input);if(!facts)return;
  for(const unit of state.units)for(const member of unit.members){
    const issue=issueOf(input,member.ref);if(!issue)continue;
    const merged=sourceMergedPr(member,facts);
    if(merged?.state.kind==='merged'){
      if(member.work){member.ownerTerminal={kind:'externallyMerged',workId:member.work.id,pr:merged.ref,merge:{repo:merged.target.repo,sha:merged.state.sha},mergedAt:merged.state.at};member.work=null;}
      member.terminal={kind:'merged',pr:merged.ref,merge:{repo:merged.target.repo,sha:merged.state.sha},at:merged.state.at};
      for(const gate of [member.review,member.accept]){
        if(!gate)continue;
        switch(gate.status.kind){
          case 'requested':gate.status={kind:'cancelled',reason:'superseded'};break;
          case 'answered':
            if((gate.stamp.kind!=='review'&&gate.stamp.kind!=='accept')||gate.stamp.head!==merged.head||!sameRepo(gate.stamp.target.repo,merged.target.repo)||gate.stamp.target.base!==merged.target.base)gate.status={kind:'cancelled',reason:'superseded'};
            break;
          case 'cancelled':break;
        }
      }
      for(const item of state.cases)if(canonical(item.context)===canonical(contextOf(member))&&item.state.kind!=='resolved'&&item.state.kind!=='cancelled'&&(item.subject.kind==='closed'||item.subject.kind==='unexpectedSourceChange'&&item.subject.cause.reason!=='bodyChanged'&&item.subject.cause.reason!=='noCodeBodyChanged'))item.state={kind:'cancelled',reason:'externallyMerged'};
    }
    if(member.terminal.kind==='noCode'&&member.terminal.bodyHash!==issue.bodyHash){member.terminal={kind:'pending'};newCase(state,contextOf(member),{kind:'unexpectedSourceChange',member:member.ref,cause:{reason:'noCodeBodyChanged',contractRevision:member.contract.revision},bodyHash:issue.bodyHash},'No-code basis changed at source',input);}
    const bodyIntent=state.amendments.some(amendment=>amendment.state.kind==='pending'&&amendment.state.bodyEdits.some(edit=>sameRef(edit.issue,member.ref)));
    if(!bodyIntent&&issue.bodyHash!==member.contract.bodyHash&&member.terminal.kind!=='noCode'&&!state.cases.some(item=>canonical(item.context)===canonical(contextOf(member))&&(item.state.kind==='open'||item.state.kind==='awaitingExternal')&&item.bodyBaselines.some(base=>sameRef(base.issue,member.ref)&&base.hash===issue.bodyHash)))newCase(state,contextOf(member),{kind:'unexpectedSourceChange',member:member.ref,cause:{reason:'bodyChanged',contractRevision:member.contract.revision},bodyHash:issue.bodyHash},'Issue contract body changed at source',input);
    if(member.terminal.kind!=='pending'){
      const establishedAt=member.terminal.kind==='merged'?member.terminal.at:member.terminal.acceptedAt;
      if(issue.state==='open'){
        if(issue.lastReopen&&member.reconciledEvent!==issue.lastReopen.id&&(member.terminal.kind==='noCode'||issue.lastReopen.at>=establishedAt))newCase(state,contextOf(member),{kind:'reopened',member:member.ref,event:issue.lastReopen,bodyHash:issue.bodyHash},'Source reopened a terminal member',input);
        else if(!caseOpen(state,contextOf(member)))addEffect(state,contextOf(member),{kind:'setIssueState',issue:member.ref,open:false,afterEvent:issue.lastReopen,bodyHash:issue.bodyHash});
      }
    }else if(issue.state==='closed')newCase(state,contextOf(member),{kind:'closed',member:member.ref,event:issue.lastClose,bodyHash:issue.bodyHash},'Closed issue has no verified merge or current no-code decision',input);
    if(member.terminal.kind==='pending'&&member.binding.kind==='registered'){
      const pr=prOf(input,member.binding.pr);
      const maintenance=facts.maintenance.find(item=>sameRef(item.pr,member.binding.kind==='registered'?member.binding.pr:member.ref));
      const branch=facts.branches.find(item=>sameRepo(item.repo,member.binding.kind==='registered'?member.binding.headRepo:member.target.repo)&&item.name===(member.binding.kind==='registered'?member.binding.branch:''));
      if(!pr||pr.state.kind!=='open'||!sameRepo(pr.target.repo,member.target.repo)||pr.target.base!==member.target.base||maintenance?.result.kind!=='maintainable'||branch?.state.kind==='missing'){
        const baseline:DeliveryAnchor=member.baseline.kind==='submitted'?{kind:'submitted',workId:member.baseline.submission.workId,head:member.baseline.submission.payload.head}:member.baseline.kind==='adopted'?{kind:'adopted',head:member.baseline.acceptedHead}:{kind:'none'};
        const phase:OwnerPhase=member.work?{kind:'open',workId:member.work.id}:member.ownerTerminal?{kind:'terminal',workId:member.ownerTerminal.workId,result:member.ownerTerminal.kind}:{kind:'none'};
        const anchor={binding:member.binding,baseline,phase};
        const cause:SourceChangeCause=!pr?{reason:'prMissing',...anchor}:pr.state.kind!=='open'?{reason:'prClosed',...anchor,updatedAt:pr.updatedAt}:branch?.state.kind==='missing'?{reason:'branchMissing',...anchor}:{reason:'targetOrMaintenanceChanged',...anchor,updatedAt:pr.updatedAt};
        const carried=member.work?.reasons.some(reason=>reason.kind==='sourceChange'&&state.cases.some(item=>item.id===reason.caseId&&item.subject.kind==='unexpectedSourceChange'&&item.subject.cause.reason===cause.reason&&'binding'in item.subject.cause&&canonical(item.subject.cause.binding)===canonical(member.binding)));
        if(!carried)newCase(state,contextOf(member),{kind:'unexpectedSourceChange',member:member.ref,cause,bodyHash:issue.bodyHash},'Registered PR/branch/target/maintenance changed',input);
      }
    }
  }
  for(const requirement of state.units.flatMap(unit=>unit.members.flatMap(member=>member.contract.requirements))){
    const repo=facts.repos.find(repo=>sameRepo(repo.repo,requirement.commit.repo));if(!repo)continue;
    const landed=contains(input,requirement.commit,repo.defaultHead);
    const carrier=requirement.carrier.kind==='member'?memberOf(state,requirement.carrier.member):undefined;
    const carrierIssue=carrier?issueOf(input,carrier.ref):undefined;
    const pr=carrier?boundPr(carrier,input):undefined;
    const stillCarrying=carrier?.terminal.kind==='merged'||carrier?.terminal.kind==='pending'&&carrierIssue?.state==='open'&&(!pr||pr.state.kind==='open');
    if(landed&&requirement.route.kind==='defaultFirst'&&carrier&&!carrier.designOnly&&carrier.terminal.kind!=='merged'&&(carrier.terminal.kind==='noCode'||carrierIssue?.state==='closed')){
      const migration=state.cases.find(item=>item.subject.kind==='migration'&&sameRef(item.subject.original,carrier.ref)&&canonical(item.subject.commit)===canonical(requirement.commit));
      if(!migration)newCase(state,contextOf(carrier),{kind:'migration',original:carrier.ref,commit:requirement.commit},'A landed default-first design lost its original implementation/migration carrier',input);
      else if(migration.state.kind==='resolved'&&migration.state.result.kind==='assignMigration'){
        const destination=migration.state.result.migration;
        const replacement='number'in destination?memberOf(state,destination):state.drafts.find(draft=>draft.caseId===migration.id&&draft.state.kind==='placed');
        const replacementMember=replacement&&'ref'in replacement?replacement:replacement&&'state'in replacement&&replacement.state.kind==='placed'?memberOf(state,replacement.state.member):undefined;
        if(replacementMember&&replacementMember.terminal.kind!=='merged'&&(replacementMember.terminal.kind==='noCode'||issueOf(input,replacementMember.ref)?.state==='closed')){migration.state={kind:'open'};migration.contentVersion++;}
      }
    }
    if(!landed&&!stillCarrying&&requirement.carrier.kind==='member'){
      const original=state.cases.find(item=>item.id===requirement.caseId);
      if(original?.state.kind==='resolved'){
        original.subject={kind:'orphanDesign',requirement};original.context=carrier?contextOf(carrier):{kind:'agenda'};original.evidence='The exact unlanded design commit lost its declared carrier';original.state={kind:'open'};original.contentVersion++;
        original.bodyBaselines=carrierIssue?[{issue:carrierIssue.ref,hash:carrierIssue.bodyHash}]:[];
        if(carrier?.work)addHold(carrier.work,{kind:'case',caseId:original.id});
      }else if(!original)newCase(state,carrier?contextOf(carrier):{kind:'agenda'},{kind:'orphanDesign',requirement},'Unlanded design commit has no viable carrier',input);
    }
  }
  if(state.parent){
    const parent=issueOf(input,state.parent);
    if(parent)for(const item of state.cases)if(item.subject.kind==='agendaGap'&&(item.state.kind==='open'||item.state.kind==='awaitingExternal')&&!parent.children.some(child=>item.subject.kind==='agendaGap'&&sameRef(child,item.subject.issue)))item.state={kind:'cancelled',reason:'parentRemoved'};
    for(const item of state.cases)if(item.subject.kind==='agendaGap'&&(item.state.kind==='open'||item.state.kind==='awaitingExternal')&&memberOf(state,item.subject.issue))item.state={kind:'cancelled',reason:'sourceEventSuperseded'};
  }
}
function advanceObjects(state:Agenda,input:Inputs):void {
  for(const item of state.cases){
    const initialVersion=item.contentVersion;
    const verification=item.subject;
    if((verification.kind==='closed'||verification.kind==='reopened')&&(item.state.kind==='open'||item.state.kind==='awaitingExternal')){
      const issue=issueOf(input,verification.member);const event=verification.kind==='closed'?issue?.lastClose:issue?.lastReopen;
      if(issue&&(event?.id!==verification.event?.id||issue.state!==(verification.kind==='closed'?'closed':'open')))item.state={kind:'cancelled',reason:'sourceEventSuperseded'};
    }
    if(verification.kind==='closure'&&verification.cause.kind==='ancestry'&&(item.state.kind==='open'||item.state.kind==='awaitingExternal')&&verification.cause.comparisons.every(pair=>{
      const repo=source(input)?.repos.find(repo=>sameRepo(repo.repo,pair.ancestor.repo));return repo!==undefined&&contains(input,pair.ancestor,repo.defaultHead);
    }))item.state={kind:'cancelled',reason:'sourceEventSuperseded'};
    if(item.state.kind==='awaitingExternal'){
      const wait=item.state.wait;
      if(wait.kind==='caseSource'&&sourceConditionMet(wait.condition,input)){item.state={kind:'open'};item.contentVersion++;}
      if(wait.kind==='effect'){
        const effect=state.effects.find(effect=>effect.id===wait.effectId);
        if(effect&&(effect.state.kind==='failed'||effect.state.kind==='uncertain')){
          const effectWait=effect.state.wait;
          const released=effectWait?.kind==='source'?sourceConditionMet(effectWait.condition,input):effectWait?.kind==='rateLimitReset'&&input.facts.kind==='available'&&input.facts.observedAt>=effectWait.resetAt;
          if(released){effect.state.wait=null;item.state={kind:'open'};item.contentVersion++;}
        }
      }
    }
    if(item.state.kind==='open'){
      const changed=item.bodyBaselines.some(base=>{const issue=issueOf(input,base.issue);return issue&&issue.bodyHash!==base.hash;});
      if(changed){item.bodyBaselines=item.bodyBaselines.map(base=>({issue:base.issue,hash:issueOf(input,base.issue)?.bodyHash??base.hash}));if(item.contentVersion===initialVersion)item.contentVersion++;}
    }
  }
  for(const draft of state.drafts){
    if(draft.state.kind==='proposed'){
      const creation=state.effects.find(effect=>effect.id===draft.creationEffectId);
      if(creation?.state.kind==='confirmed'&&creation.state.result.kind==='created')draft.state={kind:'registered',issue:creation.state.result.issue};
    }
    if(draft.state.kind==='registered'){
      if(draft.parent){
        const parent=issueOf(input,draft.parent);
        if(parent&&!parent.children.some(child=>draft.state.kind==='registered'&&sameRef(child,draft.state.issue))){
          const effect=addEffect(state,draft.scope,{kind:'attachChild',owner:{kind:'draft',draftId:draft.id},parent:draft.parent,child:draft.state.issue});
          if(!draft.attachmentEffectIds.includes(effect.id))draft.attachmentEffectIds.push(effect.id);
        }
      }
      const attached=!draft.parent||issueOf(input,draft.parent)?.children.some(child=>draft.state.kind==='registered'&&sameRef(child,draft.state.issue));
      const grouped=state.amendments.some(amendment=>amendment.state.kind==='pending'&&amendment.state.insertions.some(ref=>ref.kind==='draft'&&ref.draftId===draft.id));
      if(attached&&!grouped&&draft.attachmentEffectIds.every(id=>state.effects.find(effect=>effect.id===id)?.state.kind==='confirmed')&&draft.position.kind!=='outsideAgenda'){
        const facts=source(input);if(!facts)continue;
        const made=initializeMember({issue:draft.state.issue,target:draft.spec.target,designOnly:draft.spec.designOnly,adoptPr:null},facts);
        if(made.ok){const placed=placeMember(state,made.value,draft.position,input);if(placed.ok){draft.state={kind:'placed',member:made.value.ref};if(draft.requirement){const requirement={...draft.requirement,carrier:{kind:'member' as const,member:made.value.ref}};made.value.contract.requirements.push(requirement);}}}
      }
    }
  }
  for(const amendment of state.amendments){
    if(amendment.state.kind!=='pending')continue;
    const pending=amendment.state;
    const editsDone=pending.bodyEdits.every(edit=>issueOf(input,edit.issue)?.bodyHash===bodyHash(edit.body));
    const designDone=pending.designWork===null||state.designWorks.find(work=>work.id===pending.designWork)?.result!==null&&state.designWorks.some(work=>work.id===pending.designWork);
    const draftsReady=pending.insertions.every(ref=>{
      if(ref.kind==='existing')return !state.parent||issueOf(input,state.parent)?.children.some(child=>sameRef(child,ref.entry.issue))===true;
      const draft=state.drafts.find(draft=>draft.id===ref.draftId);
      return !!draft&&draft.state.kind==='registered'&&draft.attachmentEffectIds.every(id=>state.effects.find(effect=>effect.id===id)?.state.kind==='confirmed')&&(!draft.parent||issueOf(input,draft.parent)?.children.some(child=>draft.state.kind==='registered'&&sameRef(child,draft.state.issue)));
    });
    if(!editsDone||!designDone||!pending.requiredEffectIds.every(id=>state.effects.find(effect=>effect.id===id)?.state.kind==='confirmed')||!draftsReady)continue;
    const placements:Placement[]=[];const placedDrafts:Agenda['drafts']=[];
    const facts=source(input);if(!facts)continue;
    let valid=true;
    for(const ref of pending.insertions){
      if(ref.kind==='existing'){
        const made=initializeMember(ref.entry,facts);if(!made.ok||ref.position.kind==='outsideAgenda'){valid=false;break;}placements.push({member:made.value,position:ref.position});
      }else{
        const draft=state.drafts.find(draft=>draft.id===ref.draftId);
        if(!draft||draft.state.kind!=='registered'){valid=false;break;}
        if(draft.position.kind==='outsideAgenda')continue;
        const made=initializeMember({issue:draft.state.issue,target:draft.spec.target,designOnly:draft.spec.designOnly,adoptPr:null},facts);
        if(!made.ok){valid=false;break;}
        if(draft.requirement)made.value.contract.requirements.push({...draft.requirement,carrier:{kind:'member',member:made.value.ref}});
        placements.push({member:made.value,position:draft.position});placedDrafts.push(draft);
      }
    }
    if(!valid)continue;
    const parent=state.cases.find(item=>item.id===amendment.caseId);
    const designCorrection=parent?.state.kind==='applying'&&parent.state.decision.kind==='correctDesign';
    if(designCorrection){
      const design=state.designWorks.find(work=>work.id===pending.designWork);
      if(!design?.result||placements.length!==1||!sameRepo(placements[0]!.member.target.repo,design.result.repo))continue;
      const member=placements[0]!.member;
      member.contract.requirements.push({caseId:amendment.caseId,commit:design.result,carrier:{kind:'member',member:member.ref},route:{kind:'defaultFirst',repo:member.target.repo}});
    }
    const placed=placeMembers(state,placements,input);if(!placed.ok)continue;
    for(const draft of placedDrafts)if(draft.state.kind==='registered')draft.state={kind:'placed',member:draft.state.issue};
    let appliedRevision=1;
    if(!designCorrection)for(const ref of amendment.affected){const member=memberOf(state,ref);if(!member)continue;member.contract.revision++;appliedRevision=Math.max(appliedRevision,member.contract.revision);const current=issueOf(input,ref);if(current){member.contract.body=current.body;member.contract.bodyHash=current.bodyHash;}member.rulings=member.rulings.filter(item=>item.ruling.applicableContractRevision===member.contract.revision);if(member.work){member.work.contentVersion++;member.work.required=member.contract.requirements.filter(requirement=>requirement.carrier.kind==='member'&&sameRef(requirement.carrier.member,member.ref)).map(requirement=>requirement.commit);}invalidateGates(member,'sourceChanged');}
    amendment.state={kind:'effective',revision:appliedRevision};
  }
  for(const item of state.cases)if(item.state.kind==='applying'&&item.state.required.every(ref=>applyingDone(state,ref))){
    const insertions=state.effects.flatMap(effect=>{
      const action=effect.action;
      return action.kind==='attachChild'&&action.owner.kind==='insertion'&&action.owner.caseId===item.id&&item.state.kind==='applying'&&item.state.required.some(ref=>ref.kind==='effect'&&ref.effectId===effect.id)?[{action,insertion:action.owner.insertion}]:[];
    });
    const placements:Placement[]=[];let valid=true;
    for(const {action,insertion}of insertions){
      if(memberOf(state,insertion.entry.issue))continue;
      const facts=source(input);const member=facts?initializeMember(insertion.entry,facts):null;
      if(!member?.ok||insertion.position.kind==='outsideAgenda'||!issueOf(input,action.parent)?.children.some(child=>sameRef(child,action.child))){valid=false;break;}
      placements.push({member:member.value,position:insertion.position});
    }
    if(!valid||!placeMembers(state,placements,input).ok)continue;
    item.state={kind:'resolved',result:item.state.decision};
    if(item.subject.kind==='findings'){const job=gateOf(state,item.subject.jobId);if(job)job.status={kind:'cancelled',reason:'superseded'};}
  }
}
function schedule(state:Agenda,input:Inputs):void {
  const facts=source(input);if(!facts)return;
  const current=state.units.find(unit=>!unitEnded(state,unit,input));
  if(current){
    const currentIndex=state.units.indexOf(current);
    const firstPending=current.members.find(member=>!memberEnded(state,member,input));
    for(const later of state.units.slice(currentIndex+1))for(const member of later.members){
      invalidateGates(member,'workOpened');
      if(member.work&&firstPending)addHold(member.work,{kind:'dependency',member:firstPending.ref});
      for(const effect of state.effects)if(effect.action.kind==='merge'&&sameRef(effect.action.member,member.ref)&&effect.state.kind==='ready')cancelEffect(state,effect,'preconditionChanged',input);
    }
    if(firstPending){
      const member=firstPending;const issue=issueOf(input,member.ref);const pr=boundPr(member,input);
      if(issue?.state==='open'&&member.terminal.kind==='pending'){
        if(member.binding.kind==='none'&&!member.work&&!caseOpen(state,contextOf(member)))openWork(state,member,{kind:'initial'},input);
        if(pr?.state.kind==='open'&&member.binding.kind==='registered'){
          const baseline=acceptedHead(member);
          if(baseline&&pr.head!==baseline)openWork(state,member,{kind:'unsubmittedPush',acceptedHead:baseline},input);
          if(pr.mergeable==='no'){const base=baseOf(input,member);if(base?.state.kind==='present')openWork(state,member,{kind:'conflict',base:base.state.head},input);}
          if(pr.checks.kind==='failing'){
            const fixed=pr.checks.required.every(failure=>member.fixedChecks.some(old=>canonical(old)===canonical(failure)));
            if(!fixed||member.baseline.kind!=='submitted')openWork(state,member,{kind:'checks',failures:pr.checks.required},input);
            else newCase(state,contextOf(member),{kind:'checks',member:member.ref,responseWorkId:member.baseline.submission.workId,failures:pr.checks.required},'The same source check attempt still fails after this exact accepted owner response',input);
          }
          if(member.work===null&&!caseOpen(state,contextOf(member))&&!effectOpen(state,contextOf(member))&&baseline===pr.head){
            ensureGate(state,member,pr,'review',input);ensureGate(state,member,pr,'accept',input);
            if(member.review?.status.kind==='answered'&&member.review.status.ok&&member.accept?.status.kind==='answered'&&member.accept.status.ok&&pr.mergeable==='yes'&&pr.checks.kind==='passing'&&exactClosing(member,pr,input)){
              const predecessors=state.units.slice(0,currentIndex).flatMap(unit=>unit.postMerge?[{unitId:unit.id,jobId:unit.postMerge.id,members:unit.members.map(item=>({member:memberStamp(item),terminal:item.terminal}))}]:[]);
              addEffect(state,contextOf(member),{kind:'merge',member:member.ref,pr:pr.ref,head:pr.head,target:member.target,review:member.review.stamp,accept:member.accept.stamp,predecessors});
            }
          }
        }
      }
      if(member.work&&!member.designOnly)requestFor(state,'owner',contextOf(member),input);
    }else{
      const repos=verificationRepos(state,current,input,current.postMerge);
      if(repos)for(const item of state.cases)if(item.context.kind==='unit'&&item.context.unitId===current.id&&item.subject.kind==='postMerge'&&item.subject.cause.kind==='ancestry'&&(item.state.kind==='open'||item.state.kind==='awaitingExternal'))item.state={kind:'cancelled',reason:'sourceEventSuperseded'};
      if(repos&&!caseOpen(state,{kind:'unit',unitId:current.id})&&!effectOpen(state,{kind:'unit',unitId:current.id})){
        const stamp:GateStamp={kind:'postMerge',unitId:current.id,members:current.members.map(member=>({member:memberStamp(member),terminal:member.terminal})),repos,rulings:current.rulings};
        if(!current.postMerge||current.postMerge.status.kind==='cancelled'||gateHolderLost(state,current.postMerge,input)||canonical(current.postMerge.stamp)!==canonical(stamp))current.postMerge=newGate(state,'postMerge',{kind:'unit',unitId:current.id},stamp,input);
      }
    }
  }
  if(state.parent){
    const parent=issueOf(input,state.parent);
    if(parent){
      for(const child of parent.children)if(!memberOf(state,child)&&!state.drafts.some(draft=>draft.state.kind!=='proposed'&&sameRef(draft.state.kind==='placed'?draft.state.member:draft.state.issue,child)))newCase(state,{kind:'agenda'},{kind:'agendaGap',issue:child,bodyHash:issueOf(input,child)?.bodyHash??parent.bodyHash},'Parent source includes a child outside the agenda',input);
      const completed=state.units.every(unit=>unitEnded(state,unit,input));
      if(completed&&!caseOpen(state,{kind:'agenda'})&&!effectOpen(state,{kind:'agenda'})&&state.designWorks.every(work=>work.result!==null)&&state.drafts.every(draft=>applyingDone(state,{kind:'draft',draftId:draft.id}))){
        const repos:VerifyRepo[]=[];const gaps:VerificationComparison[]=[];let valid=true;
        for(const unit of state.units)for(const member of unit.members)if(member.terminal.kind==='merged'){
          let repo=repos.find(repo=>sameRepo(repo.repo,member.target.repo));
          if(!repo){const snapshot=facts.repos.find(repo=>sameRepo(repo.repo,member.target.repo));if(!snapshot){valid=false;continue;}repo={repo:snapshot.repo,commit:snapshot.defaultHead,merges:[]};repos.push(repo);}
          if(!contains(input,member.terminal.merge,repo.commit)){
            valid=false;const merge=member.terminal.merge;
            if(facts.commits.some(pair=>sameRepo(pair.repo,merge.repo)&&pair.ancestor===merge.sha&&pair.descendant===repo.commit&&pair.result==='notContained'))gaps.push({ancestor:merge,descendant:{repo:repo.repo,sha:repo.commit}});
          }
          repo.merges.push(member.terminal.merge.sha);
        }
        const outstanding=state.units.flatMap(unit=>unit.members.flatMap(member=>member.contract.requirements)).filter(requirement=>{const repo=facts.repos.find(repo=>sameRepo(repo.repo,requirement.commit.repo));return !repo||!contains(input,requirement.commit,repo.defaultHead);});
        for(const requirement of outstanding){
          const repo=facts.repos.find(repo=>sameRepo(repo.repo,requirement.commit.repo));
          if(repo&&facts.commits.some(pair=>sameRepo(pair.repo,requirement.commit.repo)&&pair.ancestor===requirement.commit.sha&&pair.descendant===repo.defaultHead&&pair.result==='notContained'))gaps.push({ancestor:requirement.commit,descendant:{repo:repo.repo,sha:repo.defaultHead}});
        }
        if(gaps.length)verificationGap(state,'closure',{kind:'agenda'},gaps,input);
        if(valid&&outstanding.length===0){
          const stamp:GateStamp={kind:'closure',parent:state.parent,bodyHash:parent.bodyHash,children:parent.children.map(ref=>({issue:ref,terminal:memberOf(state,ref)?.terminal??{kind:'pending'}})),units:state.units.flatMap(unit=>unit.postMerge?[{id:unit.id,jobId:unit.postMerge.id}]:[]),repos,outstanding,rulings:state.rulings};
          if(!state.closure||state.closure.status.kind==='cancelled'||gateHolderLost(state,state.closure,input)||canonical(state.closure.stamp)!==canonical(stamp))state.closure=newGate(state,'closure',{kind:'agenda'},stamp,input);
          if(state.closure.status.kind==='answered'&&state.closure.status.ok&&parent.state==='open')addEffect(state,{kind:'agenda'},{kind:'setIssueState',issue:state.parent,open:false,afterEvent:parent.lastReopen,bodyHash:parent.bodyHash});
        }
      }
      if(parent.state==='closed'&&!(state.closure?.status.kind==='answered'&&state.closure.status.ok))addEffect(state,{kind:'agenda'},{kind:'setIssueState',issue:state.parent,open:true,afterEvent:parent.lastClose,bodyHash:parent.bodyHash});
    }
  }
  const finished=state.units.every(unit=>unitEnded(state,unit,input))&&state.cases.every(item=>item.state.kind==='resolved'||item.state.kind==='cancelled')&&state.effects.every(effect=>effect.state.kind==='confirmed'||effect.state.kind==='cancelled')&&state.designWorks.every(work=>work.result!==null)&&state.amendments.every(item=>item.state.kind==='effective')&&state.drafts.every(draft=>applyingDone(state,{kind:'draft',draftId:draft.id}))&&(!state.parent||state.closure?.status.kind==='answered'&&state.closure.status.ok&&issueOf(input,state.parent)?.state==='closed');
  if(finished&&!state.report)state.report={id:nextId(state,'work'),contentVersion:1,state:{kind:'requested'}};
}
function classifyStall(state:Agenda,input:Inputs):void {
  if(state.report||tickets(state,input).some(ticket=>ticket.runDisposition==='mustRun'))return;
  if(state.effects.some(effect=>effect.state.kind==='ready'||effect.state.kind==='executing'))return;
  if(state.cases.some(item=>item.state.kind==='awaitingExternal')||state.effects.some(effect=>(effect.state.kind==='failed'||effect.state.kind==='uncertain')&&effect.state.wait!==null))return;
  const current=state.units.find(unit=>!unitEnded(state,unit,input));
  const pending=current?.members.find(member=>!memberEnded(state,member,input));const pr=pending?boundPr(pending,input):undefined;
  if(pr?.state.kind==='open'&&(pr.mergeable==='unknown'||pr.checks.kind==='pending'||pr.checks.kind==='unknown'))return;
  const obligations:DomainRef[]=[
    ...state.units.filter(unit=>!unitEnded(state,unit,input)).map(unit=>({kind:'unit' as const,id:unit.id})),
    ...state.amendments.filter(item=>item.state.kind==='pending').map(item=>({kind:'amendment' as const,id:item.id})),
    ...state.drafts.filter(item=>!applyingDone(state,{kind:'draft',draftId:item.id})).map(item=>({kind:'draft' as const,id:item.id})),
    ...state.effects.filter(item=>item.state.kind!=='confirmed'&&item.state.kind!=='cancelled').map(item=>({kind:'effect' as const,id:item.id})),
  ];
  const first=obligations[0]??{kind:'unit' as const,id:state.units.at(-1)!.id};
  const subject:CaseSubject={kind:'stall',obligations:[first,...obligations.slice(1)],reason:'Incomplete obligations have no runnable ticket/effect or explicit source wait'};
  const prior=state.cases.find(item=>canonical(item.subject)===canonical(subject));
  if(prior?.state.kind==='resolved'){prior.state={kind:'open'};prior.contentVersion++;}
  else newCase(state,{kind:'agenda'},subject,subject.reason,input);
}
function exactClosing(member:Member,pr:PrSnapshot,input:Inputs):boolean {
  if(pr.closes.length===1)return sameRef(pr.closes[0]!,member.ref);
  const repo=source(input)?.repos.find(repo=>sameRepo(repo.repo,member.target.repo));
  if(pr.closes.length!==0||repo?.defaultBranch===member.target.base||member.binding.kind!=='registered')return false;
  return exactClosingBody(pr.body,member.ref,pr.target.repo);
}

type Placement={member:Member;position:Exclude<Insertion['position'],{kind:'outsideAgenda'}>};
function positionValid(state:Agenda,position:Insertion['position'],input:Inputs):boolean {
  if(position.kind==='outsideAgenda')return true;
  const index=state.units.findIndex(unit=>unit.id===position.unitId);if(index<0)return false;
  if(position.kind==='correctionOf')return true;
  const current=state.units.findIndex(unit=>!unitEnded(state,unit,input));
  if(current<0)return position.kind==='after'&&index===state.units.length-1;
  return index>=current&&(position.kind!=='before'||!unitEnded(state,state.units[index]!,input));
}
function validateInsertion(state:Agenda,insertion:Insertion,input:Inputs):Result<null,DomainError> {
  const position=insertion.position;
  if(position.kind!=='outsideAgenda'){
    const anchor=state.units.find(unit=>unit.id===position.unitId);
    if(!anchor||!positionValid(state,position,input))return {ok:false,error:error('invalidDecision','Missing or serially invalid insertion anchor')};
  }else if(insertion.kind==='existing')return {ok:false,error:error('invalidDecision','Existing issue cannot be outside the agenda')};
  if(insertion.kind==='draft')return sameRepo(insertion.draft.repo,insertion.draft.target.repo)?{ok:true,value:null}:{ok:false,error:error('invalidDecision','Draft repository and target differ')};
  if(memberOf(state,insertion.entry.issue)||state.amendments.some(item=>item.state.kind==='pending'&&item.state.insertions.some(ref=>ref.kind==='existing'&&sameRef(ref.entry.issue,insertion.entry.issue))))return {ok:false,error:error('invalidDecision','Duplicate member or placement intent')};
  if(state.effects.some(effect=>{
    const action=effect.action;if(action.kind!=='attachChild'||action.owner.kind!=='insertion'||!sameRef(action.child,insertion.entry.issue))return false;
    const owner=action.owner;return state.cases.some(item=>item.id===owner.caseId&&item.state.kind==='applying');
  }))return {ok:false,error:error('invalidDecision','Existing issue is already owned by another accepted insertion intent')};
  const facts=source(input);if(!facts)return {ok:false,error:error('sourceUnavailable','Insertion requires current source')};
  const initialized=initializeMember(insertion.entry,facts);
  return initialized.ok?{ok:true,value:null}:initialized;
}
function placeMembers(state:Agenda,placements:readonly Placement[],input:Inputs):Result<null,DomainError> {
  const seen=new Set<string>();
  const current=state.units.find(unit=>!unitEnded(state,unit,input));
  const groups:{position:Placement['position'];members:Member[];units:Unit[]}[]=[];
  for(const placement of placements){
    const key=refKey(placement.member.ref);const anchor=state.units.find(unit=>unit.id===placement.position.unitId);
    if(!anchor||memberOf(state,placement.member.ref)||seen.has(key)||!positionValid(state,placement.position,input))return {ok:false,error:error('premiseChanged','Atomic placement identities or serial anchor changed')};
    seen.add(key);
  }
  for(const placement of placements){
    const anchor=state.units.find(unit=>unit.id===placement.position.unitId)!;
    let group=groups.find(group=>canonical(group.position)===canonical(placement.position));
    if(!group){group={position:placement.position,members:[],units:[]};groups.push(group);}
    group.members.push(placement.member);
    if(placement.position.kind!=='correctionOf'&&!(placement.position.kind==='before'&&anchor===current))group.units.push({id:nextId(state,'unit'),members:[placement.member],postMerge:null,rulings:[]});
  }
  for(const group of groups){
    const anchor=state.units.find(unit=>unit.id===group.position.unitId)!;const index=state.units.indexOf(anchor);
    if(group.position.kind==='correctionOf'||group.position.kind==='before'&&anchor===current){
      const pending=anchor.members.findIndex(member=>!memberEnded(state,member,input));
      const at=group.position.kind==='correctionOf'?anchor.members.length:Math.max(0,pending);
      anchor.members.splice(at,0,...group.members);
      if(anchor.postMerge)anchor.postMerge.status={kind:'cancelled',reason:'superseded'};
    }else state.units.splice(index+(group.position.kind==='after'?1:0),0,...group.units);
  }
  for(const group of groups)if(group.position.kind==='before'){
    for(const prerequisite of group.members){
      const unit=unitOf(state,prerequisite.ref)!;const index=state.units.indexOf(unit);const memberIndex=unit.members.indexOf(prerequisite);
      const downstream=[...unit.members.slice(memberIndex+1),...state.units.slice(index+1).flatMap(unit=>unit.members)];
      for(const member of downstream){
        if(member.work)addHold(member.work,{kind:'dependency',member:prerequisite.ref});
        invalidateGates(member,'workOpened');
        for(const effect of state.effects)if(effect.action.kind==='merge'&&sameRef(effect.action.member,member.ref)&&effect.state.kind==='ready')cancelEffect(state,effect,'preconditionChanged',input);
      }
    }
  }
  if(placements.length&&state.closure)state.closure.status={kind:'cancelled',reason:'superseded'};
  return {ok:true,value:null};
}
function placeMember(state:Agenda,member:Member,position:Insertion['position'],input:Inputs):Result<null,DomainError> {
  return position.kind==='outsideAgenda'?{ok:false,error:error('invalidDecision','Existing member cannot be outside the agenda')}:placeMembers(state,[{member,position}],input);
}
function draftFor(state:Agenda,spec:Insertion & {kind:'draft'},purpose:Agenda['drafts'][number]['purpose'],caseId:string,input:Inputs,reservedId?:string):Result<Agenda['drafts'][number],DomainError> {
  const facts=source(input);
  const actor=facts?.viewer;
  if(!actor)return {ok:false,error:error('sourceUnavailable','Issue creation requires the actual authenticated source account')};
  const id=reservedId??nextId(state,'draft');
  const current=state.units.find(unit=>!unitEnded(state,unit,input));
  const scope:Context=spec.position.kind==='correctionOf'||spec.position.kind==='before'&&current?.id===spec.position.unitId?{kind:'unit',unitId:spec.position.unitId}:{kind:'agenda'};
  const effectId=nextId(state,'effect');
  const draft:Agenda['drafts'][number]={id,caseId,purpose,spec:spec.draft,position:spec.position,scope,parent:state.parent,requirement:null,creationEffectId:effectId,attachmentEffectIds:[],state:{kind:'proposed'}};
  state.drafts.push(draft);
  state.effects.push({id:effectId,scope,action:{kind:'createIssue',draftId:id,spec:spec.draft,actor},attempt:0,authorization:'initial',state:{kind:'ready',provenance:{kind:'initial'}}});
  return {ok:true,value:draft};
}
function insertionFor(state:Agenda,insertion:Insertion,caseId:string,input:Inputs):Result<readonly ApplyingRef[],DomainError> {
  const valid=validateInsertion(state,insertion,input);if(!valid.ok)return valid;
  if(insertion.kind==='draft'){
    if(!sameRepo(insertion.draft.repo,insertion.draft.target.repo))return {ok:false,error:error('invalidDecision','Draft repository and target differ')};
    const position=insertion.position;
    if(position.kind!=='outsideAgenda'&&!state.units.some(unit=>unit.id===position.unitId))return {ok:false,error:error('invalidDecision','Draft anchor missing')};
    const draft=draftFor(state,insertion,insertion.position.kind==='correctionOf'?'correction':insertion.position.kind==='outsideAgenda'?'outsideAgenda':insertion.draft.designOnly?'designOnly':'split',caseId,input);
    return draft.ok?{ok:true,value:[{kind:'draft',draftId:draft.value.id}]}:draft;
  }
  const facts=source(input);if(!facts)return {ok:false,error:error('sourceUnavailable','Existing issue insertion requires current source')};
  const member=initializeMember(insertion.entry,facts);if(!member.ok)return member;
  if(state.parent&&!issueOf(input,state.parent)?.children.some(child=>sameRef(child,insertion.entry.issue))){
    const context=state.cases.find(item=>item.id===caseId)?.context??{kind:'agenda'};
    const effect=addEffect(state,context,{kind:'attachChild',owner:{kind:'insertion',caseId,insertion},parent:state.parent,child:insertion.entry.issue});
    return {ok:true,value:[{kind:'effect',effectId:effect.id}]};
  }
  const placed=placeMember(state,member.value,insertion.position,input);if(!placed.ok)return placed;
  return {ok:true,value:[]};
}
function receiptSlots(state:Agenda):Receipt[] {
  return [...state.units.flatMap(unit=>[unit.postMerge?.receipt,...unit.members.flatMap(member=>[member.ownerReceipt,member.review?.receipt,member.accept?.receipt])]),state.closure?.receipt,...state.cases.map(item=>item.receipt),...state.designWorks.map(work=>work.receipt),...state.requests.map(request=>request.receipt),state.report?.state.kind==='reported'?state.report.state.receipt:null].filter((receipt):receipt is Receipt=>receipt!==null&&receipt!==undefined);
}
function requestForTicket(state:Agenda,ticket:string):SeatRequest|undefined {
  const owner=state.units.flatMap(unit=>unit.members).find(member=>`work:${member.work?.id}`===ticket||member.ownerReceipt?.ticket===ticket);
  if(owner&&!owner.designOnly)return state.requests.find(request=>request.id===owner.ownerRequestId);
  const gate=gateOf(state,ticket.startsWith('gate:')?ticket.slice(5):'');if(gate)return state.requests.find(request=>request.id===gate.requestId);
  if(ticket.startsWith('gate:'))return state.requests.find(request=>request.obligation.kind==='gate'&&request.obligation.jobId===ticket.slice(5));
  return undefined;
}
function replyAuthorized(state:Agenda,input:Inputs,event:Event & {kind:'reply'}):boolean {
  if(state.lifecycle==='completed'&&state.report?.state.kind==='reported'&&event.ticket===state.report.state.receipt.ticket)return mainCaller(input,event.caller);
  if(state.run.kind!=='attached'||state.run.id!==input.host.runId)return false;
  const request=requestForTicket(state,event.ticket);
  if(request)return callerOwns(request,input,event.caller);
  if(state.units.some(unit=>unit.members.some(member=>!member.designOnly&&(`work:${member.work?.id}`===event.ticket||member.ownerReceipt?.ticket===event.ticket))))return false;
  return mainCaller(input,event.caller);
}
/** Authenticate before source I/O; null means a new, not-yet-accepted reply. */
export function replyReplay(state:Agenda,input:Inputs,event:Extract<Event,{kind:'reply'}>):Result<ReplyResult|null,DomainError> {
  if(!replyAuthorized(state,input,event))return {ok:false,error:error('unauthorized','Caller is not the real current holder/session/run')};
  const receipt=receiptSlots(state).find(receipt=>receipt.ticket===event.ticket&&receipt.revision===event.revision);
  if(receipt&&event.payload.kind!=='claim')return digest(event.payload)===receipt.digest?{ok:true,value:receipt.result}:{ok:false,error:error('replyConflict','Different terminal payload for an accepted receipt key')};
  if(event.payload.kind==='claim'){
    const claimed=state.cases.find(item=>item.openedBy?.ticket===event.ticket&&item.openedBy.revision===event.revision&&item.openedBy.digest===digest(event.payload));
    if(claimed?.openedBy)return {ok:true,value:claimed.openedBy.result};
  }
  return {ok:true,value:null};
}
function finishOwner(member:Member,kind:'noCode'|'replacePr'|'sourceRestored',decision:CaseDecision):void {
  if(!member.work)return;
  const workId=member.work.id;
  if(kind==='noCode'&&decision.kind==='confirmNoCode')member.ownerTerminal={kind,workId,reason:decision.reason};
  if(kind==='replacePr'&&decision.kind==='replacePr')member.ownerTerminal={kind,workId,pr:decision.pr,reason:decision.reason};
  if(kind==='sourceRestored'&&decision.kind==='sourceRestored')member.ownerTerminal={kind,workId,acceptedHead:decision.acceptedHead};
  member.work=null;if(kind!=='sourceRestored')invalidateGates(member,'superseded');
}
function acceptReply(state:Agenda,input:Inputs,event:Event & {kind:'reply'}):Result<ReplyResult,DomainError> {
  const beforeIds=new Set(domainObjects(state).map(item=>item.id));
  const ticket=tickets(state,input).find(ticket=>ticket.id===event.ticket);
  if(!ticket)return {ok:false,error:error(event.ticket.includes(state.id+'/')?'superseded':'unknownTicket','Ticket is not a current reply object')};
  if(ticket.revision!==event.revision)return {ok:false,error:{...error('staleRevision','Reply revision is stale'),current:ticket}};
  if(!ticket.allowedReplies.includes(event.payload.kind))return {ok:false,error:{...error('wrongTicketKind','Payload is not allowed for this ticket'),current:ticket}};
  const payload=event.payload;
  const result:ReplyResult={ticket:event.ticket,acceptedVersion:state.version+1,outcome:payload.kind==='claim'?'claimOpened':payload.kind==='report'?'reported':'accepted',created:[]};
  const receipt:Receipt={ticket:event.ticket,revision:event.revision,kind:'terminal',digest:digest(payload),result};
  const member=state.units.flatMap(unit=>unit.members).find(member=>member.work&&`work:${member.work.id}`===event.ticket);
  const gate=event.ticket.startsWith('gate:')?gateOf(state,event.ticket.slice(5)):undefined;
  switch(payload.kind){
    case 'spawned':{
      if(!mainCaller(input,event.caller))return {ok:false,error:error('unauthorized','Only Main can acknowledge native spawning')};
      const request=state.requests.find(request=>`spawn:${request.id}`===event.ticket);if(!request)return {ok:false,error:error('unknownTicket','Request does not exist')};
      const candidate=candidateFor(request,input);if(!candidate||candidate.agentId!==payload.agentId||!candidate.sessionId||candidate.parentId!==input.host.main.agentId)return {ok:false,error:error('premiseChanged','Agent is not the exact unique native request candidate')};
      request.binding={kind:'bound',agentId:candidate.agentId,sessionId:candidate.sessionId,parentId:candidate.parentId};request.receipt=receipt;break;
    }
    case 'claim':{
      const pending=state.cases.find(item=>item.openedBy?.ticket===event.ticket&&item.state.kind!=='resolved'&&item.state.kind!=='cancelled');
      if(pending)return {ok:false,error:error('pendingClaim','This work/job already has an unresolved claim')};
      const item=newCase(state,ticket.context,{kind:'claim',ticket:event.ticket,revision:event.revision,claim:payload.claim},canonical(payload.claim),input);
      item.openedBy={ticket:event.ticket,revision:event.revision,kind:'claim',digest:digest(payload),result};
      if(member?.work)addHold(member.work,{kind:'case',caseId:item.id});
      const design=state.designWorks.find(work=>`work:${work.id}`===event.ticket);
      if(design&&!design.holds.some(hold=>hold.kind==='case'&&hold.caseId===item.id))design.holds.push({kind:'case',caseId:item.id});
      if(gate)gate.status={kind:'cancelled',reason:'claimOpened'};
      break;
    }
    case 'submit':{
      if(!member?.work)return {ok:false,error:error('wrongTicketKind','Submission requires the current member work')};
      if(availability(state,member.work,input).kind==='held')return {ok:false,error:error('pendingClaim','Held work cannot submit past unresolved dependencies')};
      const facts=source(input);if(!facts)return {ok:false,error:error('sourceUnavailable','Fresh submission source unavailable')};
      const issue=issueOf(input,member.ref);
      if(issue?.state!=='open'||issue.bodyHash!==member.contract.bodyHash||baseOf(input,member)?.state.kind!=='present')return {ok:false,error:error('premiseChanged','The open member contract or target base changed before submission')};
      const headRepo=member.binding.kind==='registered'?member.binding.headRepo:member.target.repo;
      const branch=facts.branches.find(branch=>sameRepo(branch.repo,headRepo)&&branch.name===payload.branch);
      if(branch?.state.kind!=='present'||branch.state.head!==payload.head)return {ok:false,error:error('premiseChanged','Submitted SHA is not the actual remote branch head')};
      const pr=boundPr(member,input);
      if(member.binding.kind==='registered'&&(!pr||facts.maintenance.find(item=>sameRef(item.pr,member.binding.kind==='registered'?member.binding.pr:member.ref))?.result.kind!=='maintainable'))return {ok:false,error:error('premiseChanged','The registered PR is no longer source-maintainable')};
      if(pr&&(pr.state.kind!=='open'||pr.headBranch!==payload.branch||pr.head!==payload.head||canonical(pr.target)!==canonical(member.target)))return {ok:false,error:error('premiseChanged','Registered PR does not match submission branch/head/target')};
      if(member.work.required.some(commit=>!sameRepo(commit.repo,member.target.repo)||!headContains(input,commit,{repo:headRepo,sha:payload.head})))return {ok:false,error:error('missingDesignCommit','Submitted branch lacks an exact required design commit')};
      if(!exactClosingBody(payload.body,member.ref,member.target.repo))return {ok:false,error:error('premiseChanged','Publication must close exactly this issue')};
      const work=member.work;const submission={workId:work.id,payload};
      const designSignature=member.contract.requirements.length?`\n\nDesign contributions:\n${member.contract.requirements.map(requirement=>`- https://github.com/${repoKey(requirement.commit.repo)}/commit/${requirement.commit.sha} (Main)`).join('\n')}`:'';
      const effect=addEffect(state,contextOf(member),{kind:'publishPr',member:member.ref,submission,headRepo,target:member.target,pr:pr?.ref??null,expectedBodyHash:pr?.bodyHash??null,body:payload.body+designSignature});
      const previous=member.binding.kind==='registered'?member.binding:{kind:'none' as const};
      member.baseline={kind:'submitted',submission};member.binding={kind:'publishing',effectId:effect.id,previous};
      member.ownerTerminal={kind:'submitted',workId:work.id,submission};member.ownerReceipt=receipt;
      for(const reason of work.reasons)if(reason.kind==='checks')for(const failure of reason.failures)if(!member.fixedChecks.some(old=>canonical(old)===canonical(failure)))member.fixedChecks.push(failure);
      member.work=null;invalidateChangedGates(member,input);break;
    }
    case 'verdict':{
      if(!gate||gate.status.kind!=='requested')return {ok:false,error:error('superseded','Gate was cancelled or answered')};
      if(!gateCurrent(state,gate,input))return {ok:false,error:error('premiseChanged','Gate source input changed')};
      gate.status={kind:'answered',ok:payload.ok,note:payload.note};gate.receipt=receipt;
      if(!payload.ok){const subject:CaseSubject=gate.kind==='postMerge'?{kind:'postMerge',cause:{kind:'verdict',jobId:gate.id,note:payload.note}}:gate.kind==='closure'?{kind:'closure',cause:{kind:'verdict',jobId:gate.id,note:payload.note}}:{kind:'findings',jobId:gate.id,gateKind:gate.kind,stamp:gate.stamp,note:payload.note};newCase(state,gate.context,subject,payload.note,input);}
      break;
    }
    case 'decision':{
      const item=state.cases.find(item=>`case:${item.id}`===event.ticket);if(!item)return {ok:false,error:error('unknownTicket','Case missing')};
      const applied=applyDecision(state,item,payload.decision,input,event.acceptedAt,{
        newCase:(context,subject,evidence)=>newCase(state,context,subject,evidence,input),
        openWork:(member,basis)=>{openWork(state,member,{kind:item.subject.kind==='unexpectedSourceChange'||item.subject.kind==='effectFailure'?'sourceChange':'finding',caseId:item.id,basis},input);},
        validateInsertion:insertion=>validateInsertion(state,insertion,input),
        addEffect:(scope,action)=>addEffect(state,scope,action).id,
        insert:insertion=>insertionFor(state,insertion,item.id,input),
        newDraft:(draft,position,purpose,caseId,reservedId)=>draftFor(state,{kind:'draft',draft,position},purpose,caseId,input,reservedId),
        finishWork:finishOwner,
      });
      if(!applied.ok)return applied;
      if(item.subject.kind==='findings'&&item.state.kind==='resolved'){const job=gateOf(state,item.subject.jobId);if(job)job.status={kind:'cancelled',reason:'superseded'};}
      item.receipt=receipt;break;
    }
    case 'designCommit':{
      const work=state.designWorks.find(work=>`work:${work.id}`===event.ticket);if(!work||work.result!==null)return {ok:false,error:error('wrongTicketKind','Design result requires open Main design work')};
      if(availability(state,work,input).kind==='held')return {ok:false,error:error('pendingClaim','Held design work cannot complete past unresolved dependencies')};
      const facts=source(input);if(!facts)return {ok:false,error:error('sourceUnavailable','Design commit source unavailable')};
      const exists=facts.commits.some(commit=>sameRepo(commit.repo,payload.commit.repo)&&(commit.ancestor===payload.commit.sha||commit.descendant===payload.commit.sha)&&commit.result==='contains')||facts.branches.some(branch=>sameRepo(branch.repo,payload.commit.repo)&&branch.state.kind==='present'&&branch.state.head===payload.commit.sha)||facts.repos.some(repo=>sameRepo(repo.repo,payload.commit.repo)&&repo.defaultHead===payload.commit.sha);
      if(!exists)return {ok:false,error:error('missingDesignCommit','Design commit is not source-verified remotely')};
      const parentCase=state.cases.find(item=>item.id===work.parentCaseId);
      if(work.route.kind==='withPr'&&(parentCase?.context.kind!=='member'||!sameRef(work.route.member,parentCase.context.member)))return {ok:false,error:error('invalidDecision','withPr must bind the original current member')};
      if(work.route.kind==='future'){
        const carrierSpec=work.route.carrier;
        if('number'in carrierSpec){
          const originalRef=parentCase?.context.kind==='member'?parentCase.context.member:work.affected[0]!;
          const originalUnit=unitOf(state,originalRef);const targetUnit=unitOf(state,carrierSpec);
          const originalIndex=originalUnit?state.units.indexOf(originalUnit):-1;const targetIndex=targetUnit?state.units.indexOf(targetUnit):-1;
          const target=memberOf(state,carrierSpec);
          const later=targetIndex>originalIndex||targetIndex===originalIndex&&originalUnit!==undefined&&originalUnit.members.findIndex(member=>sameRef(member.ref,carrierSpec))>originalUnit.members.findIndex(member=>sameRef(member.ref,originalRef));
          if(!target||!later||!sameRepo(target.target.repo,payload.commit.repo))return {ok:false,error:error('invalidDecision','future must retain the exact same-repository later carrier selected by the accepted decision')};
        }else if(!carrierSpec.designOnly||!sameRepo(carrierSpec.repo,payload.commit.repo)||!sameRepo(carrierSpec.target.repo,payload.commit.repo))return {ok:false,error:error('invalidDecision','future draft must be same-repository designOnly')};
      }
      let carrier:DesignRequirement['carrier'];
      if(work.route.kind==='defaultFirst'){
        const repo=facts.repos.find(repo=>sameRepo(repo.repo,work.route.kind==='defaultFirst'?work.route.repo:payload.commit.repo));
        if(!repo||!sameRepo(repo.repo,payload.commit.repo)||!contains(input,payload.commit,repo.defaultHead))return {ok:false,error:error('missingDesignCommit','defaultFirst commit is not in the corresponding default branch')};
        if(parentCase?.state.kind==='applying'&&parentCase.state.decision.kind==='correctDesign'){work.result=payload.commit;work.receipt=receipt;break;}
        carrier={kind:'member',member:work.affected[0]!};
      }else if(work.route.kind==='withPr')carrier={kind:'member',member:work.route.member};
      else if('number'in work.route.carrier)carrier={kind:'member',member:work.route.carrier};
      else{
        const parent=state.cases.find(item=>item.id===work.parentCaseId)!;const created=draftFor(state,{kind:'draft',draft:work.route.carrier,position:{kind:'after',unitId:state.units.at(-1)!.id}},'designOnly',parent.id,input);
        if(!created.ok)return created;const draft=created.value;
        carrier={kind:'draft',draftId:draft.id};draft.requirement={caseId:work.parentCaseId,commit:payload.commit,carrier,route:work.route};
      }
      if(carrier.kind==='member'){const member=memberOf(state,carrier.member);if(!member||!sameRepo(member.target.repo,payload.commit.repo))return {ok:false,error:error('invalidDecision','Design carrier must exist in the commit repository')};const requirement:DesignRequirement={caseId:work.parentCaseId,commit:payload.commit,carrier,route:work.route};member.contract.requirements.push(requirement);if(member.work&&!member.work.required.some(commit=>canonical(commit)===canonical(payload.commit))){member.work.required.push(payload.commit);member.work.contentVersion++;}}
      work.result=payload.commit;work.receipt=receipt;break;
    }
    case 'report':{
      if(state.report?.state.kind!=='requested'||`work:${state.report.id}`!==event.ticket)return {ok:false,error:error('wrongTicketKind','Report work is not current')};
      state.report.state={kind:'reported',summary:payload.summary,externalMerges:state.units.flatMap(unit=>unit.members.flatMap(member=>member.ownerTerminal?.kind==='externallyMerged'?[member.ownerTerminal]:[])),receipt};
      state.lifecycle='completed';break;
    }
  }
  result.created=domainObjects(state).filter(item=>!beforeIds.has(item.id));return {ok:true,value:result};
}
function gateCurrent(state:Agenda,gate:GateJob,input:Inputs,applyingEffectId:string|null=null):boolean {
  if(input.facts.kind!=='available')return false;
  if(gate.context.kind==='member'){
    const member=memberOf(state,gate.context.member);const pr=member?boundPr(member,input):undefined;
    const unit=member?unitOf(state,member.ref):undefined;const index=unit?state.units.indexOf(unit):-1;
    const pendingMaterialization=state.effects.some(effect=>effect.action.kind!=='wake'&&effect.action.kind!=='merge'&&canonical(effect.scope)===canonical(gate.context)&&effect.state.kind!=='confirmed'&&effect.state.kind!=='cancelled');
    const unresolvedCase=state.cases.some(item=>canonical(item.context)===canonical(gate.context)&&item.state.kind!=='resolved'&&item.state.kind!=='cancelled'&&!(applyingEffectId&&item.subject.kind==='effectFailure'&&item.subject.effectId===applyingEffectId&&item.state.kind==='applying'&&item.state.required.some(ref=>ref.kind==='effect'&&ref.effectId===applyingEffectId)));
    return !!member&&member.terminal.kind==='pending'&&!!pr&&pr.state.kind==='open'&&member.work===null&&!unresolvedCase&&!pendingMaterialization&&state.units.slice(0,index).every(unit=>unitEnded(state,unit,input))&&acceptedHead(member)===pr.head&&canonical(gate.stamp)===canonical(memberGateStamp(member,pr,gate.kind==='review'?'review':'accept'))&&issueOf(input,member.ref)?.bodyHash===member.contract.bodyHash;
  }
  if(gate.stamp.kind==='postMerge'){
    const unitId=gate.stamp.unitId;const unit=state.units.find(unit=>unit.id===unitId);if(!unit)return false;
    return unit.members.every(member=>memberEnded(state,member,input))&&canonical(gate.stamp.members)===canonical(unit.members.map(member=>({member:memberStamp(member),terminal:member.terminal})))&&gate.stamp.repos.every(repo=>repo.merges.every(sha=>contains(input,{repo:repo.repo,sha},repo.commit)))&&unit.members.every(member=>member.contract.requirements.every(requirement=>{const repo=gate.stamp.kind==='postMerge'?gate.stamp.repos.find(repo=>sameRepo(repo.repo,requirement.commit.repo)):undefined;return repo!==undefined&&contains(input,requirement.commit,repo.commit);}));
  }
  if(gate.stamp.kind==='closure'){
    const parent=issueOf(input,gate.stamp.parent);return !!parent&&parent.bodyHash===gate.stamp.bodyHash&&canonical(parent.children.map(refKey).sort())===canonical(gate.stamp.children.map(item=>refKey(item.issue)).sort())&&state.units.every(unit=>unitEnded(state,unit,input))&&gate.stamp.repos.every(repo=>source(input)?.repos.some(current=>sameRepo(current.repo,repo.repo)&&current.defaultHead===repo.commit)&&repo.merges.every(sha=>contains(input,{repo:repo.repo,sha},repo.commit)))&&state.units.every(unit=>unit.members.every(member=>member.contract.requirements.every(requirement=>{const repo=source(input)?.repos.find(repo=>sameRepo(repo.repo,requirement.commit.repo));return repo!==undefined&&contains(input,requirement.commit,repo.defaultHead);})));
  }
  return false;
}

export function satisfiedResult(state:Agenda,effect:Effect,input:Inputs):EffectResult|null {
  const action=effect.action;const facts=source(input);if(!facts)return null;
  switch(action.kind){
    case 'wake':return null;
    case 'createIssue':{
      if(effect.state.kind!=='uncertain'||effect.state.received?.kind!=='issue')return null;
      const status=effect.state;const received=status.received;if(!received||received.kind!=='issue')return null;
      const candidate=facts.createdIssues.find(candidate=>sameRef(candidate.issue,received.issue));
      return candidate&&sameRepo(candidate.issue.repo,action.spec.repo)&&candidate.title===action.spec.title&&candidate.body===action.spec.body&&candidate.actor===action.actor&&candidate.createdAt>=Math.floor(status.startedAt/1000)*1000?{kind:'created',issue:candidate.issue}:null;
    }
    case 'publishPr':{
      const candidates=facts.prs.filter(pr=>pr.state.kind==='open'&&sameRepo(pr.headRepo,action.headRepo)&&pr.headBranch===action.submission.payload.branch&&pr.head===action.submission.payload.head&&canonical(pr.target)===canonical(action.target)&&pr.title===action.submission.payload.title&&pr.body===action.body&&(!action.pr||sameRef(pr.ref,action.pr)));
      return candidates.length===1&&publicationAssociation(state,effect,candidates[0]!,input)?{kind:'published',pr:candidates[0]!.ref}:null;
    }
    case 'attachChild':return issueOf(input,action.parent)?.children.some(child=>sameRef(child,action.child))?{kind:'attached',parent:action.parent,child:action.child}:null;
    case 'replaceBody':return issueOf(input,action.edit.issue)?.bodyHash===bodyHash(action.edit.body)?{kind:'bodyReplaced',issue:action.edit.issue,hash:bodyHash(action.edit.body)}:null;
    case 'setIssueState':{
      const issue=issueOf(input,action.issue);const event=action.open?issue?.lastReopen:issue?.lastClose;
      return issue?.state===(action.open?'open':'closed')&&issue.bodyHash===action.bodyHash&&issueStateBaselineMatches(action,issue)?{kind:'issueState',issue:action.issue,open:action.open,event:event??null}:null;
    }
    case 'rerunChecks':{const run=facts.checkAttempts.find(run=>sameRepo(run.repo,action.repo)&&run.workflowRunId===action.workflowRunId&&run.attempt>action.previousAttempt&&run.head===action.head);return run?{kind:'rerun',repo:action.repo,workflowRunId:action.workflowRunId,attempt:run.attempt}:null;}
    case 'merge':{const pr=prOf(input,action.pr);return pr?.state.kind==='merged'&&pr.head===action.head&&canonical(pr.target)===canonical(action.target)?{kind:'merged',pr:pr.ref,merge:{repo:pr.target.repo,sha:pr.state.sha},at:pr.state.at}:null;}
  }
}
function resultMatches(state:Agenda,effect:Effect,result:EffectResult,input:Inputs,fromCall:boolean):boolean {
  if(effect.action.kind==='wake')return fromCall&&result.kind==='delivered'&&result.agentId===effect.action.holder&&result.messageId===`${effect.id}:${effect.attempt}`;
  if(effect.action.kind==='createIssue'){
    if(!fromCall)return canonical(satisfiedResult(state,effect,input))===canonical(result);
    if(result.kind!=='created')return false;
    const action=effect.action;const issue=issueOf(input,result.issue);const candidate=source(input)?.createdIssues.find(candidate=>sameRef(candidate.issue,result.issue));
    return effect.state.kind==='executing'&&!!issue&&!!candidate&&sameRepo(issue.ref.repo,action.spec.repo)&&issue.body===action.spec.body&&candidate.title===action.spec.title&&candidate.body===action.spec.body&&candidate.actor===action.actor&&candidate.createdAt>=Math.floor(effect.state.startedAt/1000)*1000;
  }
  const satisfied=satisfiedResult(state,effect,input);
  return satisfied!==null&&canonical(satisfied)===canonical(result);
}
function confirmEffect(state:Agenda,effect:Effect,result:EffectResult,input:Inputs):void {
  effect.state={kind:'confirmed',result};
  for(const item of state.cases)if((item.subject.kind==='effectFailure'&&item.subject.effectId===effect.id||item.subject.kind==='hostPrecondition'&&item.subject.effectId===effect.id)&&(item.state.kind==='open'||item.state.kind==='awaitingExternal'))item.state={kind:'resolved',result:{kind:'effectConfirmed',effectId:effect.id}};
  const action=effect.action;
  if(action.kind==='publishPr'&&result.kind==='published'){
    const member=memberOf(state,action.member);if(member)member.binding={kind:'registered',pr:result.pr,headRepo:action.headRepo,branch:action.submission.payload.branch,origin:'published'};
  }
}
export function effectPrecondition(state:Agenda,effect:Effect,input:Inputs):Result<null,DomainError> {
  const action=effect.action;const facts=source(input);
  if(action.kind==='wake'){
    const request=state.requests.find(request=>request.id===action.requestId);const holder=request?candidateFor(request,input):undefined;
    if(request?.runId!==action.runId||holder?.agentId!==action.holder||holder.status==='aborted')return {ok:false,error:error('premiseChanged','Wake holder/run/request changed')};
    const current=tickets(state,input).find(ticket=>ticket.id===action.ticket&&ticket.revision===action.revision&&ticket.runDisposition==='mustRun'&&ticket.holder.kind==='seat'&&ticket.holder.agentId===action.holder&&ticket.holder.requestId===action.requestId);
    if(!current)return {ok:false,error:error('premiseChanged','Wake work was consumed, held or superseded')};
    return {ok:true,value:null};
  }
  if(!facts)return {ok:false,error:error('sourceUnavailable','Effect requires a fresh complete source read')};
  switch(action.kind){
    case 'merge':{
      const member=memberOf(state,action.member);const pr=prOf(input,action.pr);const unit=member?unitOf(state,member.ref):undefined;
      const before=unit?state.units.slice(0,state.units.indexOf(unit)):[];
      if(!member||issueOf(input,member.ref)?.state!=='open'||facts.maintenance.find(item=>sameRef(item.pr,action.pr))?.result.kind!=='maintainable')return {ok:false,error:error('premiseChanged','Merge requires the current open issue and authorized PR maintenance')};
      if(!member||!pr||pr.state.kind!=='open'||pr.head!==action.head||canonical(pr.target)!==canonical(action.target)||pr.mergeable!=='yes'||pr.checks.kind!=='passing'||!exactClosing(member,pr,input)||!member.review||!member.accept||member.review.status.kind!=='answered'||!member.review.status.ok||member.accept.status.kind!=='answered'||!member.accept.status.ok||!gateCurrent(state,member.review,input,effect.id)||!gateCurrent(state,member.accept,input,effect.id)||canonical(member.review.stamp)!==canonical(action.review)||canonical(member.accept.stamp)!==canonical(action.accept)||!before.every(unit=>unitEnded(state,unit,input))||before.some(unit=>!action.predecessors.some(predecessor=>predecessor.unitId===unit.id&&predecessor.jobId===unit.postMerge?.id))||member.contract.requirements.some(requirement=>requirement.carrier.kind==='member'&&sameRef(requirement.carrier.member,member.ref)&&!headContains(input,requirement.commit,{repo:pr.headRepo,sha:pr.head})))return {ok:false,error:error('premiseChanged','Exact merge preconditions are no longer satisfied')};
      break;
    }
    case 'publishPr':{
      const branch=facts.branches.find(branch=>sameRepo(branch.repo,action.headRepo)&&branch.name===action.submission.payload.branch);
      const member=memberOf(state,action.member);
      if(!member||issueOf(input,member.ref)?.state!=='open'||issueOf(input,member.ref)?.bodyHash!==member.contract.bodyHash||baseOf(input,member)?.state.kind!=='present')return {ok:false,error:error('premiseChanged','Publication contract, issue state or target base changed')};
      if(!member||branch?.state.kind!=='present'||branch.state.head!==action.submission.payload.head)return {ok:false,error:error('premiseChanged','Accepted publication head changed')};
      if(action.pr){const pr=prOf(input,action.pr);if(!pr||!publicationAssociation(state,effect,pr,input)||pr.head!==action.submission.payload.head||pr.bodyHash!==action.expectedBodyHash&&pr.body!==action.body)return {ok:false,error:error('premiseChanged','Publication association, authorization, head or body changed')};}
      break;
    }
    case 'replaceBody':if(issueOf(input,action.edit.issue)?.bodyHash!==action.edit.expectedHash&&issueOf(input,action.edit.issue)?.bodyHash!==bodyHash(action.edit.body))return {ok:false,error:error('premiseChanged','Issue body conflict')};break;
    case 'setIssueState':{const issue=issueOf(input,action.issue);if(!issue||issue.bodyHash!==action.bodyHash||!issueStateBaselineMatches(action,issue))return {ok:false,error:error('premiseChanged','Lifecycle or body advanced beyond state decision')};break;}
    case 'attachChild':if(!issueOf(input,action.parent)||!issueOf(input,action.child))return {ok:false,error:error('sourceUnavailable','Attachment source missing')};break;
    case 'rerunChecks':{const run=facts.checkAttempts.find(run=>sameRepo(run.repo,action.repo)&&run.workflowRunId===action.workflowRunId);const pr=prOf(input,action.pr);if(!pr||pr.state.kind!=='open'||pr.head!==action.head||!run||run.head!==action.head||run.attempt!==action.previousAttempt)return {ok:false,error:error('premiseChanged','PR head or workflow attempt source changed')};break;}
    case 'createIssue':{
      if(!facts.repos.some(repo=>sameRepo(repo.repo,action.spec.repo)))return {ok:false,error:error('sourceUnavailable','Creation repository inaccessible')};
      if(facts.viewer&&facts.viewer.toLowerCase()!==action.actor.toLowerCase())return {ok:false,error:error('premiseChanged','Authenticated source account changed since creation intent')};
      break;
    }
  }
  return {ok:true,value:null};
}
function actionObsolete(state:Agenda,effect:Effect,input:Inputs):boolean {
  const action=effect.action;
  switch(action.kind){
    case 'wake':{
      if(action.runId!==input.host.runId||!input.host.seats.some(seat=>seat.agentId===action.holder&&seat.status!=='aborted'))return true;
      return !tickets(state,input).some(ticket=>ticket.id===action.ticket&&ticket.revision===action.revision&&ticket.runDisposition==='mustRun'&&ticket.holder.kind==='seat'&&ticket.holder.agentId===action.holder);
    }
    case 'merge':{
      const pr=prOf(input,action.pr);
      return !!pr&&(pr.state.kind==='closed'||pr.head!==action.head||canonical(pr.target)!==canonical(action.target))||(effect.state.kind==='ready'||effect.state.kind==='failed')&&source(input)!==undefined&&!effectPrecondition(state,effect,input).ok;
    }
    case 'publishPr':{
      const branch=source(input)?.branches.find(branch=>sameRepo(branch.repo,action.headRepo)&&branch.name===action.submission.payload.branch);
      const pr=action.pr?prOf(input,action.pr):undefined;
      return branch?.state.kind==='missing'||branch?.state.kind==='present'&&branch.state.head!==action.submission.payload.head||!!pr&&(pr.state.kind!=='open'||canonical(pr.target)!==canonical(action.target));
    }
    case 'rerunChecks':{const pr=prOf(input,action.pr);return !!pr&&(pr.state.kind!=='open'||pr.head!==action.head);}
    case 'setIssueState':{
      const issue=issueOf(input,action.issue);if(!issue)return false;
      return issue.bodyHash!==action.bodyHash||!issueStateBaselineMatches(action,issue);
    }
    case 'createIssue':case 'attachChild':case 'replaceBody':return false;
    default:{const exhaustive:never=action;return exhaustive;}
  }
}
function cancelEffect(state:Agenda,effect:Effect,reason:EffectCancelReason,input:Inputs):void {
  const obsolete=actionObsolete(state,effect,input);
  effect.state={kind:'cancelled',reason};
  const action=effect.action;
  if(action.kind==='publishPr'){
    const member=memberOf(state,action.member);
    if(member?.binding.kind==='publishing'&&member.binding.effectId===effect.id){
      const previous=member.binding.previous;
      const pr=previous.kind==='registered'?prOf(input,previous.pr):undefined;
      member.binding=previous.kind==='registered'&&pr?.state.kind==='open'&&sameRepo(pr.headRepo,previous.headRepo)&&pr.headBranch===previous.branch&&canonical(pr.target)===canonical(member.target)?previous:{kind:'none'};
      if(member.terminal.kind==='pending'&&issueOf(input,member.ref)?.state==='open'&&baseOf(input,member)?.state.kind==='present'){
        const baseline=acceptedHead(member);
        openWork(state,member,baseline?{kind:'unsubmittedPush',acceptedHead:baseline}:{kind:'initial'},input);
      }
    }
  }
  if(!obsolete)return;
  for(const item of state.cases){
    const operational=item.subject.kind==='effectFailure'&&item.subject.effectId===effect.id||item.subject.kind==='hostPrecondition'&&item.subject.effectId===effect.id||item.subject.kind==='checks'&&action.kind==='rerunChecks'||(item.subject.kind==='closed'||item.subject.kind==='reopened')&&action.kind==='setIssueState'&&sameRef(item.subject.member,action.issue);
    if(!operational)continue;
    const status=item.state;
    const direct=status.kind==='applying'&&status.required.length===1&&status.required[0]?.kind==='effect'&&status.required[0].effectId===effect.id;
    const recoverable=item.subject.kind==='effectFailure'||item.subject.kind==='hostPrecondition';
    if(direct||recoverable&&(status.kind==='open'||status.kind==='awaitingExternal'))item.state={kind:'cancelled',reason:'sourceEventSuperseded'};
  }
}
/** Host lifecycle consumes native authority and a read-only notification projection.
 * It cannot classify GitHub, change contracts, resolve business holds or end work. */
function refreshHostRequests(state:Agenda,host:HostObservation):void {
  const input={host};
  for(const unit of state.units){
    for(const member of unit.members){
      if(member.work&&!member.designOnly)requestFor(state,'owner',contextOf(member),input);
      for(const kind of ['review','accept'] as const){
        const gate=member[kind];if(gate&&gateHolderLost(state,gate,input))member[kind]=newGate(state,gate.kind,gate.context,gate.stamp,input);
      }
    }
    const gate=unit.postMerge;if(gate&&gateHolderLost(state,gate,input))unit.postMerge=newGate(state,gate.kind,gate.context,gate.stamp,input);
  }
  const gate=state.closure;if(gate&&gateHolderLost(state,gate,input))state.closure=newGate(state,gate.kind,gate.context,gate.stamp,input);
  for(const request of state.requests){
    const binding=request.binding;if(request.runId!==host.runId||binding.kind!=='bound')continue;
    const seat=host.seats.find(seat=>seat.agentId===binding.agentId&&seat.parentId===binding.parentId&&seat.status!=='aborted');
    if(seat?.sessionId)binding.sessionId=seat.sessionId;
  }
}
function wakeConsumed(state:Agenda,action:Extract<Action,{kind:'wake'}>):boolean {
  if(action.ticket.startsWith('work:'))return state.units.some(unit=>unit.members.some(member=>member.ownerTerminal&&`work:${member.ownerTerminal.workId}`===action.ticket));
  const gate=gateOf(state,action.ticket.slice(5));
  return gate?.receipt?.ticket===action.ticket&&gate.receipt.revision===action.revision||state.cases.some(item=>item.openedBy?.ticket===action.ticket&&item.openedBy.revision===action.revision||item.subject.kind==='findings'&&`gate:${item.subject.jobId}`===action.ticket);
}
function cancelHostWake(state:Agenda,effect:Effect,reason:EffectCancelReason):void {
  effect.state={kind:'cancelled',reason};
  for(const item of state.cases)if(item.subject.kind==='hostPrecondition'&&item.subject.effectId===effect.id&&(item.state.kind==='open'||item.state.kind==='awaitingExternal'||item.state.kind==='applying'))item.state={kind:'cancelled',reason:'sourceEventSuperseded'};
}
function observeHostDeliveries(state:Agenda,host:HostObservation,projected:readonly Ticket[]):void {
  for(const effect of state.effects){
    const action=effect.action;if(action.kind!=='wake'||effect.state.kind==='confirmed'||effect.state.kind==='cancelled')continue;
    const absent=action.runId!==host.runId||!host.seats.some(seat=>seat.agentId===action.holder&&seat.status!=='aborted');
    const current=projected.some(ticket=>ticket.id===action.ticket&&ticket.revision===action.revision&&ticket.runDisposition==='mustRun'&&ticket.holder.kind==='seat'&&ticket.holder.agentId===action.holder);
    if(absent||wakeConsumed(state,action)||effect.state.kind==='ready'&&!current)cancelHostWake(state,effect,absent?'holderAbsent':'sourceAlreadyAdvanced');
  }
  for(const item of state.cases){
    const subject=item.subject;if(subject.kind!=='hostPrecondition'||item.state.kind!=='open'&&item.state.kind!=='awaitingExternal')continue;
    const request=state.requests.find(request=>request.id===subject.requestId);
    const current=request?.obligation.kind==='owner'?memberOf(state,request.obligation.member)?.ownerRequestId===request.id&&memberOf(state,request.obligation.member)?.work!==null:request?.obligation.kind==='gate'&&gateOf(state,request.obligation.jobId)?.requestId===request.id&&gateOf(state,request.obligation.jobId)?.status.kind==='requested';
    const effect=state.effects.find(effect=>effect.id===subject.effectId);
    if(!current&&(!effect||effect.state.kind==='confirmed'||effect.state.kind==='cancelled'))item.state={kind:'cancelled',reason:'sourceEventSuperseded'};
  }
  for(const ticket of projected){
    if(ticket.holder.kind!=='seat'||ticket.runDisposition!=='mustRun')continue;
    const requestId=ticket.holder.requestId;const request=state.requests.find(request=>request.id===requestId);if(!request||request.binding.kind!=='bound')continue;
    const binding=request.binding;const seat=host.seats.find(seat=>seat.agentId===binding.agentId&&seat.parentId===binding.parentId&&seat.status!=='aborted');if(!seat)continue;
    const previous=state.effects.filter(effect=>effect.action.kind==='wake'&&effect.action.ticket===ticket.id&&effect.action.revision===ticket.revision&&effect.action.holder===seat.agentId&&effect.action.runId===host.runId&&!(effect.state.kind==='cancelled'&&effect.attempt===0));
    for(const effect of previous){
      const status=effect.state;
      if(status.kind==='confirmed'&&status.result.kind==='delivered'){
        const messageId=status.result.messageId;
        if(!host.turnEnds.some(end=>end.agentId===seat.agentId&&end.runId===host.runId&&end.messageId===messageId))continue;
        const refs=request.context.kind==='member'?[request.context.member]:request.context.kind==='unit'?state.units.find(unit=>request.context.kind==='unit'&&unit.id===request.context.unitId)?.members.map(member=>member.ref)??[]:[];
        const baselines=refs.flatMap(ref=>{const member=memberOf(state,ref);return member?[{issue:ref,hash:member.contract.bodyHash}]:[];});
        const gate=request.obligation.kind==='gate'?gateOf(state,request.obligation.jobId):undefined;
        if(gate?.stamp.kind==='closure')baselines.push({issue:gate.stamp.parent,hash:gate.stamp.bodyHash});
        allocateCase(state,request.context,{kind:'hostPrecondition',requestId:request.id,effectId:effect.id,attempt:effect.attempt,reason:'seatNonresponse'},'Delivered work turn ended without an accepted protocol reply',baselines);
      }
    }
    if(previous.length===0&&(seat.status==='parked'||seat.status==='idle'&&!seat.streaming)&&!state.effects.some(effect=>effect.action.kind==='wake'&&effect.action.holder===seat.agentId&&effect.state.kind==='uncertain'))addEffect(state,request.context,{kind:'wake',requestId:request.id,ticket:ticket.id,revision:ticket.revision,holder:seat.agentId,runId:host.runId,body:ticket.brief});
  }
}
function normalizeHolds(before:Agenda,state:Agenda,input:Inputs):void {
  for(const unit of state.units)for(const member of unit.members)if(member.work){
    const old=memberOf(before,member.ref)?.work;
    if(old?.id===member.work.id&&old.contentVersion===member.work.contentVersion&&availability(before,old,input).kind==='held'&&availability(state,member.work,input).kind==='runnable')member.work.contentVersion++;
  }
  for(const work of state.designWorks){const old=before.designWorks.find(old=>old.id===work.id);if(old&&old.contentVersion===work.contentVersion&&availability(before,old,input).kind==='held'&&availability(state,work,input).kind==='runnable')work.contentVersion++;}
}
export function transition(original:Agenda,input:Inputs,rawEvent:Event):Transition {
  const parsed=parseEvent(rawEvent);if(!parsed.ok)return {kind:'rejected',error:error('wrongTicketKind',`${parsed.error.path}: ${parsed.error.reason}`)};
  const event=parsed.value;
  if(event.kind==='reply'){
    const replay=replyReplay(original,input,event);
    if(!replay.ok)return {kind:'rejected',error:replay.error};
    if(replay.value!==null)return {kind:'same',reply:replay.value};
  }
  if(original.lifecycle==='completed')return event.kind==='observe'||event.kind==='hostObserved'?{kind:'same',reply:null}:{kind:'rejected',error:error('superseded','Completed agenda is immutable except exact receipt replay')};
  const state=structuredClone(original);let reply:ReplyResult|null=null;
  if(event.kind==='observe'){
    if(state.run.kind==='detached')state.run={kind:'attached',id:input.host.runId,mainAgentId:input.host.main.agentId,mainSessionId:input.host.main.sessionId};
    if(state.run.id!==input.host.runId)return {kind:'rejected',error:error('ownershipBlocked','Explicit resume is required for a different run')};
    if(input.facts.kind!=='available')return {kind:'rejected',error:error('sourceUnavailable',input.facts.error.message)};
    advanceObjects(state,input);classifySource(state,input);schedule(state,input);normalizeHolds(original,state,input);refreshHostRequests(state,input.host);observeHostDeliveries(state,input.host,tickets(state,input));classifyStall(state,input);
  }else if(event.kind==='hostObserved'){
    if(state.run.kind!=='attached'||state.run.id!==input.host.runId)return {kind:'same',reply:null};
    refreshHostRequests(state,input.host);
    observeHostDeliveries(state,input.host,tickets(state,input));
  }else if(event.kind==='reply'){
    const accepted=acceptReply(state,input,event);if(!accepted.ok)return {kind:'rejected',error:accepted.error};reply=accepted.value;normalizeHolds(original,state,input);
  }else if(event.kind==='mainNoCode'){
    if(!mainCaller(input,event.caller))return {kind:'rejected',error:error('unauthorized','Main-only classification')};
    const current=state.units.find(unit=>!unitEnded(state,unit,input));const member=current?.members.find(member=>sameRef(member.ref,event.member));const issue=issueOf(input,event.member);
    if(member?.terminal.kind==='noCode'&&member.terminal.bodyHash===event.bodyHash&&member.terminal.reason===event.reason)return {kind:'same',reply:null};
    if(!member||member.terminal.kind!=='pending'||!issue||issue.bodyHash!==event.bodyHash||input.facts.kind!=='available'||sourceMergedPr(member,input.facts.facts)||state.effects.some(effect=>effect.scope.kind==='member'&&sameRef(effect.scope.member,event.member)&&(effect.state.kind==='executing'||effect.state.kind==='uncertain')))return {kind:'rejected',error:error('premiseChanged','No-code requires exact pending current member and fresh source without a real merge or unconfirmed writes')};
    finishOwner(member,'noCode',{kind:'confirmNoCode',bodyHash:event.bodyHash,reason:event.reason});
    member.reconciledEvent=issue.lastReopen?.id??null;
    member.terminal={kind:'noCode',bodyHash:event.bodyHash,reason:event.reason,acceptedAt:event.acceptedAt};invalidateGates(member,'superseded');
  }else if(event.kind==='resume'){
    if(event.runId!==input.host.runId)return {kind:'rejected',error:error('ownershipBlocked','Resume run must be actual current host run')};
    state.run={kind:'attached',id:event.runId,mainAgentId:input.host.main.agentId,mainSessionId:input.host.main.sessionId};
    for(const request of state.requests)if(request.runId!==event.runId){
      const member=request.context.kind==='member'?memberOf(state,request.context.member):undefined;
      if(request.role==='owner'&&member?.ownerRequestId===request.id)member.ownerRequestId=null;
    }
    for(const effect of state.effects)if(effect.action.kind==='wake'&&effect.action.runId!==event.runId&&effect.state.kind!=='confirmed'&&effect.state.kind!=='cancelled')cancelEffect(state,effect,'holderAbsent',input);
    for(const unit of state.units){for(const member of unit.members)invalidateGates(member,'superseded');if(unit.postMerge?.status.kind==='requested')unit.postMerge.status={kind:'cancelled',reason:'superseded'};}
    if(state.closure?.status.kind==='requested')state.closure.status={kind:'cancelled',reason:'superseded'};
  }else{
    const effect=state.effects.find(effect=>effect.id===event.id);if(!effect)return {kind:'rejected',error:error('unknownTicket','Effect identity does not exist')};
    switch(event.kind){
      case 'effectStarted':{
        if(effect.state.kind!=='ready'||event.attempt!==effect.attempt+1)return {kind:'rejected',error:error('premiseChanged','Effect is not ready for that attempt')};
        if(effect.state.provenance.kind==='accepted'){
          const provenance=effect.state.provenance;
          const wait=provenance.previous.kind==='delivery'?null:provenance.previous.wait;
          if(event.startedAt<provenance.acceptedAt||wait?.kind==='rateLimitReset'&&event.startedAt<wait.resetAt)return {kind:'rejected',error:error('premiseChanged','Execution predates its accepted authorization or source query reset')};
        }
        if(effect.action.kind!=='wake'&&satisfiedResult(state,effect,input)!==null)return {kind:'rejected',error:error('premiseChanged','Queryable target is already satisfied; confirm without starting an attempt')};
        const preflight=effectPrecondition(state,effect,input);if(!preflight.ok)return {kind:'rejected',error:preflight.error};
        effect.attempt=event.attempt;effect.state={kind:'executing',attempt:event.attempt,startedAt:event.startedAt};break;
      }
      case 'effectSatisfied':{
        if(effect.action.kind==='wake'||effect.state.kind!=='ready'&&effect.state.kind!=='uncertain'||!resultMatches(state,effect,event.result,input,false))return {kind:'rejected',error:error('premiseChanged','Source does not prove this queryable action already satisfied')};
        confirmEffect(state,effect,event.result,input);break;
      }
      case 'effectConfirmed':{
        if(effect.state.kind!=='executing'||event.attempt!==effect.attempt||!resultMatches(state,effect,event.result,input,true))return {kind:'rejected',error:error('premiseChanged','Confirmation does not match the actual attempt/source result')};
        confirmEffect(state,effect,event.result,input);break;
      }
      case 'effectFailed':{
        const action=effect.action;
        const currentBodyHash=action.kind==='replaceBody'?issueOf(input,action.edit.issue)?.bodyHash:action.kind==='publishPr'&&action.pr?prOf(input,action.pr)?.bodyHash:undefined;
        const expected=action.kind==='replaceBody'?action.edit.expectedHash:action.kind==='publishPr'?action.expectedBodyHash:undefined;
        const targetBodyHash=action.kind==='replaceBody'?bodyHash(action.edit.body):action.kind==='publishPr'?bodyHash(action.body):undefined;
        const unstarted=effect.state.kind==='ready'&&event.outcome==='knownFailed'&&event.error.kind==='precondition'&&event.attempt===effect.attempt&&currentBodyHash!==undefined&&currentBodyHash!==expected&&currentBodyHash!==targetBodyHash;
        if(!unstarted&&(effect.state.kind!=='executing'||effect.attempt!==event.attempt))return {kind:'rejected',error:error('premiseChanged','Failure must identify the current executed attempt or exact unsent body conflict')};
        if(event.outcome==='uncertain'&&event.attempt<1)return {kind:'rejected',error:error('premiseChanged','An unstarted action is not an uncertain execution')};
        const wait=event.error.kind==='rateLimited'?{kind:'rateLimitReset' as const,resetAt:event.error.resetAt}:null;
        const startedAt=effect.state.kind==='executing'?effect.state.startedAt:null;
        const received=event.received??null;
        if(received&&(event.outcome==='knownFailed'||effect.action.kind==='createIssue'&&(received.kind!=='issue'||!sameRepo(received.issue.repo,effect.action.spec.repo))||effect.action.kind==='publishPr'&&(received.kind!=='pr'||!sameRepo(received.pr.repo,effect.action.target.repo))||effect.action.kind!=='createIssue'&&effect.action.kind!=='publishPr'))return {kind:'rejected',error:error('premiseChanged','Returned identity does not match this uncertain creation attempt')};
        if(event.outcome==='uncertain'){
          if(startedAt===null)return {kind:'rejected',error:error('premiseChanged','An uncertain write requires real attempt provenance')};
          effect.state={kind:'uncertain',attempt:effect.attempt,startedAt,received,error:event.error,wait};
        }else effect.state={kind:'failed',attempt:effect.attempt,provenance:startedAt===null?{kind:'preflight'}:{kind:'call',startedAt},received,error:event.error,wait};
        const subject:CaseSubject=effect.action.kind==='wake'?{kind:'hostPrecondition',requestId:effect.action.requestId,effectId:effect.id,attempt:effect.attempt,reason:event.error.kind==='precondition'?'planMode':'seatNonresponse'}:{kind:'effectFailure',effectId:effect.id};
        const prior=state.cases.find(item=>canonical(item.subject)===canonical(subject));
        if(prior&&(prior.state.kind==='resolved'||prior.state.kind==='applying')){prior.state={kind:'open'};prior.contentVersion++;}
        else newCase(state,effect.scope,subject,event.error.message,input);
        break;
      }
      case 'effectCancelled':{
        if(effect.state.kind==='confirmed'||effect.state.kind==='cancelled')return {kind:'same',reply:null};
        if(effect.state.kind==='executing'||effect.state.kind==='uncertain'){
          const action=effect.action;
          const holderAbsent=action.kind==='wake'&&(action.runId!==input.host.runId||!input.host.seats.some(seat=>seat.agentId===action.holder&&seat.status!=='aborted'));
          const pr=action.kind==='merge'?prOf(input,action.pr):undefined;
          const mergedInapplicable=action.kind==='merge'&&pr!==undefined&&(pr.state.kind==='closed'||pr.state.kind==='merged'&&(pr.head!==action.head||canonical(pr.target)!==canonical(action.target)));
          const issue=action.kind==='setIssueState'?issueOf(input,action.issue):undefined;
          const lifecycleInapplicable=action.kind==='setIssueState'&&issue!==undefined&&!issueStateBaselineMatches(action,issue);
          if(!holderAbsent&&!mergedInapplicable&&!lifecycleInapplicable)return {kind:'rejected',error:error('premiseChanged','An unknown write cannot be cancelled without source proof of inapplicability')};
        }
        cancelEffect(state,effect,event.reason,input);break;
      }
    }
  }
  if(event.kind!=='hostObserved')normalizeHolds(original,state,input);
  if(canonical(state)===canonical(original))return {kind:'same',reply};
  state.version=original.version+1;
  return {kind:'next',state,reply};
}
