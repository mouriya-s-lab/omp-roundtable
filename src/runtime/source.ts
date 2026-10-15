import type {Agenda,CaseDecision,CreatedResult,DraftSpec,Effect,Entry,FactRead,Facts,GateStamp,Insertion,IssueRef,PortInput,Repo,ShaRef,SourceCondition,SourceScope,Target} from '../domain/model.ts';
import {sameRef,sameRepo,sourceMergedPr,verificationContinuity,verificationTargets} from '../domain/identity.ts';
import type {GitHubPort} from '../ports/contracts.ts';

export type EffectReceipt={effectId:string;result:CreatedResult};
export interface SourceReader {
  read(state:Agenda|null,operation:PortInput|null,cause:string,receipt?:EffectReceipt):Promise<FactRead>;
}

/** A read plan is an index of source objects, never an observation of their state. */
class ReadPlan {
  readonly scope:SourceScope={issues:[],prs:[],repos:[],branches:[],commits:[],checkRuns:[],creations:[],maintenanceIntents:[]};
  repo(repo:Repo):void {if(!this.scope.repos.some(item=>sameRepo(item.repo,repo)))this.scope.repos.push({repo,bases:[]});}
  target(target:Target):void {this.repo(target.repo);const item=this.scope.repos.find(item=>sameRepo(item.repo,target.repo));if(item&&!item.bases.includes(target.base))item.bases.push(target.base);}
  issue(ref:IssueRef):void {this.repo(ref.repo);if(!this.scope.issues.some(item=>sameRef(item,ref)))this.scope.issues.push(ref);}
  pr(ref:IssueRef):void {this.repo(ref.repo);if(!this.scope.prs.some(item=>sameRef(item,ref)))this.scope.prs.push(ref);}
  branch(repo:Repo,name:string):void {this.repo(repo);if(!this.scope.branches.some(item=>sameRepo(item.repo,repo)&&item.name===name))this.scope.branches.push({repo,name});}
  pair(ancestor:ShaRef,descendant:string):void {this.repo(ancestor.repo);if(!this.scope.commits.some(item=>sameRepo(item.repo,ancestor.repo)&&item.ancestor===ancestor.sha&&item.descendant===descendant))this.scope.commits.push({repo:ancestor.repo,ancestor:ancestor.sha,descendant});}
  run(repo:Repo,runId:number):void {this.repo(repo);if(!this.scope.checkRuns.some(item=>sameRepo(item.repo,repo)&&item.runId===runId))this.scope.checkRuns.push({repo,runId});}
  draft(draft:DraftSpec):void {this.repo(draft.repo);this.target(draft.target);}
  entry(entry:Entry):void {this.issue(entry.issue);this.target(entry.target);if(entry.adoptPr)this.pr(entry.adoptPr);}
  insertion(insertion:Insertion):void {if(insertion.kind==='existing')this.entry(insertion.entry);else this.draft(insertion.draft);}
  condition(condition:SourceCondition):void {
    switch(condition.kind){
      case 'checksSettled':this.pr(condition.pr);this.run(condition.pr.repo,condition.runId);break;
      case 'bodyChanged':case 'issueState':this.issue(condition.issue);break;
      case 'commitLanded':this.repo(condition.commit.repo);break;
      case 'prChanged':this.pr(condition.pr);break;
      case 'mainRelease':break;
    }
  }
  stamp(stamp:GateStamp):void {
    switch(stamp.kind){
      case 'review':case 'accept':this.pr(stamp.pr);this.issue(stamp.member.member);this.target(stamp.target);break;
      case 'postMerge':for(const item of stamp.members)this.issue(item.member.member);for(const repo of stamp.repos)for(const sha of repo.merges)this.pair({repo:repo.repo,sha},repo.commit);break;
      case 'closure':this.issue(stamp.parent);for(const child of stamp.children)this.issue(child.issue);for(const repo of stamp.repos)for(const sha of repo.merges)this.pair({repo:repo.repo,sha},repo.commit);break;
    }
  }
  decision(decision:CaseDecision):void {
    switch(decision.kind){
      case 'amend':{
        const proposal=decision.amendment;for(const ref of proposal.affected)this.issue(ref);for(const edit of proposal.bodyEdits)this.issue(edit.issue);
        if(proposal.kind==='acceptanceMethod')this.insertion(proposal.transfer);
        else switch(proposal.route.kind){case 'defaultFirst':this.repo(proposal.route.repo);break;case 'withPr':this.issue(proposal.route.member);break;case 'future':if('number'in proposal.route.carrier)this.issue(proposal.route.carrier);else this.draft(proposal.route.carrier);break;}
        break;
      }
      case 'confirmNoCode':if(decision.issue)this.issue(decision.issue);break;
      case 'split':this.issue(decision.bodyEdit.issue);for(const insertion of decision.insertions)this.insertion(insertion);break;
      case 'replacePr':case 'acceptExternalMerge':this.pr(decision.pr);break;
      case 'waitExternal':this.condition(decision.condition);break;
      case 'outOfScope':this.draft(decision.draft);break;
      case 'correct':if('insertion'in decision)this.insertion(decision.insertion);else this.draft(decision.draft);break;
      case 'correctDesign':this.insertion(decision.insertion);break;
      case 'assignCarrier':this.repo(decision.commit.repo);if('number'in decision.carrier)this.issue(decision.carrier);else this.draft(decision.carrier);break;
      case 'assignMigration':this.issue(decision.original);if('number'in decision.migration)this.issue(decision.migration);else this.draft(decision.migration);break;
      case 'includeExisting':this.issue(decision.issue);break;
      case 'adoptResult':this.created(decision.result);break;
      case 'answer':case 'outOfDomain':case 'implementationDefect':case 'refute':case 'upholdOwner':case 'upholdMain':case 'reject':case 'fix':case 'reverify':case 'keepWork':case 'reopen':case 'restore':case 'revokeNoCode':case 'rerun':case 'retry':case 'retryAfterAbsence':case 'rebaseEdit':case 'sourceRestored':case 'retryHost':break;
    }
  }
  created(result:CreatedResult):void {if(result.kind==='issue')this.issue(result.issue);else this.pr(result.pr);}
  effect(effect:Effect):void {
    const action=effect.action;
    switch(action.kind){
      case 'publishPr':this.issue(action.member);this.target(action.target);this.branch(action.headRepo,action.submission.payload.branch);if(action.pr)this.pr(action.pr);break;
      case 'createIssue':{
        this.draft(action.spec);const status=effect.state;
        const startedAt=status.kind==='executing'||status.kind==='uncertain'?status.startedAt:status.kind==='failed'&&status.provenance.kind==='call'?status.provenance.startedAt:status.kind==='ready'&&status.provenance.kind==='accepted'&&status.provenance.previous.kind==='call'?status.provenance.previous.startedAt:null;
        if(startedAt!==null)this.scope.creations.push({repo:action.spec.repo,since:Math.floor(startedAt/1000)*1000,title:action.spec.title,body:action.spec.body,actor:action.actor});
        break;
      }
      case 'attachChild':this.issue(action.parent);this.issue(action.child);if(action.owner.kind==='insertion')this.entry(action.owner.insertion.entry);break;
      case 'replaceBody':this.issue(action.edit.issue);break;
      case 'setIssueState':this.issue(action.issue);break;
      case 'rerunChecks':this.pr(action.pr);this.run(action.repo,action.workflowRunId);break;
      case 'merge':this.issue(action.member);this.pr(action.pr);this.target(action.target);this.stamp(action.review);this.stamp(action.accept);break;
      case 'wake':break;
    }
    if(effect.state.kind==='confirmed'){
      const result=effect.state.result;
      if(result.kind==='created')this.issue(result.issue);
      if(result.kind==='published')this.pr(result.pr);
    }
    if((effect.state.kind==='uncertain'||effect.state.kind==='failed')&&effect.state.received)this.created(effect.state.received);
    if(effect.state.kind==='confirmed'&&action.kind==='publishPr'&&action.pr===null&&effect.state.result.kind==='published'){
      this.scope.maintenanceIntents?.push({kind:'systemCreated',pr:effect.state.result.pr,effectId:effect.id});
    }
  }
}

