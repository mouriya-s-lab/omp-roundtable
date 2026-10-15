import { z, type ZodLikeSchema } from '@oh-my-pi/omptype/zod';
import * as m from './model.ts';
import {canonical,digest} from './identity.ts';
import {correctDesignAmendment} from './decisions.ts';
const object=<const S extends Readonly<Record<string,ZodLikeSchema<unknown>>>>(shape:S)=>z.object(shape).strict();

function parsed<T>(schema:ZodLikeSchema<T>,value:unknown):m.Result<T,m.ParseError> {
  const result=schema.safeParse(value);
  if(result.success) return {ok:true,value:result.data};
  const first=result.error.issues[0];
  return {ok:false,error:{path:first?.path.map(String).join('.')||'$',reason:first?.message||'Invalid input'}};
}
export const parsePortInput=(value:unknown):m.Result<m.PortInput,m.ParseError>=>parsed(m.portInputSchema,value);
export const parseToolParameters=(value:unknown):m.Result<m.ToolParameters,m.ParseError>=>parsed(m.toolParametersSchema,value);
export const parseEvent=(value:unknown):m.Result<m.Event,m.ParseError>=>parsed(m.eventSchema,value);
export const parseFacts=(value:unknown):m.Result<m.Facts,m.ParseError>=>parsed(m.factsSchema,value);
export const parseProtocolReply=(value:unknown):m.Result<m.ProtocolReply,m.ParseError>=>parsed(m.protocolReplySchema,value);
export const parseEffectResult=(value:unknown):m.Result<m.EffectResult,m.ParseError>=>parsed(m.effectResultSchema,value);
export const parsePortError=(value:unknown):m.Result<m.PortError,m.ParseError>=>parsed(m.portErrorSchema,value);
const hostSchema=object({runId:m.idSchema,main:m.callerSchema,seats:z.array(m.hostSeatSchema),turnEnds:z.array(object({agentId:m.text,runId:m.idSchema,messageId:m.text})),preflight:z.union([
  object({ok:z.literal(true),value:object({asyncEnabled:z.literal(true),isolationEnabled:z.literal(true),asyncManager:z.literal(true),gitCwd:m.text,agents:z.array(object({name:m.text,blocking:z.literal(false)}))})}),
  object({ok:z.literal(false),error:m.portErrorSchema}),
])});
const factReadSchema=z.union([
  object({kind:z.literal('available'),generation:m.ordinal,scope:m.sourceScopeSchema,observedAt:m.millisSchema,facts:m.factsSchema}),
  object({kind:z.literal('unavailable'),error:m.portErrorSchema}),
]);
const inputsSchema=object({facts:factReadSchema,host:hostSchema,policy:object({text:m.text,ownerAgent:m.text,gateAgent:m.text})});
export const parseInputs=(value:unknown):m.Result<m.Inputs,m.ParseError>=>parsed(inputsSchema,value);
function acceptedCaseReceipt(state:m.Agenda,item:m.DecisionCase,decision:m.CaseDecision):boolean {
  const receipt=item.receipt;
  return receipt!==null&&receipt.ticket===`case:${item.id}`&&receipt.revision===item.contentVersion&&receipt.digest===digest({kind:'decision',decision})&&receipt.result.ticket===receipt.ticket&&receipt.result.outcome==='accepted'&&receipt.result.acceptedVersion<=state.version;
}
export function parseAgenda(value:unknown):m.Result<m.Agenda,m.ParseError> {
  const result=parsed(m.agendaSchema,value);
  if(!result.ok) return result;
  const state=result.value;
  const fail=(path:string,reason:string):m.Result<m.Agenda,m.ParseError>=>({ok:false,error:{path,reason}});
  const allMembers=state.units.flatMap(unit=>unit.members);
  const key=(ref:m.IssueRef)=>`${ref.repo.owner}/${ref.repo.name}#${ref.number}`;
  const repoKey=(repo:m.Repo)=>`${repo.owner}/${repo.name}`;
  const memberKeys=new Set<string>();
  const ids=new Set<string>();
  const ordinals=new Set<number>();
  const register=(id:string,kind:m.DomainRef['kind']):boolean=>{
    const n=Number(id.slice(id.lastIndexOf('/')+1));
    if(ids.has(id)||ordinals.has(n)||!Number.isSafeInteger(n)||n<1||n>=state.nextId||id!==`${state.id}/${kind}/${n}`)return false;
    ids.add(id);ordinals.add(n);return true;
  };
  const unitIds=new Set(state.units.map(unit=>unit.id));
  const hasMember=(ref:m.IssueRef)=>allMembers.some(member=>key(member.ref)===key(ref));
  const hasEffect=(id:string)=>state.effects.some(effect=>effect.id===id);
  const hasCase=(id:string)=>state.cases.some(item=>item.id===id);
  const hasRequest=(id:string)=>state.requests.some(item=>item.id===id);
  const hasDraft=(id:string)=>state.drafts.some(item=>item.id===id);
  const hasAmendment=(id:string)=>state.amendments.some(item=>item.id===id);
  const hasDesign=(id:string)=>state.designWorks.some(item=>item.id===id);
  const contextValid=(context:m.Context)=>context.kind==='agenda'||(context.kind==='member'?hasMember(context.member):unitIds.has(context.unitId));
  const holdValid=(hold:m.HoldRef)=>{
    switch(hold.kind){
      case 'case':return hasCase(hold.caseId);
      case 'amendment':return hasAmendment(hold.id);
      case 'dependency':return hasMember(hold.member);
      case 'effect':return hasEffect(hold.effectId);
    }
  };
  const applyingValid=(ref:m.ApplyingRef)=>{
    switch(ref.kind){
      case 'design':return hasDesign(ref.workId);
      case 'amendment':return hasAmendment(ref.id);
      case 'draft':return hasDraft(ref.draftId);
      case 'effect':return hasEffect(ref.effectId);
    }
  };
  const gateValid=(gate:m.GateJob|null)=>gate===null||(register(gate.id,'gate')&&hasRequest(gate.requestId)&&contextValid(gate.context)&&gate.kind===gate.stamp.kind&&(gate.status.kind!=='answered'||gate.receipt!==null));
  for(const [index,unit]of state.units.entries()){
    if(!register(unit.id,'unit'))return fail(`units.${index}.id`,'Duplicate or invalid allocated identity');
    if(!gateValid(unit.postMerge))return fail(`units.${index}.postMerge`,'Invalid gate reference or receipt');
    for(const [j,member]of unit.members.entries()){
      const path=`units.${index}.members.${j}`;
      if(memberKeys.has(key(member.ref)))return fail(path,'Duplicate agenda member');
      memberKeys.add(key(member.ref));
      if(member.ownerRequestId!==null&&!hasRequest(member.ownerRequestId))return fail(path,'Missing owner request');
      if(!gateValid(member.review)||!gateValid(member.accept))return fail(path,'Invalid member gate');
      if(member.work){
        if(!register(member.work.id,'work')||key(member.work.member)!==key(member.ref))return fail(`${path}.work`,'Work identity/member mismatch');
        if(member.work.holds.some(hold=>!holdValid(hold)||(hold.kind==='dependency'&&key(hold.member)===key(member.ref))))return fail(`${path}.work.holds`,'Missing or self dependency');
        const blocks=state.cases.filter(item=>item.context.kind==='member'&&key(item.context.member)===key(member.ref)&&(item.state.kind==='open'||item.state.kind==='applying'||item.state.kind==='awaitingExternal'));
        for(const item of blocks){
          if(item.subject.kind==='hostPrecondition'||item.subject.kind==='effectFailure')continue;
          if(!member.work.holds.some(hold=>hold.kind==='case'&&hold.caseId===item.id))return fail(`${path}.work.holds`,'Missing dependency on open member case');
        }
        for(const amendment of state.amendments){
          if(amendment.state.kind==='pending'&&amendment.affected.some(ref=>key(ref)===key(member.ref))&&!member.work.holds.some(hold=>hold.kind==='amendment'&&hold.id===amendment.id))return fail(`${path}.work.holds`,'Missing amendment dependency');
        }
      }
      for(const requirement of member.contract.requirements){
        if(repoKey(requirement.commit.repo)!==repoKey(member.target.repo))return fail(`${path}.contract.requirements`,'Cross-repository design obligation');
        if(!hasCase(requirement.caseId))return fail(path,'Missing design case');
        if(requirement.carrier.kind==='member'&&!hasMember(requirement.carrier.member))return fail(path,'Missing design member carrier');
        if(requirement.carrier.kind==='draft'&&!hasDraft(requirement.carrier.draftId))return fail(path,'Missing design draft carrier');
      }
      if(member.binding.kind==='publishing'){
        const binding=member.binding;const effect=state.effects.find(effect=>effect.id===binding.effectId);
        if(!effect||effect.action.kind!=='publishPr'||key(effect.action.member)!==key(member.ref)||effect.state.kind==='confirmed'||effect.state.kind==='cancelled'||member.baseline.kind!=='submitted'||canonical(member.baseline.submission)!==canonical(effect.action.submission))return fail(`${path}.binding`,'Publishing binding must own the exact active publication and accepted submission');
        if(binding.previous.kind==='registered'&&(effect.action.pr===null||key(binding.previous.pr)!==key(effect.action.pr)||repoKey(binding.previous.headRepo)!==repoKey(effect.action.headRepo)||binding.previous.branch!==effect.action.submission.payload.branch))return fail(`${path}.binding.previous`,'Previous binding must identify the exact displaced publication association');
        if(binding.previous.kind==='none'&&effect.action.pr!==null)return fail(`${path}.binding.previous`,'Existing-PR publication requires its exact prior binding');
      }
    }
  }
  if(!gateValid(state.closure))return fail('closure','Invalid closure gate');
  for(const item of state.cases){
    if(!register(item.id,'case')||!contextValid(item.context))return fail('cases','Invalid identity/context');
    if(item.state.kind==='applying'&&item.state.required.some(ref=>!applyingValid(ref)))return fail('cases','Missing direct applying child');
    if(item.state.kind==='awaitingExternal'&&item.state.wait.kind==='effect'&&!hasEffect(item.state.wait.effectId))return fail('cases','Missing waiting effect');
    if(item.subject.kind==='effectFailure'&&!hasEffect(item.subject.effectId))return fail('cases','Missing failed effect');
    if(item.subject.kind==='hostPrecondition'&&(!hasRequest(item.subject.requestId)||(item.subject.effectId!==null&&!hasEffect(item.subject.effectId))))return fail('cases','Missing host request/effect');
    const subject=item.subject;
    const allocatedWork=(id:string)=>id.startsWith(`${state.id}/work/`)&&Number.isSafeInteger(Number(id.slice(id.lastIndexOf('/')+1)))&&Number(id.slice(id.lastIndexOf('/')+1))>0&&Number(id.slice(id.lastIndexOf('/')+1))<state.nextId;
    if(subject.kind==='checks'){
      const member=allMembers.find(member=>key(member.ref)===key(subject.member));
      if(!member||!allocatedWork(subject.responseWorkId))return fail('cases.subject.responseWorkId','Checks must refer to an allocated accepted owner obligation');
      if(item.state.kind!=='resolved'&&item.state.kind!=='cancelled'&&(member.baseline.kind!=='submitted'||member.baseline.submission.workId!==subject.responseWorkId))return fail('cases.subject.responseWorkId','Current checks case must belong to the exact accepted owner submission');
    }
    if(subject.kind==='unexpectedSourceChange'){
      const member=allMembers.find(member=>key(member.ref)===key(subject.member));if(!member)return fail('cases.subject.member','Source case member is missing');
      const cause=subject.cause;
      if('contractRevision'in cause&&cause.contractRevision>member.contract.revision)return fail('cases.subject.cause','Source deviation cannot originate from a future owned contract');
      if('binding'in cause){
        if(cause.baseline.kind==='submitted'&&!allocatedWork(cause.baseline.workId)||cause.phase.kind!=='none'&&!allocatedWork(cause.phase.workId))return fail('cases.subject.cause','Source occurrence must reference allocated member work identities');
      }
    }
  }
  for(const work of state.designWorks){
    if(!register(work.id,'work')||!hasCase(work.parentCaseId)||work.holds.some(hold=>!holdValid(hold)||(hold.kind==='case'&&hold.caseId===work.parentCaseId)))return fail('designWorks','Missing reference or parent-case cycle');
    for(const hold of work.holds){
      if(hold.kind==='amendment'&&state.amendments.some(amendment=>amendment.id===hold.id&&amendment.state.kind==='pending'&&amendment.state.designWork===work.id))return fail('designWorks','Design/amendment dependency cycle');
    }
  }
  for(const draft of state.drafts){
    if(!register(draft.id,'draft')||!hasCase(draft.caseId)||!hasEffect(draft.creationEffectId)||draft.attachmentEffectIds.some(id=>!hasEffect(id)))return fail('drafts','Missing draft dependency');
    if(repoKey(draft.spec.repo)!==repoKey(draft.spec.target.repo))return fail('drafts','Draft target repository mismatch');
    if(draft.position.kind!=='outsideAgenda'&&!unitIds.has(draft.position.unitId))return fail('drafts','Missing position anchor');
    if(draft.state.kind==='placed'&&!hasMember(draft.state.member))return fail('drafts','Missing placed member');
  }
  for(const amendment of state.amendments){
    if(!register(amendment.id,'amendment')||!hasCase(amendment.caseId)||amendment.affected.some(ref=>!hasMember(ref)&&!(state.parent&&key(state.parent)===key(ref))))return fail('amendments','Missing affected subject');
    const parent=state.cases.find(item=>item.id===amendment.caseId);
    if(amendment.state.kind==='pending'){
      const pending=amendment.state;
      if(!parent||parent.state.kind!=='applying'||parent.state.required.length!==1||!parent.state.required.some(ref=>ref.kind==='amendment'&&ref.id===amendment.id)||!acceptedCaseReceipt(state,parent,parent.state.decision))return fail('amendments','Pending amendment lacks its exact accepted parent intent');
      const decision=parent.state.decision;
      if(decision.kind!=='amend'&&decision.kind!=='split'&&decision.kind!=='correctDesign')return fail('amendments','Parent decision is not a contract or design amendment');
      const correction=decision.kind==='correctDesign'?correctDesignAmendment(state,parent,decision):null;
      if(correction&&!correction.ok)return fail('amendments',correction.error.message);
      const proposal=decision.kind==='amend'?decision.amendment:correction?.ok?correction.value:null;
      const affected=proposal?.affected??(parent.context.kind==='member'?[parent.context.member]:[]);
      const edits=decision.kind==='split'?[decision.bodyEdit]:proposal?.bodyEdits??[];
      const transfers=decision.kind==='split'?decision.insertions:decision.kind==='correctDesign'?[decision.insertion]:proposal?.kind==='acceptanceMethod'?[proposal.transfer]:[];
      if(canonical(affected)!==canonical(amendment.affected)||pending.insertions.length!==transfers.length)return fail('amendments','Amendment obligations differ from the accepted decision');
      for(const [index,ref]of pending.insertions.entries()){
        const transfer=transfers[index];
        if(ref.kind==='existing'){
          if(hasMember(ref.entry.issue)||ref.position.kind==='outsideAgenda'||!unitIds.has(ref.position.unitId)||canonical(ref)!==canonical(transfer))return fail('amendments','Invalid or reordered existing insertion intent');
        }else{
          const draft=state.drafts.find(draft=>draft.id===ref.draftId);
          if(!draft||draft.caseId!==parent.id||transfer?.kind!=='draft'||canonical(draft.spec)!==canonical(transfer.draft)||canonical(draft.position)!==canonical(transfer.position))return fail('amendments','Missing, reordered or unrelated draft obligation');
        }
      }
      if(pending.designWork!==null){
        const work=state.designWorks.find(work=>work.id===pending.designWork);
        if(!work||proposal?.kind!=='designGap'||work.parentCaseId!==parent.id||canonical(work.affected)!==canonical(affected)||canonical(work.route)!==canonical(proposal.route))return fail('amendments','Design work is not owned by the accepted amendment');
        if(decision.kind==='correctDesign'&&canonical(work.clauses)!==canonical(decision.clauses))return fail('amendments','Design correction clauses differ from the accepted Main work');
      }else if(proposal?.kind==='designGap')return fail('amendments','Design amendment is missing its work');
      if(pending.bodyEdits.length!==edits.length||pending.requiredEffectIds.some(id=>!hasEffect(id)))return fail('amendments','Missing direct effect or body obligation');
      for(const edit of pending.bodyEdits){
        const bodyEffects=state.effects.filter(effect=>pending.requiredEffectIds.includes(effect.id)&&effect.action.kind==='replaceBody'&&effect.action.amendmentId===amendment.id&&canonical(effect.action.edit)===canonical(edit));
        if(bodyEffects.length!==1)return fail('amendments','Body obligation lacks its exact single effect');
        if(!edits.some(original=>canonical(original)===canonical(edit))){
          const effect=bodyEffects[0]!;
          const rebased=state.cases.some(item=>{
            const result=item.state.kind==='applying'?item.state.decision:item.state.kind==='resolved'?item.state.result:null;
            return result?.kind==='rebaseEdit'&&result.effectId===effect.id&&result.expectedHash===edit.expectedHash&&result.body===edit.body&&acceptedCaseReceipt(state,item,result);
          });
          if(!rebased)return fail('amendments','Body target changed without an accepted exact rebase');
        }
      }
      for(const id of pending.requiredEffectIds){
        const effect=state.effects.find(effect=>effect.id===id)!;const action=effect.action;
        if(action.kind==='replaceBody'&&action.amendmentId===amendment.id)continue;
        if(action.kind==='attachChild'&&action.owner.kind==='insertion'&&action.owner.caseId===parent.id&&transfers.some(transfer=>canonical(transfer)===canonical(action.owner.kind==='insertion'?action.owner.insertion:null)))continue;
        return fail('amendments','Unrelated effect used as an amendment prerequisite');
      }
    }
    if(parent?.state.kind==='resolved'&&parent.state.result.kind==='correctDesign'){
      const decision=parent.state.result;
      if(amendment.state.kind!=='effective'||!acceptedCaseReceipt(state,parent,decision))return fail('amendments','Completed design correction lacks its accepted effective intent');
      const work=state.designWorks.find(work=>work.parentCaseId===parent.id);
      if(!work?.result||work.route.kind!=='defaultFirst')return fail('amendments','Completed design correction lacks its source-accepted default design');
      const inserted=decision.insertion;
      const destination=inserted.kind==='existing'?inserted.entry.issue:state.drafts.find(draft=>draft.caseId===parent.id&&canonical(draft.spec)===canonical(inserted.draft)&&canonical(draft.position)===canonical(inserted.position)&&draft.state.kind==='placed')?.state;
      const ref=destination&&'repo'in destination?destination:destination&&'kind'in destination&&destination.kind==='placed'?destination.member:null;
      if(!ref||!hasMember(ref))return fail('amendments','Effective design correction has no actual placed member');
      if(parent.context.kind==='member'&&key(parent.context.member)===key(ref))return fail('amendments','Design correction cannot reopen the original terminal member');
      const carriers=allMembers.flatMap(member=>member.contract.requirements.filter(requirement=>requirement.caseId===parent.id&&canonical(requirement.commit)===canonical(work.result)).map(requirement=>({member,requirement})));
      if(carriers.length!==1||key(carriers[0]!.member.ref)!==key(ref)||carriers[0]!.requirement.carrier.kind!=='member'||key(carriers[0]!.requirement.carrier.member)!==key(ref))return fail('amendments','Design correction must have exactly one new member carrier');
    }
  }
  for(const effect of state.effects){
    if(!register(effect.id,'effect')||!contextValid(effect.scope))return fail('effects','Invalid identity/scope');
    if((effect.state.kind==='executing'||effect.state.kind==='failed'||effect.state.kind==='uncertain')&&effect.attempt!==effect.state.attempt)return fail('effects','Attempt mismatch');
    const responseValid=(received:m.CreatedResult|null)=>received===null||(effect.action.kind==='createIssue'?received.kind==='issue'&&repoKey(received.issue.repo)===repoKey(effect.action.spec.repo):effect.action.kind==='publishPr'?received.kind==='pr'&&repoKey(received.pr.repo)===repoKey(effect.action.target.repo):false);
    if(effect.state.kind==='ready'){
      const provenance=effect.state.provenance;
      if(provenance.kind==='initial'){
        if(effect.authorization!=='initial'||effect.attempt!==0)return fail('effects','Initial ready intent cannot carry retry authorization or an attempt');
      }else{
        const parent=state.cases.find(item=>item.id===provenance.caseId);
        if(!parent||effect.authorization==='initial'||parent.state.kind!=='applying'||!parent.state.required.some(ref=>ref.kind==='effect'&&ref.effectId===effect.id))return fail('effects','Retry authorization requires its exact applying case');
        const decision=parent.state.decision;
        const authorized=effect.authorization==='retry'?(decision.kind==='retry'||decision.kind==='rebaseEdit')&&decision.effectId===effect.id:effect.authorization==='retryAfterAbsence'?decision.kind==='retryAfterAbsence'&&decision.effectId===effect.id:decision.kind==='retryHost'&&effect.action.kind==='wake'&&decision.requestId===effect.action.requestId;
        if(!authorized||!acceptedCaseReceipt(state,parent,decision))return fail('effects','Retry case does not contain the matching accepted receipt');
        const previous=provenance.previous;
        if(previous.kind==='delivery'){
          const prior=state.effects.find(item=>item.id===previous.effectId);
          if(effect.authorization!=='retryHost'||effect.action.kind!=='wake'||prior?.state.kind!=='confirmed'||prior.action.kind!=='wake'||prior.state.result.kind!=='delivered'||effect.attempt!==0)return fail('effects','New delivery retry requires an actual confirmed wake receipt');
        }else{
          if(previous.kind==='call'&&(effect.attempt<1||provenance.acceptedAt<previous.startedAt||!responseValid(previous.received)))return fail('effects','Invalid previous call provenance');
          if(effect.authorization==='retryAfterAbsence'&&(previous.kind!=='call'||previous.received!==null))return fail('effects','Absence retry cannot retain an actual returned identity');
          if(previous.kind==='preflight'&&(effect.attempt!==0||effect.action.kind!=='publishPr'&&effect.action.kind!=='replaceBody'))return fail('effects','Invalid previous preflight conflict');
          if(effect.authorization==='retryAfterAbsence'&&effect.action.kind!=='createIssue'||effect.authorization==='retryHost'&&effect.action.kind!=='wake')return fail('effects','Retry authorization/action mismatch');
        }
      }
    }
    if(effect.state.kind==='failed'||effect.state.kind==='uncertain'){
      const received=effect.state.received;
      if(effect.state.kind==='failed'&&received!==null)return fail('effects','A known failed call cannot also return a created identity');
      if(!responseValid(received))return fail('effects','Response identity/action mismatch');
      if(effect.state.kind==='failed'&&effect.state.provenance.kind==='preflight'&&(effect.state.error.kind!=='precondition'||effect.action.kind!=='publishPr'&&effect.action.kind!=='replaceBody'))return fail('effects','Only body preflight conflicts may be unstarted failures');
    }
    if(effect.action.kind==='wake'&&!hasRequest(effect.action.requestId))return fail('effects','Missing wake request');
    if(effect.action.kind==='createIssue'&&!hasDraft(effect.action.draftId))return fail('effects','Missing created draft');
    if(effect.action.kind==='attachChild'){
      const owner=effect.action.owner;
      if(owner.kind==='draft'&&!hasDraft(owner.draftId))return fail('effects','Missing attached draft');
      if(owner.kind==='insertion'&&(!hasCase(owner.caseId)||key(owner.insertion.entry.issue)!==key(effect.action.child)||!state.parent||key(state.parent)!==key(effect.action.parent)))return fail('effects','Attachment does not own this exact insertion/parent');
    }
    if(effect.action.kind==='replaceBody'&&!hasAmendment(effect.action.amendmentId))return fail('effects','Missing body amendment');
  }
  for(const request of state.requests){if(!register(request.id,'request')||!contextValid(request.context))return fail('requests','Invalid request identity/context');}
  if(state.report&&!register(state.report.id,'work'))return fail('report','Invalid report identity');
  if(state.lifecycle==='completed'){
    const unfinishedUnit=state.units.some(unit=>unit.postMerge?.status.kind!=='answered'||!unit.postMerge.status.ok||unit.members.some(member=>member.work!==null||member.terminal.kind==='pending'));
    const unfinishedEffect=state.effects.some(effect=>effect.state.kind!=='confirmed'&&effect.state.kind!=='cancelled');
    const unfinishedCase=state.cases.some(item=>item.state.kind!=='resolved'&&item.state.kind!=='cancelled');
    if(state.report?.state.kind!=='reported'||unfinishedUnit||unfinishedEffect||unfinishedCase)return fail('lifecycle','Completed agenda contains unfinished obligations');
  }
  return result;
}
