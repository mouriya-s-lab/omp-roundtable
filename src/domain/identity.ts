import {createHash} from 'node:crypto';
import type {Agenda,Context,DomainRef,Effect,Facts,GateJob,HoldRef,Inputs,IssueRef,Member,MemberStamp,OwnerWork,PrSnapshot,Repo,ShaRef,Unit,VerifyRepo,WorkAvailability} from './model.ts';

export function canonical(value:unknown):string {
  if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}
export function digest(value:unknown):string{return createHash('sha256').update(canonical(value)).digest('hex');}
export function bodyHash(body:string):string{return createHash('sha256').update(body).digest('hex');}
export function repoKey(repo:Repo):string{return `${repo.owner}/${repo.name}`;}
export function refKey(ref:IssueRef):string{return `${repoKey(ref.repo)}#${ref.number}`;}
export function sameRef(a:IssueRef,b:IssueRef):boolean{return refKey(a)===refKey(b);}
export function sameRepo(a:Repo,b:Repo):boolean{return repoKey(a)===repoKey(b);}
export function exactClosingBody(body:string,member:IssueRef,defaultRepo:Repo):boolean {
  const matches=[...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)|(?:([\w.-]+)\/([\w.-]+))?#(\d+))/gi)];
  const match=matches[0];if(matches.length!==1||!match)return false;
  const repo=match[1]&&match[2]?`${match[1]}/${match[2]}`:match[4]&&match[5]?`${match[4]}/${match[5]}`:repoKey(defaultRepo);
  return repo.toLowerCase()===repoKey(member.repo).toLowerCase()&&Number(match[3]??match[6])===member.number;
}
export function memberOf(state:Agenda,ref:IssueRef):Member|undefined{return state.units.flatMap(unit=>unit.members).find(member=>sameRef(member.ref,ref));}
export function unitOf(state:Agenda,ref:IssueRef):Unit|undefined{return state.units.find(unit=>unit.members.some(member=>sameRef(member.ref,ref)));}
export function gateOf(state:Agenda,id:string):GateJob|undefined{return [...state.units.flatMap(unit=>[unit.postMerge,...unit.members.flatMap(member=>[member.review,member.accept])]),state.closure].find((gate):gate is GateJob=>gate!==null&&gate.id===id);}

/** Select the same exact source merge before classification and when planning reads. */
export function sourceMergedPr(member:Member,facts:Facts):PrSnapshot|undefined {
  const binding=member.binding.kind==='registered'?member.binding:member.binding.kind==='publishing'&&member.binding.previous.kind==='registered'?member.binding.previous:null;
  const exact=binding?facts.prs.find(pr=>sameRef(pr.ref,binding.pr)):undefined;
  const linked=facts.links.filter(link=>sameRef(link.issue,member.ref)).flatMap(link=>{
    const pr=facts.prs.find(pr=>sameRef(pr.ref,link.pr));return pr?[pr]:[];
  });
  return [...(exact?[exact]:[]),...linked,...facts.prs.filter(pr=>pr.closes.some(ref=>sameRef(ref,member.ref)))].find(pr=>pr.state.kind==='merged'&&canonical(pr.target)===canonical(member.target));
}

/** Verification commits are shared by the source reader and the transition engine. */
export function verificationTargets(state:Agenda,unit:Unit,facts:Facts,prior:GateJob|null):VerifyRepo[]|null {
  const merges=unit.members.flatMap(member=>{
    const pr=sourceMergedPr(member,facts);
    const terminal=pr?.state.kind==='merged'?{repo:pr.target.repo,sha:pr.state.sha,at:pr.state.at}:member.terminal.kind==='merged'?{...member.terminal.merge,at:member.terminal.at}:null;
    return terminal?[terminal]:[];
  });
  const result:VerifyRepo[]=[];
  for(const merge of merges){
    let target=result.find(item=>sameRepo(item.repo,merge.repo));
    if(!target){
      const repo=facts.repos.find(item=>sameRepo(item.repo,merge.repo));if(!repo)return null;
      const latest=merges.filter(item=>sameRepo(item.repo,merge.repo)).reduce((best,item)=>item.at>best.at?item:best,merge);
      const previous=prior?.stamp.kind==='postMerge'?prior.stamp.repos.find(item=>sameRepo(item.repo,merge.repo)):undefined;
      target={repo:merge.repo,commit:latest.at>=state.convenedAt?latest.sha:previous?.commit??repo.defaultHead,merges:[]};
      result.push(target);
    }
    target.merges.push(merge.sha);
  }
  for(const member of unit.members)for(const requirement of member.contract.requirements){
    if(result.some(item=>sameRepo(item.repo,requirement.commit.repo)))continue;
    const repo=facts.repos.find(item=>sameRepo(item.repo,requirement.commit.repo));if(!repo)return null;
    result.push({repo:repo.repo,commit:repo.defaultHead,merges:[]});
  }
  return result;
}