function planFor(state:Agenda|null,operation:PortInput|null,receipt?:EffectReceipt):ReadPlan {
  const plan=new ReadPlan();
  if(state){
    if(state.parent)plan.issue(state.parent);
    for(const unit of state.units){
      if(unit.postMerge)plan.stamp(unit.postMerge.stamp);
      for(const member of unit.members){
        plan.issue(member.ref);plan.target(member.target);
        const binding=member.binding.kind==='publishing'?member.binding.previous:member.binding;
        if(binding.kind==='registered'){plan.pr(binding.pr);plan.branch(binding.headRepo,binding.branch);}
        if(member.terminal.kind==='merged')plan.pr(member.terminal.pr);
        for(const requirement of member.contract.requirements)plan.repo(requirement.commit.repo);
        for(const gate of [member.review,member.accept])if(gate)plan.stamp(gate.stamp);
      }
    }
    if(state.closure)plan.stamp(state.closure.stamp);
    for(const draft of state.drafts){plan.draft(draft.spec);if(draft.parent)plan.issue(draft.parent);if(draft.state.kind==='registered')plan.issue(draft.state.issue);if(draft.state.kind==='placed')plan.issue(draft.state.member);}
    for(const effect of state.effects)if(effect.state.kind!=='cancelled')plan.effect(effect);
    for(const work of state.designWorks){if(work.result)plan.repo(work.result.repo);if(work.route.kind==='defaultFirst')plan.repo(work.route.repo);}
    for(const amendment of state.amendments)if(amendment.state.kind==='pending'){
      for(const edit of amendment.state.bodyEdits)plan.issue(edit.issue);
      for(const insertion of amendment.state.insertions)if(insertion.kind==='existing')plan.entry(insertion.entry);
    }
    for(const item of state.cases)if(item.state.kind!=='resolved'&&item.state.kind!=='cancelled'){
      for(const baseline of item.bodyBaselines)plan.issue(baseline.issue);
      if(item.state.kind==='awaitingExternal'&&item.state.wait.kind==='caseSource')plan.condition(item.state.wait.condition);
      if(item.state.kind==='applying')plan.decision(item.state.decision);
      const subject=item.subject;
      switch(subject.kind){
        case 'findings':plan.stamp(subject.stamp);break;
        case 'closed':case 'reopened':case 'checks':case 'unexpectedSourceChange':plan.issue(subject.member);break;
        case 'agendaGap':plan.issue(subject.issue);break;
        case 'orphanDesign':plan.repo(subject.requirement.commit.repo);break;
        case 'migration':plan.issue(subject.original);plan.repo(subject.commit.repo);break;
        case 'postMerge':case 'closure':if(subject.cause.kind==='ancestry')for(const pair of subject.cause.comparisons)plan.pair(pair.ancestor,pair.descendant.sha);break;
        case 'claim':case 'effectFailure':case 'hostPrecondition':case 'stall':break;
      }
    }
    for(const effect of state.effects)if((effect.state.kind==='failed'||effect.state.kind==='uncertain')&&effect.state.wait?.kind==='source')plan.condition(effect.state.wait.condition);
  }
  if(operation)switch(operation.op){
    case 'convene':for(const entry of operation.entries)plan.entry(entry);if(operation.parent)plan.issue(operation.parent);break;
    case 'reply':switch(operation.reply.kind){
      case 'submit':{
        const member=state?.units.flatMap(unit=>unit.members).find(member=>member.work&&`work:${member.work.id}`===operation.ticket);
        if(member)plan.branch(member.binding.kind==='registered'?member.binding.headRepo:member.target.repo,operation.reply.branch);
        break;
      }
      case 'designCommit':plan.pair(operation.reply.commit,operation.reply.commit.sha);break;
      case 'decision':plan.decision(operation.reply.decision);break;
      case 'claim':case 'spawned':case 'verdict':case 'report':break;
    }break;
    case 'noCode':plan.issue(operation.member);break;
    case 'resume':case 'tickets':break;
  }
  if(receipt){
    plan.created(receipt.result);
    const effect=state?.effects.find(item=>item.id===receipt.effectId);
    if(receipt.result.kind==='pr'&&effect?.action.kind==='publishPr'&&effect.action.pr===null)plan.scope.maintenanceIntents?.push({kind:'systemCreated',pr:receipt.result.pr,effectId:effect.id});
  }
  return plan;
}

