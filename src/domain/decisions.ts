import type {Agenda,Amendment,ApplyingRef,CaseDecision,Context,DecisionCase,DesignRequirement,DomainError,Draft,DraftSpec,Effect,Inputs,Insertion,IssueRef,Member,Position,Result,RetryProvenance,ShaRef} from './model.ts';
import {bodyHash,canonical,contains,memberOf,nextId,publicationAssociation,refKey,sameRef,sameRepo,unitOf} from './identity.ts';

export type DecisionServices={newCase:(context:Context,subject:DecisionCase['subject'],evidence:string)=>DecisionCase;openWork:(member:Member,basis:string)=>void;addEffect:(scope:Context,action:Agenda['effects'][number]['action'])=>string;validateInsertion:(entry:Insertion)=>Result<null,DomainError>;insert:(entry:Insertion)=>Result<readonly ApplyingRef[],DomainError>;newDraft:(spec:DraftSpec,position:Position,purpose:Draft['purpose'],caseId:string,reservedId?:string)=>Result<Draft,DomainError>;finishWork:(member:Member,kind:'noCode'|'replacePr'|'sourceRestored',decision:CaseDecision)=>void};
const allowed:Record<Exclude<DecisionCase['subject']['kind'],'claim'>,readonly CaseDecision['kind'][]>={
  findings:['upholdOwner','upholdMain','reject','outOfScope','amend'],closed:['confirmNoCode','reopen'],reopened:['restore','correct','revokeNoCode'],checks:['rerun','fix','waitExternal'],postMerge:['reverify','correct','correctDesign'],closure:['reverify','correct','correctDesign'],orphanDesign:['assignCarrier','waitExternal'],migration:['assignMigration','waitExternal'],agendaGap:['includeExisting','confirmNoCode','waitExternal'],effectFailure:['retry','waitExternal','adoptResult','retryAfterAbsence','rebaseEdit'],unexpectedSourceChange:['keepWork','replacePr','sourceRestored','acceptExternalMerge','amend'],hostPrecondition:['retryHost','waitExternal'],stall:['includeExisting','assignCarrier','rebaseEdit','waitExternal'],
};
const claimAllowed:Record<'question'|'noCode'|'split'|'blocked',readonly CaseDecision['kind'][]>={question:['answer','outOfDomain','implementationDefect','amend'],noCode:['confirmNoCode','refute'],split:['split','refute'],blocked:['replacePr','waitExternal','refute']};
export function allowedDecisionKinds(state:Agenda,item:DecisionCase):readonly CaseDecision['kind'][] {
  const member=item.context.kind==='member'?memberOf(state,item.context.member):undefined;
  if(item.subject.kind==='findings'&&member?.terminal.kind==='merged')return ['reject','outOfScope','correct','correctDesign'];
  if(item.subject.kind==='unexpectedSourceChange'&&member?.terminal.kind==='merged')return ['keepWork','amend'];
  return item.subject.kind==='claim'?claimAllowed[item.subject.claim.kind]:allowed[item.subject.kind];
}
function reject(message:string):Result<null,DomainError>{return {ok:false,error:{kind:'invalidDecision',message,current:null}};}
function effectOf(state:Agenda,item:DecisionCase){const subject=item.subject;return subject.kind==='effectFailure'?state.effects.find(effect=>effect.id===subject.effectId):subject.kind==='hostPrecondition'&&subject.effectId?state.effects.find(effect=>effect.id===subject.effectId):undefined;}
function bodyAt(input:Inputs,ref:IssueRef){return input.facts.kind==='available'?input.facts.facts.issues.find(issue=>sameRef(issue.ref,ref)):undefined;}
function terminalFindingCorrection(state:Agenda,item:DecisionCase,input:Inputs,insertion:Insertion):Result<null,DomainError> {
  if(item.subject.kind!=='findings'||item.context.kind!=='member')return reject('Correction requires the original member finding');
  const member=memberOf(state,item.context.member);const stamp=item.subject.stamp;
  if(!member||member.terminal.kind!=='merged'||stamp.kind!=='review'&&stamp.kind!=='accept')return reject('Terminal finding correction requires an observed merged member');
  const terminal=member.terminal;const pr=input.facts.kind==='available'?input.facts.facts.prs.find(pr=>sameRef(pr.ref,terminal.pr)):undefined;
  if(!sameRef(stamp.pr,terminal.pr)||canonical(stamp.target)!==canonical(member.target)||!pr||pr.state.kind!=='merged'||pr.head!==stamp.head||pr.state.sha!==terminal.merge.sha||canonical(pr.target)!==canonical(member.target))return reject('Finding, terminal and fresh source do not identify the same merged PR head and target');
  const unit=unitOf(state,member.ref);
  if(!unit||insertion.position.kind!=='correctionOf'||insertion.position.unitId!==unit.id)return reject('Terminal finding correction must remain inside the original unit');
  return {ok:true,value:null};
}
export function correctDesignAmendment(state:Agenda,item:DecisionCase,decision:Extract<CaseDecision,{kind:'correctDesign'}>):Result<Extract<Amendment,{kind:'designGap'}>,DomainError> {
  const insertion=decision.insertion;const context=item.context;
  const target=insertion.kind==='draft'?insertion.draft.target:insertion.entry.target;
  const scoped=context.kind==='member'?[context.member]:context.kind==='unit'?state.units.find(unit=>unit.id===context.unitId)?.members.map(member=>member.ref)??[]:state.units.flatMap(unit=>unit.members.map(member=>member.ref));
  const affected=scoped.filter(ref=>sameRepo(memberOf(state,ref)?.target.repo??ref.repo,target.repo));
  if(affected.length===0&&state.parent&&context.kind==='agenda')affected.push(state.parent);
  const first=affected[0];
  return first?{ok:true,value:{kind:'designGap',affected:[first,...affected.slice(1)],bodyEdits:[],route:{kind:'defaultFirst',repo:target.repo}}}:{ok:false,error:{kind:'invalidDecision',message:'Design correction has no actual affected scope',current:null}};
}
function allRequired(item:DecisionCase,decision:CaseDecision,refs:readonly ApplyingRef[]):void {
  const first=refs[0];item.state=first?{kind:'applying',decision,required:[first,...refs.slice(1)]}:{kind:'resolved',result:decision};
}
function authorizeRetry(effect:Effect,item:DecisionCase,acceptedAt:number,authorization:'retry'|'retryAfterAbsence'|'retryHost'):void {
  const status=effect.state;let previous:RetryProvenance;
  if(status.kind==='failed')previous=status.provenance.kind==='preflight'?{kind:'preflight',error:status.error,wait:status.wait}:{kind:'call',startedAt:status.provenance.startedAt,received:status.received,error:status.error,wait:status.wait};
  else if(status.kind==='uncertain')previous={kind:'call',startedAt:status.startedAt,received:status.received,error:status.error,wait:status.wait};
  else throw new Error('Only a failed or uncertain attempt can acquire retry authorization');
  effect.authorization=authorization;effect.state={kind:'ready',provenance:{kind:'accepted',caseId:item.id,acceptedAt,previous}};
}
function amend(state:Agenda,item:DecisionCase,proposal:Amendment,input:Inputs,services:DecisionServices,decision:CaseDecision={kind:'amend',amendment:proposal},transfers:readonly Insertion[]=proposal.kind==='acceptanceMethod'?[proposal.transfer]:[]):Result<null,DomainError>{
  if(proposal.affected.some(ref=>!memberOf(state,ref)&&!(state.parent&&sameRef(state.parent,ref))))return reject('Affected object is not in this agenda');
  const insertedIssues=new Set<string>();
  for(const transfer of transfers){
    const valid=services.validateInsertion(transfer);if(!valid.ok)return valid;
    if(transfer.kind==='existing'){
      const key=refKey(transfer.entry.issue);if(insertedIssues.has(key))return reject('Duplicate insertion intent');insertedIssues.add(key);
    }
  }
  for(const edit of proposal.bodyEdits)if(bodyAt(input,edit.issue)?.bodyHash!==edit.expectedHash)return {ok:false,error:{kind:'premiseChanged',message:'Body edit baseline changed',current:null}};
  if(new Set(proposal.affected.map(refKey)).size!==proposal.affected.length||new Set(proposal.bodyEdits.map(edit=>refKey(edit.issue))).size!==proposal.bodyEdits.length)return reject('Affected subjects and body edits must be unique');
  if(proposal.kind==='designGap'&&proposal.route.kind==='future'){
    const originRef=item.context.kind==='member'?item.context.member:proposal.affected[0]!;
    const origin=memberOf(state,originRef);const originUnit=unitOf(state,originRef);
    const carrier=proposal.route.carrier;
    if('number'in carrier){
      const target=memberOf(state,carrier);const targetUnit=unitOf(state,carrier);
      const later=originUnit!==undefined&&targetUnit!==undefined&&(state.units.indexOf(targetUnit)>state.units.indexOf(originUnit)||targetUnit===originUnit&&originUnit.members.findIndex(member=>sameRef(member.ref,carrier))>originUnit.members.findIndex(member=>sameRef(member.ref,originRef)));
      if(!origin||!target||!later||target.terminal.kind!=='pending'||bodyAt(input,target.ref)?.state!=='open'||!sameRepo(target.target.repo,origin.target.repo))return reject('future requires an open, same-repository genuinely later pending carrier at decision acceptance');
    }else if(!origin||!carrier.designOnly||!sameRepo(carrier.repo,origin.target.repo)||!sameRepo(carrier.target.repo,origin.target.repo))return reject('future draft must be an explicit same-repository designOnly carrier');
  }
  const affected=state.units.flatMap(unit=>unit.members).filter(member=>proposal.affected.some(ref=>sameRef(ref,member.ref))).map(member=>member.ref);
  if(state.parent&&proposal.affected.some(ref=>sameRef(ref,state.parent!)))affected.push(state.parent);
  for(const ref of affected){const member=memberOf(state,ref);if(member?.terminal.kind==='pending')services.openWork(member,item.evidence);}
  let designWork:string|null=null;
  if(proposal.kind==='designGap'){
    designWork=nextId(state,'work');state.designWorks.push({id:designWork,parentCaseId:item.id,affected:proposal.affected,clauses:decision.kind==='correctDesign'?decision.clauses:[item.evidence],route:proposal.route,contentVersion:1,holds:[],result:null,receipt:null});
  }
  const amendmentId=nextId(state,'amendment');
  const insertions:Extract<Agenda['amendments'][number]['state'],{kind:'pending'}>['insertions']=[];
  const draftIds=transfers.map(insertion=>insertion.kind==='draft'?nextId(state,'draft'):null);
  for(const [index,insertion]of transfers.entries()){
    if(insertion.kind==='draft'){const id=draftIds[index];if(!id)throw new Error('Draft allocation missing');const draft=services.newDraft(insertion.draft,insertion.position,insertion.position.kind==='outsideAgenda'?'outsideAgenda':'split',item.id,id);if(!draft.ok)return draft;insertions.push({kind:'draft',draftId:draft.value.id});}
    else insertions.push(insertion);
  }
  const bodyEdits=[...proposal.bodyEdits].sort((a,b)=>refKey(a.issue).localeCompare(refKey(b.issue)));
  const effectIds=bodyEdits.map(edit=>services.addEffect(item.context,{kind:'replaceBody',amendmentId,edit}));
  if(state.parent){
    const parent=bodyAt(input,state.parent);if(!parent)return {ok:false,error:{kind:'sourceUnavailable',message:'Parent attachment source unavailable',current:null}};
    for(const insertion of transfers)if(insertion.kind==='existing'&&!parent.children.some(child=>sameRef(child,insertion.entry.issue)))effectIds.push(services.addEffect(item.context,{kind:'attachChild',owner:{kind:'insertion',caseId:item.id,insertion},parent:state.parent,child:insertion.entry.issue}));
  }
  state.amendments.push({id:amendmentId,caseId:item.id,affected:proposal.affected,state:{kind:'pending',bodyEdits,designWork,insertions,requiredEffectIds:effectIds}});
  for(const ref of proposal.affected){const member=memberOf(state,ref);if(member?.work&&!member.work.holds.some(hold=>hold.kind==='amendment'&&hold.id===amendmentId))member.work.holds.push({kind:'amendment',id:amendmentId});}
  allRequired(item,decision,[{kind:'amendment',id:amendmentId}]);return {ok:true,value:null};
}
export function applyDecision(state:Agenda,item:DecisionCase,decision:CaseDecision,input:Inputs,acceptedAt:number,services:DecisionServices):Result<null,DomainError>{
  const kinds=allowedDecisionKinds(state,item);
  if(!kinds.includes(decision.kind))return reject(`Decision ${decision.kind} is not allowed for ${item.subject.kind}`);
  if(item.state.kind!=='open'&&item.state.kind!=='awaitingExternal')return reject('Only current open or waiting case can be decided');
  for(const baseline of item.bodyBaselines){const current=bodyAt(input,baseline.issue);if(current&&current.bodyHash!==baseline.hash)return {ok:false,error:{kind:'premiseChanged',message:'Case body baseline changed; observe current input first',current:null}};}
  const member=item.context.kind==='member'?memberOf(state,item.context.member):undefined;
  const effect=effectOf(state,item);
  switch(decision.kind){
    case 'answer':case 'outOfDomain':case 'reject':case 'refute':{
      if(member){const current=bodyAt(input,member.ref);if(current&&current.bodyHash!==member.contract.bodyHash){member.contract.body=current.body;member.contract.bodyHash=current.bodyHash;member.contract.revision++;if(member.work)member.work.contentVersion++;}}
      const job=item.subject.kind==='claim'&&item.subject.ticket.startsWith('gate:')?item.subject.ticket.slice(5):item.subject.kind==='findings'?item.subject.jobId:null;
      if(job){
        const gates=[...state.units.flatMap(unit=>[unit.postMerge,...unit.members.flatMap(member=>[member.review,member.accept])]),state.closure];
        const gate=gates.find(gate=>gate?.id===job);
        if(gate){
          const ruling=decision.kind==='answer'||decision.kind==='outOfDomain'?{kind:'questionAnswered' as const,question:item.evidence,classification:decision.kind,basis:decision.basis,applicableContractRevision:member?.contract.revision??1}:{kind:'findingRejected' as const,finding:item.evidence,basis:decision.basis,applicableContractRevision:member?.contract.revision??1};
          const context=item.context;
          if(member)member.rulings.push({kind:gate.kind,ruling});
          else if(context.kind==='unit')state.units.find(unit=>unit.id===context.unitId)?.rulings.push(ruling);
          else state.rulings.push(ruling);
          gate.status={kind:'cancelled',reason:'superseded'};
        }
      }
      item.state={kind:'resolved',result:decision};break;
    }
    case 'implementationDefect':case 'upholdOwner':case 'fix':{
      if(!member||member.terminal.kind!=='pending')return reject('Implementation work requires the original pending member; terminal findings require a correction');
      services.openWork(member,decision.basis);item.state={kind:'resolved',result:decision};break;
    }
    case 'upholdMain':{
      if(!member||member.terminal.kind!=='pending')return reject('Main design repair of a terminal finding requires correctDesign');services.openWork(member,decision.basis);
      const id=nextId(state,'work');state.designWorks.push({id,parentCaseId:item.id,affected:[member.ref],clauses:[decision.basis],route:{kind:'withPr',member:member.ref},contentVersion:1,holds:[],result:null,receipt:null});
      allRequired(item,decision,[{kind:'design',workId:id}]);break;
    }
    case 'amend':return amend(state,item,decision.amendment,input,services);
    case 'confirmNoCode':{
      if(item.subject.kind==='agendaGap'&&(!decision.issue||!sameRef(decision.issue,item.subject.issue)))return reject('No-code must classify the exact missing child');
      if(item.subject.kind!=='agendaGap'&&decision.issue!==undefined)return reject('A member no-code case does not accept a payload-selected issue');
      const ref=decision.issue??member?.ref;if(!ref)return reject('No-code requires an exact issue');let target=memberOf(state,ref);const issue=bodyAt(input,ref);
      if(!target&&item.subject.kind==='agendaGap'){
        const repo=input.facts.kind==='available'?input.facts.facts.repos.find(repo=>sameRepo(repo.repo,ref.repo)):undefined;
        if(!repo)return {ok:false,error:{kind:'sourceUnavailable',message:'Missing-child default target source unavailable',current:null}};
        const inserted=services.insert({kind:'existing',entry:{issue:ref,target:{repo:ref.repo,base:repo.defaultBranch},designOnly:false,adoptPr:null},position:{kind:'after',unitId:state.units.at(-1)!.id}});
        if(!inserted.ok)return {ok:false,error:inserted.error};target=memberOf(state,ref);
      }
      if(!target||!issue||issue.bodyHash!==decision.bodyHash||target.terminal.kind==='merged')return {ok:false,error:{kind:'premiseChanged',message:'No-code source body/terminal changed',current:null}};
      if(state.effects.some(effect=>effect.scope.kind==='member'&&sameRef(effect.scope.member,target.ref)&&(effect.state.kind==='executing'||effect.state.kind==='uncertain')))return reject('Unconfirmed mutation cannot be swallowed by no-code');
      services.finishWork(target,'noCode',decision);target.terminal={kind:'noCode',bodyHash:decision.bodyHash,reason:decision.reason,acceptedAt};item.state={kind:'resolved',result:decision};break;
    }
    case 'split':{
      if(!member||!sameRef(decision.bodyEdit.issue,member.ref))return reject('Split body edit must narrow the original member');
      const proposal:Amendment={kind:'acceptanceMethod',affected:[member.ref],bodyEdits:[decision.bodyEdit],transfer:decision.insertions[0]!};
      return amend(state,item,proposal,input,services,decision,decision.insertions);
    }
    case 'replacePr':{
      if(!member)return reject('PR replacement requires member');
      if(member.binding.kind==='registered'&&!sameRef(member.binding.pr,decision.pr))return reject('Decision must identify the original abandoned PR');
      services.finishWork(member,'replacePr',decision);member.binding={kind:'none'};member.baseline={kind:'none'};item.state={kind:'resolved',result:decision};break;
    }
    case 'waitExternal':{
      if(effect&&(effect.state.kind==='failed'||effect.state.kind==='uncertain')){effect.state.wait={kind:'source',condition:decision.condition};item.state={kind:'awaitingExternal',wait:{kind:'effect',effectId:effect.id}};}
      else item.state={kind:'awaitingExternal',wait:{kind:'caseSource',condition:decision.condition}};
      item.contentVersion++;break;
    }
    case 'reopen':case 'restore':case 'revokeNoCode':{
      if(!member||(item.subject.kind!=='closed'&&item.subject.kind!=='reopened')||item.subject.event?.id!==decision.eventId)return reject('Lifecycle event is not the exact case subject');
      const issue=bodyAt(input,member.ref);if(!issue)return {ok:false,error:{kind:'sourceUnavailable',message:'Lifecycle source unavailable',current:null}};
      member.reconciledEvent=decision.eventId;
      if(decision.kind==='revokeNoCode'){if(member.terminal.kind!=='noCode')return reject('Only a no-code terminal can be revoked');member.terminal={kind:'pending'};}
      const open=decision.kind!=='restore';
      const id=services.addEffect(item.context,{kind:'setIssueState',issue:member.ref,open,afterEvent:item.subject.event,bodyHash:issue.bodyHash});allRequired(item,decision,[{kind:'effect',effectId:id}]);break;
    }
    case 'outOfScope':{const draft=services.newDraft(decision.draft,{kind:'outsideAgenda'},'outsideAgenda',item.id);if(!draft.ok)return draft;allRequired(item,decision,[{kind:'draft',draftId:draft.value.id}]);break;}
    case 'correctDesign':{
      const insertion=decision.insertion;
      if(item.subject.kind==='findings'){const valid=terminalFindingCorrection(state,item,input,insertion);if(!valid.ok)return valid;}
      const context=item.context;
      if(context.kind==='unit'&&(insertion.position.kind!=='correctionOf'||insertion.position.unitId!==context.unitId))return reject('Design correction must remain in the exact verification unit');
      const proposal=correctDesignAmendment(state,item,decision);if(!proposal.ok)return proposal;
      return amend(state,item,proposal.value,input,services,decision,[insertion]);
    }
    case 'correct':{
      const insertion='insertion'in decision?decision.insertion:{kind:'draft' as const,draft:decision.draft,position:{kind:'correctionOf' as const,unitId:member?unitOf(state,member.ref)!.id:item.context.kind==='unit'?item.context.unitId:state.units.at(-1)!.id}};
      if(item.subject.kind==='findings'){const valid=terminalFindingCorrection(state,item,input,insertion);if(!valid.ok)return valid;}
      const inserted=services.insert(insertion);if(!inserted.ok)return {ok:false,error:inserted.error};allRequired(item,decision,inserted.value);if(item.subject.kind==='reopened'&&member)member.reconciledEvent=item.subject.event.id;break;
    }
    case 'reverify':{
      const context=item.context;
      const subject=item.subject;
      if((subject.kind==='postMerge'||subject.kind==='closure')&&subject.cause.kind==='ancestry'&&input.facts.kind==='available'&&subject.cause.comparisons.some(comparison=>input.facts.kind==='available'&&input.facts.facts.commits.some(pair=>sameRepo(pair.repo,comparison.ancestor.repo)&&pair.ancestor===comparison.ancestor.sha&&pair.descendant===comparison.descendant.sha&&pair.result==='notContained')))return reject('Unchanged source-proven noncontainment cannot be cleared by reverify');
      if(context.kind==='unit'){const unit=state.units.find(unit=>unit.id===context.unitId);if(unit?.postMerge)unit.postMerge.status={kind:'cancelled',reason:'superseded'};}
      else if(state.closure)state.closure.status={kind:'cancelled',reason:'superseded'};
      item.state={kind:'resolved',result:decision};break;
    }
    case 'rerun':{
      if(item.subject.kind!=='checks'||!member)return reject('Rerun needs exact failed Actions checks');
      const failure=item.subject.failures.find(failure=>failure.kind==='actions'&&failure.workflowRunId===decision.runId);
      if(!failure||failure.kind!=='actions'||member.binding.kind!=='registered')return reject('Source does not provide an Actions workflow rerun');
      const id=services.addEffect(item.context,{kind:'rerunChecks',pr:member.binding.pr,repo:member.target.repo,workflowRunId:failure.workflowRunId,previousAttempt:failure.runAttempt,head:failure.head});allRequired(item,decision,[{kind:'effect',effectId:id}]);break;
    }
    case 'includeExisting':{
      if(item.subject.kind==='agendaGap'&&!sameRef(item.subject.issue,decision.issue))return reject('Include must carry the original missing child');
      if(item.subject.kind==='stall'){
        const subject=item.subject;const position=decision.position;
        const unit=position.kind==='correctionOf'?state.units.find(unit=>unit.id===position.unitId&&subject.obligations.some(ref=>ref.kind==='unit'&&ref.id===unit.id)):undefined;
        if(!unit||!unit.members.some(member=>sameRepo(member.target.repo,decision.issue.repo)))return reject('Stall insertion must correct the exact referenced unit and repository');
      }
      const repo=input.facts.kind==='available'?input.facts.facts.repos.find(repo=>sameRepo(repo.repo,decision.issue.repo)):undefined;if(!repo)return reject('Existing issue repository/default source missing');
      const inserted=services.insert({kind:'existing',entry:{issue:decision.issue,target:{repo:decision.issue.repo,base:repo.defaultBranch},designOnly:false,adoptPr:null},position:decision.position});if(!inserted.ok)return {ok:false,error:inserted.error};allRequired(item,decision,inserted.value);break;
    }
    case 'assignCarrier':{
      let original:DesignRequirement|null=item.subject.kind==='orphanDesign'?item.subject.requirement:null;
      if(item.subject.kind==='stall'){
        const ids=new Set(item.subject.obligations.filter(ref=>ref.kind==='unit').map(ref=>ref.id));
        const matches=state.units.filter(unit=>ids.has(unit.id)).flatMap(unit=>unit.members.flatMap(member=>member.contract.requirements)).filter(requirement=>canonical(requirement.commit)===canonical(decision.commit));
        if(matches.length!==1)return reject('Stall carrier must identify one unique original design requirement');
        original=matches[0]!;
      }
      if(!original||canonical(original.commit)!==canonical(decision.commit))return reject('Carrier must carry the exact original repo-qualified design requirement');
      const provenance=original;const preserveRoute=item.subject.kind==='stall';
      for(const unit of state.units)for(const affected of unit.members){
        const remaining=affected.contract.requirements.filter(requirement=>canonical(requirement)!==canonical(provenance));
        if(remaining.length===affected.contract.requirements.length)continue;
        affected.contract.requirements=remaining;
        if(affected.work){affected.work.required=remaining.filter(requirement=>requirement.carrier.kind==='member'&&sameRef(requirement.carrier.member,affected.ref)).map(requirement=>requirement.commit);affected.work.contentVersion++;}
      }
      if('number'in decision.carrier){
        const carrier=memberOf(state,decision.carrier);if(!carrier||!sameRepo(carrier.target.repo,decision.commit.repo)||carrier.terminal.kind!=='pending')return reject('Carrier is missing, terminal or from another repository');
        const requirement:DesignRequirement={caseId:provenance.caseId,commit:provenance.commit,carrier:{kind:'member',member:carrier.ref},route:preserveRoute?provenance.route:{kind:'future',carrier:carrier.ref}};
        carrier.contract.requirements.push(requirement);if(carrier.work){if(!carrier.work.required.some(commit=>canonical(commit)===canonical(provenance.commit)))carrier.work.required.push(provenance.commit);carrier.work.contentVersion++;}item.state={kind:'resolved',result:decision};
      }else{
        if(!sameRepo(decision.carrier.repo,decision.commit.repo)||!decision.carrier.designOnly)return reject('Draft design carrier must be same-repo designOnly');
        const created=services.newDraft(decision.carrier,{kind:'after',unitId:state.units.at(-1)!.id},'designOnly',item.id);if(!created.ok)return created;const draft=created.value;
        draft.requirement={caseId:provenance.caseId,commit:provenance.commit,carrier:{kind:'draft',draftId:draft.id},route:preserveRoute?provenance.route:{kind:'future',carrier:decision.carrier}};allRequired(item,decision,[{kind:'draft',draftId:draft.id}]);
      }break;
    }
    case 'assignMigration':{
      if(item.subject.kind!=='migration'||!sameRef(item.subject.original,decision.original))return reject('Migration must carry the original obligation');
      const originalUnit=unitOf(state,decision.original);if(!originalUnit)return reject('Original migration unit is missing');
      let anchor=originalUnit;
      for(const later of state.units.slice(state.units.indexOf(originalUnit)+1)){if(later.postMerge?.status.kind==='answered'&&later.postMerge.status.ok&&later.members.every(member=>member.terminal.kind!=='pending'))anchor=later;else break;}
      const migrationRepo='number'in decision.migration&&input.facts.kind==='available'?input.facts.facts.repos.find(repo=>sameRepo(repo.repo,decision.migration.repo)):undefined;
      if('number'in decision.migration&&!migrationRepo)return {ok:false,error:{kind:'sourceUnavailable',message:'Exact migration repository/default is unavailable',current:null}};
      const insertion:Insertion='number'in decision.migration?{kind:'existing',entry:{issue:decision.migration,target:{repo:decision.migration.repo,base:migrationRepo!.defaultBranch},designOnly:false,adoptPr:null},position:{kind:'after',unitId:anchor.id}}:{kind:'draft',draft:decision.migration,position:{kind:'after',unitId:anchor.id}};
      const inserted=services.insert(insertion);if(!inserted.ok)return {ok:false,error:inserted.error};allRequired(item,decision,inserted.value);break;
    }
    case 'retry':case 'retryAfterAbsence':{
      if(!effect||effect.id!==decision.effectId||effect.attempt!==decision.attempt)return reject('Retry does not match the failed effect attempt');
      if(decision.kind==='retry'&&effect.state.kind!=='failed')return reject('Ordinary retry cannot resend an uncertain mutation');
      if((effect.state.kind==='failed'||effect.state.kind==='uncertain')&&effect.state.wait?.kind==='rateLimitReset'&&acceptedAt<effect.state.wait.resetAt)return reject('Source reset forbids retry before its query eligibility time');
      if(decision.kind==='retryAfterAbsence'){
        if(effect.action.kind!=='createIssue'||effect.state.kind!=='uncertain'||input.facts.kind!=='available')return reject('Only uncertain issue creation admits absence retry');
        if(effect.state.received!==null)return reject('Returned identity prevents absence retry; query the exact response identity');
        const since=Math.floor(effect.state.startedAt/1000)*1000;
        if(!input.facts.scope.creations.some(query=>sameRepo(query.repo,effect.action.kind==='createIssue'?effect.action.spec.repo:query.repo)&&query.since<=since&&effect.action.kind==='createIssue'&&query.title===effect.action.spec.title&&query.body===effect.action.spec.body&&query.actor===effect.action.actor))return {ok:false,error:{kind:'sourceUnavailable',message:'Absence retry requires a fresh complete candidate query for this exact attempt',current:null}};
        const action=effect.action;const candidates=input.facts.facts.createdIssues.filter(candidate=>sameRepo(candidate.issue.repo,action.spec.repo)&&candidate.title===action.spec.title&&candidate.body===action.spec.body&&candidate.actor===action.actor);
        if(candidates.length)return reject('Creation candidates exist; explicit adoption is required');
      }
      authorizeRetry(effect,item,acceptedAt,decision.kind);allRequired(item,decision,[{kind:'effect',effectId:effect.id}]);break;
    }
    case 'adoptResult':{
      if(!effect||effect.id!==decision.effectId||effect.state.kind!=='uncertain'||input.facts.kind!=='available')return reject('Adoption requires the exact uncertain create/publish effect');
      if(effect.state.received!==null&&canonical(effect.state.received)!==canonical(decision.result))return reject('A different candidate cannot replace this attempt’s actual returned identity');
      if(effect.action.kind==='createIssue'&&decision.result.kind==='issue'){
        const action=effect.action;const candidate=input.facts.facts.createdIssues.find(candidate=>sameRef(candidate.issue,decision.result.kind==='issue'?decision.result.issue:candidate.issue));
        if(!candidate||!sameRepo(candidate.issue.repo,action.spec.repo)||candidate.title!==action.spec.title||candidate.body!==action.spec.body||candidate.actor!==action.actor||candidate.createdAt<Math.floor(effect.state.startedAt/1000)*1000)return reject('Source does not verify the selected creation candidate in this attempt window');
        if(state.units.some(unit=>unit.members.some(member=>sameRef(member.ref,candidate.issue)))||state.drafts.some(draft=>draft.id!==action.draftId&&draft.state.kind!=='proposed'&&sameRef(draft.state.kind==='placed'?draft.state.member:draft.state.issue,candidate.issue)))return reject('The selected issue identity already belongs to another member or draft');
        effect.state={kind:'confirmed',result:{kind:'created',issue:candidate.issue}};
      }else if(effect.action.kind==='publishPr'&&decision.result.kind==='pr'){
        const action=effect.action;const pr=input.facts.facts.prs.find(pr=>sameRef(pr.ref,decision.result.kind==='pr'?decision.result.pr:pr.ref));
        if(!pr||!publicationAssociation(state,effect,pr,input))return reject('Selected PR lacks the exact source branch, target, authorization or exclusive publication association');
        const member=memberOf(state,action.member);if(!member)return reject('Publication member is unavailable');
        const exact=pr.head===action.submission.payload.head&&pr.title===action.submission.payload.title&&pr.body===action.body;
        if(exact){
          effect.state={kind:'confirmed',result:{kind:'published',pr:pr.ref}};
          member.binding={kind:'registered',pr:pr.ref,headRepo:pr.headRepo,branch:pr.headBranch,origin:'published'};
        }else{
          effect.state={kind:'cancelled',reason:'sourceAlreadyAdvanced'};
          member.binding={kind:'registered',pr:pr.ref,headRepo:pr.headRepo,branch:pr.headBranch,origin:'adopted'};
          services.openWork(member,'Main explicitly associated the source-advanced publication. Preserve the accepted submission; inspect the actual current PR and submit fresh complete evidence before new gates.');
        }
      }else return reject('Result kind does not match a create action');
      item.state={kind:'resolved',result:decision};break;
    }
    case 'rebaseEdit':{
      const target=effect??state.effects.find(effect=>effect.id===decision.effectId);
      if(item.subject.kind==='stall'){
        const subject=item.subject;
        if(!subject.obligations.some(ref=>ref.kind==='effect'&&ref.id===decision.effectId||ref.kind==='amendment'&&state.amendments.some(amendment=>amendment.id===ref.id&&amendment.state.kind==='pending'&&amendment.state.requiredEffectIds.includes(decision.effectId))))return reject('Stall rebase must identify its own exact body effect obligation');
      }
      if(!target||target.id!==decision.effectId||target.state.kind!=='failed'||(target.action.kind!=='replaceBody'&&target.action.kind!=='publishPr'))return reject('Rebase requires a known failed body-writing intent');
      const action=target.action;
      if(action.kind==='replaceBody'){
        if(bodyAt(input,action.edit.issue)?.bodyHash!==decision.expectedHash)return reject('Replacement expected hash is not source current');
        action.edit={...action.edit,expectedHash:decision.expectedHash,body:decision.body};
        const amendment=state.amendments.find(amendment=>amendment.id===action.amendmentId);
        if(amendment?.state.kind==='pending')amendment.state.bodyEdits=amendment.state.bodyEdits.map(edit=>sameRef(edit.issue,action.edit.issue)?action.edit:edit);
      }
      else{const pr=action.pr&&input.facts.kind==='available'?input.facts.facts.prs.find(pr=>sameRef(pr.ref,action.pr!)):undefined;if(!pr||pr.bodyHash!==decision.expectedHash)return reject('PR expected hash is not source current');action.expectedBodyHash=decision.expectedHash;action.body=decision.body;}
      authorizeRetry(target,item,acceptedAt,'retry');allRequired(item,decision,[{kind:'effect',effectId:target.id}]);break;
    }
    case 'keepWork':{
      if(!member)return reject('Source-change response must stay in original member');const issue=bodyAt(input,member.ref);if(!issue)return reject('Source issue is unavailable');
      if(member.contract.bodyHash!==issue.bodyHash){member.contract.body=issue.body;member.contract.bodyHash=issue.bodyHash;member.contract.revision++;if(member.work)member.work.contentVersion++;}
      if(member.terminal.kind==='pending')services.openWork(member,decision.basis);item.state={kind:'resolved',result:decision};break;
    }
    case 'sourceRestored':{
      if(!member||member.baseline.kind==='none')return reject('Source restore needs an accepted baseline');
      const expected=member.baseline.kind==='adopted'?member.baseline.acceptedHead:member.baseline.submission.payload.head;
      const pr=member.binding.kind==='registered'&&input.facts.kind==='available'?input.facts.facts.prs.find(pr=>sameRef(pr.ref,member.binding.kind==='registered'?member.binding.pr:member.ref)):undefined;
      const facts=input.facts.kind==='available'?input.facts.facts:null;
      const binding=member.binding;const branch=binding.kind==='registered'?facts?.branches.find(branch=>sameRepo(branch.repo,binding.headRepo)&&branch.name===binding.branch):undefined;
      const maintenance=pr?facts?.maintenance.find(item=>sameRef(item.pr,pr.ref))?.result:undefined;
      if(expected!==decision.acceptedHead||!pr||pr.state.kind!=='open'||pr.head!==expected||canonical(pr.target)!==canonical(member.target)||binding.kind!=='registered'||pr.headBranch!==binding.branch||!sameRepo(pr.headRepo,binding.headRepo)||branch?.state.kind!=='present'||branch.state.head!==expected||bodyAt(input,member.ref)?.bodyHash!==member.contract.bodyHash||maintenance?.kind!=='maintainable')return reject('Source has not restored the exact accepted open PR, branch, target, contract and maintenance');
      services.finishWork(member,'sourceRestored',decision);item.state={kind:'resolved',result:decision};break;
    }
    case 'acceptExternalMerge':{
      const pr=input.facts.kind==='available'?input.facts.facts.prs.find(pr=>sameRef(pr.ref,decision.pr)):undefined;
      if(!member||!pr||pr.state.kind!=='merged'||canonical(pr.target)!==canonical(member.target))return reject('Source does not show an exact merge into the original member target');
      const bound=member.binding.kind==='registered'?member.binding.pr:member.binding.kind==='publishing'&&member.binding.previous.kind==='registered'?member.binding.previous.pr:null;
      const linked=input.facts.kind==='available'&&input.facts.facts.links.some(link=>sameRef(link.issue,member.ref)&&sameRef(link.pr,pr.ref));
      if(!(bound&&sameRef(bound,pr.ref))&&!linked&&!pr.closes.some(ref=>sameRef(ref,member.ref)))return reject('External merge is not related to this exact member');
      item.state={kind:'resolved',result:decision};break;
    }
    case 'retryHost':{
      if(item.subject.kind!=='hostPrecondition'||item.subject.requestId!==decision.requestId)return reject('Host retry request mismatch');
      const request=state.requests.find(request=>request.id===decision.requestId);if(!request||request.binding.kind!=='bound'||request.runId!==input.host.runId)return reject('Native holder binding is unavailable');
      const holder=input.host.seats.find(seat=>request.binding.kind==='bound'&&seat.agentId===request.binding.agentId);
      if(!holder||holder.status==='aborted'||holder.plan==='enabled'&&!holder.streaming)return reject('Native precondition has not changed');
      if(effect&&(effect.state.kind==='failed'||effect.state.kind==='uncertain')){authorizeRetry(effect,item,acceptedAt,'retryHost');allRequired(item,decision,[{kind:'effect',effectId:effect.id}]);}
      else if(effect?.state.kind==='confirmed'&&effect.action.kind==='wake'){
        const action=structuredClone(effect.action);const id=nextId(state,'effect');state.effects.push({id,scope:effect.scope,action,attempt:0,authorization:'retryHost',state:{kind:'ready',provenance:{kind:'accepted',caseId:item.id,acceptedAt,previous:{kind:'delivery',effectId:effect.id}}}});allRequired(item,decision,[{kind:'effect',effectId:id}]);
      }else return reject('No failed/unknown or confirmed-nonresponse wake is referenced');break;
    }
    default:{const exhaustive:never=decision;return exhaustive;}
  }
  return {ok:true,value:null};
}