export type VerificationPair={ancestor:ShaRef;descendant:ShaRef};
export function verificationContinuity(state:Agenda,unit:Unit,targets:readonly VerifyRepo[],facts:Facts):VerificationPair[] {
  return targets.flatMap(target=>{
    const recent=unit.members.some(member=>{
      const pr=sourceMergedPr(member,facts);
      return pr?.state.kind==='merged'?sameRepo(pr.target.repo,target.repo)&&pr.state.at>=state.convenedAt:member.terminal.kind==='merged'&&sameRepo(member.terminal.merge.repo,target.repo)&&member.terminal.at>=state.convenedAt;
    });
    const repo=facts.repos.find(repo=>sameRepo(repo.repo,target.repo));
    return !recent&&repo?[{ancestor:{repo:target.repo,sha:target.commit},descendant:{repo:repo.repo,sha:repo.defaultHead}}]:[];
  });
}
export function publicationAssociation(state:Agenda,effect:Effect,pr:PrSnapshot,input:Inputs):boolean {
  const action=effect.action;if(action.kind!=='publishPr'||input.facts.kind!=='available')return false;
  const facts=input.facts.facts;const member=memberOf(state,action.member);
  if(!member||member.terminal.kind!=='pending'||member.binding.kind!=='publishing'||member.binding.effectId!==effect.id||pr.state.kind!=='open'||!sameRepo(pr.headRepo,action.headRepo)||pr.headBranch!==action.submission.payload.branch||canonical(pr.target)!==canonical(action.target)||action.pr!==null&&!sameRef(action.pr,pr.ref))return false;
  if(effect.state.kind==='uncertain'&&effect.state.received!==null&&(effect.state.received.kind!=='pr'||!sameRef(effect.state.received.pr,pr.ref)))return false;
  const branch=facts.branches.find(branch=>sameRepo(branch.repo,pr.headRepo)&&branch.name===pr.headBranch);
  if(branch?.state.kind!=='present'||branch.state.head!==pr.head)return false;
  const maintenance=facts.maintenance.find(item=>sameRef(item.pr,pr.ref))?.result;
  if(maintenance?.kind!=='maintainable'||!sameRepo(maintenance.basis.headRepo,pr.headRepo)||maintenance.basis.headBranch!==pr.headBranch)return false;
  const basis=maintenance.basis;const authorization=basis.authorization;
  switch(authorization.kind){
    case 'none':return false;
    case 'actorIsAuthor':if(authorization.actor.toLowerCase()!==facts.viewer.toLowerCase()||basis.author.toLowerCase()!==facts.viewer.toLowerCase())return false;break;
    case 'authorAuthorized':break;
    case 'systemCreated':
      if(authorization.effectId!==effect.id&&!state.effects.some(previous=>previous.id===authorization.effectId&&previous.action.kind==='publishPr'&&sameRef(previous.action.member,action.member)&&previous.state.kind==='confirmed'&&previous.state.result.kind==='published'&&sameRef(previous.state.result.pr,pr.ref)))return false;
      break;
    default:{const exhaustive:never=authorization;return exhaustive;}
  }
  for(const unit of state.units)for(const other of unit.members){
    if(sameRef(other.ref,member.ref))continue;
    const binding=other.binding.kind==='publishing'?other.binding.previous:other.binding;
    if(binding.kind==='registered'&&(sameRef(binding.pr,pr.ref)||sameRepo(binding.headRepo,pr.headRepo)&&binding.branch===pr.headBranch&&canonical(other.target)===canonical(pr.target)))return false;
  }
  return !state.effects.some(other=>other.id!==effect.id&&other.action.kind==='publishPr'&&!sameRef(other.action.member,member.ref)&&other.state.kind!=='confirmed'&&other.state.kind!=='cancelled'&&(other.action.pr!==null&&sameRef(other.action.pr,pr.ref)||sameRepo(other.action.headRepo,pr.headRepo)&&other.action.submission.payload.branch===pr.headBranch&&canonical(other.action.target)===canonical(pr.target)));
}
export function nextId(state:Agenda,kind:string):string {const id=`${state.id}/${kind}/${state.nextId}`;state.nextId++;return id;}
export function domainObjects(state:Agenda):DomainRef[] {
  const objects:DomainRef[]=[];
  for(const unit of state.units){
    objects.push({kind:'unit',id:unit.id});
    for(const member of unit.members){
      if(member.work)objects.push({kind:'work',id:member.work.id});
      for(const gate of [member.review,member.accept])if(gate)objects.push({kind:'gate',id:gate.id});
    }
    if(unit.postMerge)objects.push({kind:'gate',id:unit.postMerge.id});
  }
  if(state.closure)objects.push({kind:'gate',id:state.closure.id});
  if(state.report)objects.push({kind:'work',id:state.report.id});
  objects.push(...state.cases.map(item=>({kind:'case' as const,id:item.id})),...state.designWorks.map(item=>({kind:'work' as const,id:item.id})),...state.drafts.map(item=>({kind:'draft' as const,id:item.id})),...state.amendments.map(item=>({kind:'amendment' as const,id:item.id})),...state.effects.map(item=>({kind:'effect' as const,id:item.id})),...state.requests.map(item=>({kind:'request' as const,id:item.id})));
  return objects.sort((a,b)=>Number(a.id.slice(a.id.lastIndexOf('/')+1))-Number(b.id.slice(b.id.lastIndexOf('/')+1)));
}
export function caseOpen(state:Agenda,context:Context):boolean {
  return state.cases.some(item=>{
    if(canonical(item.context)!==canonical(context)||item.state.kind==='resolved'||item.state.kind==='cancelled')return false;
    // An accepted host recovery waits on its own delivery, not the reverse.
    const subject=item.subject;
    return !(subject.kind==='hostPrecondition'&&item.state.kind==='applying'&&item.state.required.every(ref=>ref.kind==='effect'&&state.effects.some(effect=>effect.id===ref.effectId&&effect.action.kind==='wake'&&effect.action.requestId===subject.requestId)));
  });
}
export function effectOpen(state:Agenda,context:Context):boolean{return state.effects.some(item=>canonical(item.scope)===canonical(context)&&item.action.kind!=='wake'&&item.state.kind!=='confirmed'&&item.state.kind!=='cancelled');}
export function contains(input:Inputs,commit:ShaRef,descendant:string):boolean {
  if(input.facts.kind!=='available')return false;
  return commit.sha===descendant||input.facts.facts.commits.some(item=>sameRepo(item.repo,commit.repo)&&item.ancestor===commit.sha&&item.descendant===descendant&&item.result==='contains');
}
export function headContains(input:Inputs,commit:ShaRef,head:ShaRef):boolean {
  if(sameRepo(commit.repo,head.repo))return contains(input,commit,head.sha);
  return input.facts.kind==='available'&&input.facts.facts.commits.some(item=>sameRepo(item.repo,commit.repo)&&item.ancestor===commit.sha&&item.descendant===head.sha&&item.result==='contains');
}
export function memberEnded(state:Agenda,member:Member,input:Inputs):boolean {
  if(member.terminal.kind==='pending'||member.work!==null||caseOpen(state,{kind:'member',member:member.ref})||effectOpen(state,{kind:'member',member:member.ref}))return false;
  if(input.facts.kind!=='available')return false;
  const source=input.facts.facts.issues.find(issue=>sameRef(issue.ref,member.ref));
  return source?.state==='closed'&&(member.terminal.kind!=='noCode'||source.bodyHash===member.terminal.bodyHash);
}
export function memberStamp(member:Member):MemberStamp {
  return {member:member.ref,bodyHash:member.contract.bodyHash,contractRevision:member.contract.revision,required:member.contract.requirements.map(item=>item.commit)};
}
export function unitEnded(state:Agenda,unit:Unit,input:Inputs):boolean {
  const gate=unit.postMerge;
  if(input.facts.kind!=='available'||gate?.stamp.kind==='postMerge'&&!verificationContinuity(state,unit,gate.stamp.repos,input.facts.facts).every(pair=>contains(input,pair.ancestor,pair.descendant.sha)))return false;
  return unit.members.every(member=>memberEnded(state,member,input))&&gate?.status.kind==='answered'&&gate.status.ok&&gate.stamp.kind==='postMerge'&&canonical(gate.stamp.members)===canonical(unit.members.map(member=>({member:memberStamp(member),terminal:member.terminal})))&&!caseOpen(state,{kind:'unit',unitId:unit.id})&&!effectOpen(state,{kind:'unit',unitId:unit.id});
}
export function holdUnmet(state:Agenda,hold:HoldRef,input:Inputs):boolean {
  switch(hold.kind){
    case 'case':{const item=state.cases.find(item=>item.id===hold.caseId);return !item||item.state.kind!=='resolved'&&item.state.kind!=='cancelled';}
    case 'amendment':return state.amendments.find(item=>item.id===hold.id)?.state.kind!=='effective';
    case 'effect':{const effect=state.effects.find(effect=>effect.id===hold.effectId);return !effect||effect.state.kind!=='confirmed'&&effect.state.kind!=='cancelled';}
    case 'dependency':{const member=memberOf(state,hold.member);return !member||!memberEnded(state,member,input);}
  }
}
export function availability(state:Agenda,work:Pick<OwnerWork,'holds'>,input:Inputs):WorkAvailability {
  const holds=work.holds.filter(hold=>holdUnmet(state,hold,input));
  const first=holds[0];
  return first?{kind:'held',holds:[first,...holds.slice(1)]}:{kind:'runnable'};
}