function ancestry(plan:ReadPlan,state:Agenda|null,facts:Facts,operation:PortInput|null):void {
  const defaultPair=(commit:ShaRef)=>{const repo=facts.repos.find(item=>sameRepo(item.repo,commit.repo));if(repo)plan.pair(commit,repo.defaultHead);};
  if(state){
    for(const unit of state.units){
      const targets=verificationTargets(state,unit,facts,unit.postMerge)??[];
      for(const pair of verificationContinuity(state,unit,targets,facts))plan.pair(pair.ancestor,pair.descendant.sha);
      for(const target of targets)for(const sha of target.merges){plan.pair({repo:target.repo,sha},target.commit);defaultPair({repo:target.repo,sha});}
      for(const member of unit.members){
        const merge=sourceMergedPr(member,facts);
        if(merge?.state.kind==='merged'){
          const base=facts.repos.find(repo=>sameRepo(repo.repo,merge.target.repo))?.bases.find(base=>base.name===merge.target.base);
          if(base?.state.kind==='present')plan.pair({repo:merge.target.repo,sha:merge.state.sha},base.state.head);
        }
        const binding=member.binding.kind==='publishing'?member.binding.previous:member.binding;
        const pr=binding.kind==='registered'?facts.prs.find(pr=>sameRef(pr.ref,binding.pr)):undefined;
        for(const requirement of member.contract.requirements){
          defaultPair(requirement.commit);
          const target=targets.find(target=>sameRepo(target.repo,requirement.commit.repo));if(target)plan.pair(requirement.commit,target.commit);
          if(requirement.carrier.kind==='member'&&sameRef(requirement.carrier.member,member.ref)){
            if(pr)plan.pair(requirement.commit,pr.head);
            if(member.baseline.kind==='submitted')plan.pair(requirement.commit,member.baseline.submission.payload.head);
            if(operation?.op==='reply'&&operation.reply.kind==='submit'&&member.work&&operation.ticket===`work:${member.work.id}`)plan.pair(requirement.commit,operation.reply.head);
          }
        }
        if(unit.postMerge?.stamp.kind==='postMerge')for(const target of unit.postMerge.stamp.repos)for(const requirement of member.contract.requirements)if(sameRepo(target.repo,requirement.commit.repo))plan.pair(requirement.commit,target.commit);
      }
    }
    for(const work of state.designWorks)if(work.result)defaultPair(work.result);
    for(const item of state.cases){
      if(item.state.kind==='awaitingExternal'&&item.state.wait.kind==='caseSource'&&item.state.wait.condition.kind==='commitLanded')defaultPair(item.state.wait.condition.commit);
      if(item.subject.kind==='orphanDesign')defaultPair(item.subject.requirement.commit);
      if(item.subject.kind==='migration')defaultPair(item.subject.commit);
    }
    for(const effect of state.effects)if((effect.state.kind==='failed'||effect.state.kind==='uncertain')&&effect.state.wait?.kind==='source'&&effect.state.wait.condition.kind==='commitLanded')defaultPair(effect.state.wait.condition.commit);
  }
  if(operation?.op==='reply'){
    if(operation.reply.kind==='designCommit')defaultPair(operation.reply.commit);
    if(operation.reply.kind==='decision'){
      const decision=operation.reply.decision;
      if(decision.kind==='assignCarrier'){plan.pair(decision.commit,decision.commit.sha);defaultPair(decision.commit);}
      if(decision.kind==='waitExternal'&&decision.condition.kind==='commitLanded')defaultPair(decision.condition.commit);
    }
  }
}

export function createSourceReader(github:GitHubPort):SourceReader {
  let generation=0;
  return {async read(state,operation,cause,receipt){
    const plan=planFor(state,operation,receipt);
    if(state)for(const effect of state.effects){
      const action=effect.action;
      if(action.kind!=='publishPr'||action.pr!==null||effect.state.kind==='confirmed'||effect.state.kind==='cancelled')continue;
      const candidates=await github.openPrsByHead(action.headRepo,action.submission.payload.branch,action.target);
      if(!candidates.ok)return {kind:'unavailable',error:candidates.error};
      for(const pr of candidates.value)plan.pr(pr.ref);
    }
    const initial=await github.facts(plan.scope,cause);if(!initial.ok)return {kind:'unavailable',error:initial.error};
    let facts=initial.value;
    const parent=state?.parent??(operation?.op==='convene'?operation.parent:null);
    const children=parent?facts.issues.find(issue=>sameRef(issue.ref,parent))?.children??[]:[];
    if(children.some(child=>!facts.issues.some(issue=>sameRef(issue.ref,child)))){
      for(const child of children)plan.issue(child);
      const expanded=await github.facts(plan.scope,`${cause}:children`);if(!expanded.ok)return {kind:'unavailable',error:expanded.error};
      facts=expanded.value;
      if(parent&&facts.issues.find(issue=>sameRef(issue.ref,parent))?.children.some(child=>!facts.issues.some(issue=>sameRef(issue.ref,child))))return {kind:'unavailable',error:{kind:'unavailable',message:'Parent children changed while completing the source read; no partial observation was applied'}};
    }
    // All mutable objects above came from this fresh complete read. Additional
    // queries below are immutable ancestry or exact workflow-attempt source reads.
    ancestry(plan,state,facts,operation);
    for(const pair of plan.scope.commits){
      if(facts.commits.some(item=>sameRepo(item.repo,pair.repo)&&item.ancestor===pair.ancestor&&item.descendant===pair.descendant))continue;
      const result=await github.contains(pair.repo,pair.ancestor,pair.descendant);if(!result.ok)return {kind:'unavailable',error:result.error};
      facts.commits.push({...pair,result:result.value});
    }
    for(const pr of facts.prs)if(pr.checks.kind==='failing')for(const failure of pr.checks.required)if(failure.kind==='actions')plan.run(pr.ref.repo,failure.workflowRunId);
    for(const run of plan.scope.checkRuns){
      if(facts.checkAttempts.some(item=>sameRepo(item.repo,run.repo)&&item.workflowRunId===run.runId))continue;
      const result=await github.checkAttempt(run.repo,run.runId);if(!result.ok)return {kind:'unavailable',error:result.error};facts.checkAttempts.push(result.value);
    }
    return {kind:'available',generation:++generation,scope:plan.scope,observedAt:Date.now(),facts};
  }};
}
