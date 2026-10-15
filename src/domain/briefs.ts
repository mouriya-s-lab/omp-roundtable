import type {Agenda,Amendment,CaseDecision,Context,DecisionCase,DesignWork,DraftSpec,GateJob,Inputs,Insertion,Member,OwnerWork,ProtocolReply,ReportWork,SeatRequest,Ticket} from './model.ts';
import {availability,canonical,gateOf,memberOf,refKey,repoKey,sameRef,unitOf} from './identity.ts';
import {allowedDecisionKinds} from './decisions.ts';

const roleRules=`只处理自己的圆桌票据；不与其它席位就协议事务协调；不向操作员提问。契约问题用 claim(question) 给出复现、两种原文读法、最早缺口与建议。设计文档只由 Main 编辑。允许 git commit/push；禁止直接用 gh/API 创建、评论、编辑、关闭、合并协议交付对象，向 roundtable 提交载荷，由程序执行。先完整读 repo AGENTS.md/CLAUDE.md/rules、issue、parent 和相关设计。native yield/relay 自述不是协议回复；只有 roundtable 接受回执才是完成。`;
const gateInstructions={
  review:'按 skill://review-pr 顺序执行 Gate1–5，首个失败停止；固定本 job 输入，以 issue 契约为尺，不扩大范围，不派审查子代理，不替作者补证据。当前驳回和问答裁定逐字有效；没有新前提/证据不要重复已答问题。Main 设计 commit 的发现归 Main。',
  accept:'使用独立干净 detached checkout，核实指定 head；经真实用户入口逐条观察预期结果正负路径。纯库自己在 repo 外写 driver，CLI 真实命令，Web 用 agent-browser 完整操作并核 DB/下游。不能复用作者 driver/tests；最后跑 repo 校验，不修改实现。',
  postMerge:'覆盖本 unit 全成员，包含原项、前置、correction/noCode correction。对每 repo 使用 stamp 指定 commit 的独立干净 checkout；召集后 merge 测最新合并，遗留在包含 merges 的 default 读数上。部署型按 repo 目标环境验证，核每成员结果与关闭。无关失败明确说明，通过 Main 分类形成 outsideAgenda；不要冒称修复。',
  closure:'逐行验 parent 关闭验证，核源头全部 children（含尚未结束项），所有成员 merged/noCode/关闭及每 repo default ancestry、设计承载/迁移均满足。不能从 children 已 merged 推断 parent 产品结果成立。',
} satisfies Record<GateJob['kind'],string>;
const claimExamples:readonly ProtocolReply[]=[
  {kind:'claim',claim:{kind:'question',reproduction:'填写准确路径与实际观察',readings:['填写第一种原文读法','填写第二种原文读法'],earliestGap:'填写最早未决契约点',proposal:'填写建议裁定'}},
  {kind:'claim',claim:{kind:'noCode',evidence:'填写证明当前完整预期已经成立的源头证据'}},
  {kind:'claim',claim:{kind:'split',proposal:'填写保留原义务和转交每项义务的具体方案'}},
  {kind:'claim',claim:{kind:'blocked',category:'填写实际阻塞类别',attempts:'填写已尝试的方法、源头错误及所需解除条件'}},
];
function caseChoices(state:Agenda,input:Inputs,item:DecisionCase):readonly CaseDecision[] {
  const member=item.context.kind==='member'?memberOf(state,item.context.member):undefined;
  const context=item.context;
  const unit=context.kind==='unit'?state.units.find(unit=>unit.id===context.unitId):member?unitOf(state,member.ref):state.units.at(-1);
  const ref=member?.ref??state.parent??state.units[0]!.members[0]!.ref;
  const facts=input.facts.kind==='available'?input.facts.facts:null;
  const issue=facts?.issues.find(issue=>sameRef(issue.ref,ref));
  const bodyEdit={issue:ref,expectedHash:issue?.bodyHash??member?.contract.bodyHash??state.units[0]!.members[0]!.contract.bodyHash,body:'填写核实后的完整新正文，保留全部产品预期与明确转交义务'};
  const verification=item.subject.kind==='postMerge'||item.subject.kind==='closure'?item.subject.cause:null;
  const correctionRepo=verification?.kind==='ancestry'?verification.comparisons[0]!.ancestor.repo:member?.target.repo??ref.repo;
  const correctionTarget=member&&repoKey(member.target.repo)===repoKey(correctionRepo)?member.target:{repo:correctionRepo,base:facts?.repos.find(repo=>repoKey(repo.repo)===repoKey(correctionRepo))?.defaultBranch??'main'};
  const spec:DraftSpec={repo:correctionRepo,title:'填写独立交付目标',body:verification?.kind==='ancestry'?`交付真实整合修正，保留原产品全部预期；所选共同验收提交必须包含这些准确源头 merge：${canonical(verification.comparisons)}。用 git merge 承载真实祖先，不以 squash/rebase 伪造相同 ancestry。填写可复现正负验收方法。`:'填写完整问题、范围、预期和验收方法',target:correctionTarget,designOnly:false};
  const insertion:Insertion={kind:'draft',draft:spec,position:{kind:'correctionOf',unitId:unit!.id}};
  const amendments:Amendment[]=[
    {kind:'designGap',affected:[ref],bodyEdits:[bodyEdit],route:{kind:'defaultFirst',repo:ref.repo}},
    ...(member?[{kind:'designGap' as const,affected:[ref],bodyEdits:[bodyEdit],route:{kind:'withPr' as const,member:ref}}]:[]),
    {kind:'designGap',affected:[ref],bodyEdits:[bodyEdit],route:{kind:'future',carrier:{...spec,designOnly:true}}},
    {kind:'acceptanceMethod',affected:[ref],bodyEdits:[bodyEdit],transfer:insertion},
  ];
  const decisions:CaseDecision[]=[
    ...(['answer','outOfDomain','implementationDefect','refute','upholdOwner','upholdMain','reject','fix','reverify','keepWork'] as const).map(kind=>({kind,basis:'填写根据完整契约与实际证据作出的裁定依据'})),
    ...amendments.map(amendment=>({kind:'amend' as const,amendment})),
    {kind:'waitExternal',condition:{kind:'mainRelease',reason:'填写必须由 Main 再次明确裁定的外部条件'},reason:'填写实际等待原因；条件成立不自动授权 mutation'},
    {kind:'outOfScope',draft:spec},
    {kind:'split',bodyEdit,insertions:[{kind:'draft',draft:spec,position:{kind:'before',unitId:unit!.id}}]},
    {kind:'correct',insertion},
    {kind:'correctDesign',insertion,clauses:[`Main 先修复设计并将真实提交送入 correction target repo default，再由 correction member 承载和验证完整预期：${item.evidence}`]},
  ];
  const bound=member?.binding;
  const pr=bound?.kind==='registered'?facts?.prs.find(pr=>sameRef(pr.ref,bound.pr)):undefined;
  if(pr)decisions.push({kind:'replacePr',pr:pr.ref,reason:'填写放弃原 PR 并另开实现的具体原因'});
  if(member?.baseline.kind==='adopted')decisions.push({kind:'sourceRestored',acceptedHead:member.baseline.acceptedHead});
  if(member?.baseline.kind==='submitted')decisions.push({kind:'sourceRestored',acceptedHead:member.baseline.submission.payload.head});
  for(const merged of facts?.prs.filter(pr=>pr.state.kind==='merged'&&(pr.closes.some(issue=>sameRef(issue,ref))||bound?.kind==='registered'&&sameRef(bound.pr,pr.ref)))??[])decisions.push({kind:'acceptExternalMerge',pr:merged.ref});
  const subject=item.subject;
  switch(subject.kind){
    case 'agendaGap':decisions.push({kind:'includeExisting',issue:subject.issue,position:{kind:'after',unitId:state.units.at(-1)!.id}},{kind:'confirmNoCode',issue:subject.issue,bodyHash:subject.bodyHash,reason:'填写此精确缺项无需代码的实际证据'});break;
    case 'closed':case 'reopened':
      if(subject.event)for(const kind of ['reopen','restore','revokeNoCode'] as const)decisions.push({kind,eventId:subject.event.id});
      if(subject.kind==='closed')decisions.push({kind:'confirmNoCode',bodyHash:subject.bodyHash,reason:'填写当前全文完整预期已经成立的源头证据'});
      break;
    case 'claim':
      if(subject.claim.kind==='noCode')decisions.push({kind:'confirmNoCode',bodyHash:bodyEdit.expectedHash,reason:'填写核实本人主张后确认的证据'});
      break;
    case 'checks':for(const failure of subject.failures)if(failure.kind==='actions')decisions.push({kind:'rerun',runId:failure.workflowRunId});break;
    case 'orphanDesign':decisions.push({kind:'assignCarrier',commit:subject.requirement.commit,carrier:{...spec,repo:subject.requirement.commit.repo,target:{...spec.target,repo:subject.requirement.commit.repo},designOnly:true}});break;
    case 'migration':decisions.push({kind:'assignMigration',original:subject.original,migration:spec});break;
    case 'hostPrecondition':decisions.push({kind:'retryHost',requestId:subject.requestId});break;
    case 'effectFailure':{
      const effect=state.effects.find(effect=>effect.id===subject.effectId);if(!effect)break;
      if(effect.state.kind==='failed')decisions.push({kind:'retry',effectId:effect.id,attempt:effect.attempt});
      if(effect.state.kind==='uncertain'&&effect.action.kind==='createIssue'){
        decisions.push({kind:'retryAfterAbsence',effectId:effect.id,attempt:effect.attempt});
        for(const candidate of facts?.createdIssues??[])decisions.push({kind:'adoptResult',effectId:effect.id,result:{kind:'issue',issue:candidate.issue}});
      }
      if(effect.state.kind==='uncertain'&&effect.action.kind==='publishPr')for(const candidate of facts?.prs??[])decisions.push({kind:'adoptResult',effectId:effect.id,result:{kind:'pr',pr:candidate.ref}});
      if(effect.state.kind==='failed'&&effect.action.kind==='replaceBody')decisions.push({kind:'rebaseEdit',effectId:effect.id,expectedHash:facts?.issues.find(issue=>sameRef(issue.ref,effect.action.kind==='replaceBody'?effect.action.edit.issue:ref))?.bodyHash??effect.action.edit.expectedHash,body:'填写基于当前源头全文重新决定的目标正文'});
      if(effect.state.kind==='failed'&&effect.action.kind==='publishPr'&&effect.action.pr){const action=effect.action;const current=facts?.prs.find(pr=>action.pr&&sameRef(pr.ref,action.pr));if(current)decisions.push({kind:'rebaseEdit',effectId:effect.id,expectedHash:current.bodyHash,body:'填写保留人工文本且仍满足准确 closing 的完整 PR 正文'});}
      break;
    }
    case 'stall':{
      const referencedUnits=state.units.filter(unit=>subject.obligations.some(ref=>ref.kind==='unit'&&ref.id===unit.id));
      for(const unit of referencedUnits)for(const candidate of facts?.issues??[])if(!memberOf(state,candidate.ref)&&unit.members.some(member=>repoKey(member.target.repo)===repoKey(candidate.ref.repo)))decisions.push({kind:'includeExisting',issue:candidate.ref,position:{kind:'correctionOf',unitId:unit.id}});
      const requirements=referencedUnits.flatMap(unit=>unit.members.flatMap(member=>member.contract.requirements));
      for(const requirement of requirements)if(requirements.filter(other=>canonical(other.commit)===canonical(requirement.commit)).length===1)decisions.push({kind:'assignCarrier',commit:requirement.commit,carrier:{...spec,repo:requirement.commit.repo,target:{repo:requirement.commit.repo,base:facts?.repos.find(repo=>repoKey(repo.repo)===repoKey(requirement.commit.repo))?.defaultBranch??'main'},designOnly:true}});
      const referencedEffects=state.effects.filter(effect=>subject.obligations.some(ref=>ref.kind==='effect'&&ref.id===effect.id||ref.kind==='amendment'&&state.amendments.some(amendment=>amendment.id===ref.id&&amendment.state.kind==='pending'&&amendment.state.requiredEffectIds.includes(effect.id))));
      for(const effect of referencedEffects)if(effect.state.kind==='failed'){
        const action=effect.action;
        if(action.kind==='replaceBody'){const current=facts?.issues.find(issue=>sameRef(issue.ref,action.edit.issue));if(current)decisions.push({kind:'rebaseEdit',effectId:effect.id,expectedHash:current.bodyHash,body:'填写基于此精确源头正文的完整修订'});}
        if(action.kind==='publishPr'&&action.pr){const current=facts?.prs.find(pr=>action.pr&&sameRef(pr.ref,action.pr));if(current)decisions.push({kind:'rebaseEdit',effectId:effect.id,expectedHash:current.bodyHash,body:'填写保留人工文本且仍准确 closing 的完整修订'});}
      }
      break;
    }
    case 'findings':case 'postMerge':case 'closure':case 'unexpectedSourceChange':break;
    default:{const exhaustive:never=subject;return exhaustive;}
  }
  const allowed=allowedDecisionKinds(state,item);
  return decisions.filter(decision=>allowed.includes(decision.kind)&&!(decision.kind==='implementationDefect'&&!member)&&!(decision.kind==='reverify'&&verification?.kind==='ancestry'&&verification.comparisons.some(comparison=>facts?.commits.some(pair=>repoKey(pair.repo)===repoKey(comparison.ancestor.repo)&&pair.ancestor===comparison.ancestor.sha&&pair.descendant===comparison.descendant.sha&&pair.result==='notContained'))));
}
function replyExamples(ticket:Ticket['id'],revision:number,replies:readonly ProtocolReply[]):string {
  return replies.map(reply=>canonical({input:{op:'reply',ticket,revision,reply}})).join('\n');
}
function link(ref:Member['ref']):string{return `https://github.com/${repoKey(ref.repo)}/issues/${ref.number}`;}
export function workspace(state:Agenda,context:Context,role:string,id:string):string {
  const root=`/tmp/omp-roundtable/${state.id}`;
  if(role==='design')return `${root}/design/${id.replaceAll('/','-')}`;
  if(context.kind==='member'){const key=`${context.member.repo.owner}-${context.member.repo.name}-${context.member.number}`;return role==='owner'?`${root}/members/${key}/owner`:`${root}/members/${key}/gates/${id.replaceAll('/','-')}`;}
  return context.kind==='unit'?`${root}/units/${context.unitId.replaceAll('/','-')}/gates/${id.replaceAll('/','-')}`:`${root}/agenda/gates/${id.replaceAll('/','-')}`;
}
function shared(state:Agenda,input:Inputs,ticket:Pick<Ticket,'id'|'revision'|'context'>):string {
  const external=state.units.flatMap(unit=>unit.members.flatMap(member=>member.ownerTerminal?.kind==='externallyMerged'?[member.ownerTerminal]:[]));
  return `圆桌 Agenda ${state.id}\n票据 ${ticket.id} revision ${ticket.revision}\nContext ${canonical(ticket.context)}\n${state.parent?`Parent ${link(state.parent)}\n`:''}${roleRules}\n外部合并的非回复终局通知：${canonical(external)}\n完整策略原文（本次 Main 实际输入）：\n${input.policy.text}\n`;
}
export function workBrief(state:Agenda,input:Inputs,work:OwnerWork,member:Member):string {
  const context:Context={kind:'member',member:member.ref};
  const held=availability(state,work,input);
  const pr=member.binding.kind==='registered'?`https://github.com/${repoKey(member.binding.pr.repo)}/pull/${member.binding.pr.number}`:'尚无登记 PR，由 submit 后程序发布';
  const refs=work.holds.map(hold=>({hold,result:hold.kind==='case'?state.cases.find(item=>item.id===hold.caseId)?.state:hold.kind==='amendment'?state.amendments.find(item=>item.id===hold.id)?.state:hold.kind==='effect'?state.effects.find(item=>item.id===hold.effectId)?.state:state.units.flatMap(unit=>unit.members).find(item=>refKey(item.ref)===refKey(hold.member))?.terminal}));
  const facts=input.facts.kind==='available'?input.facts.facts:null;
  const currentPr=member.binding.kind==='registered'?facts?.prs.find(pr=>sameRef(pr.ref,member.binding.kind==='registered'?member.binding.pr:member.ref)):undefined;
  const design=member.contract.requirements.map(requirement=>({requirement,work:state.designWorks.find(work=>work.parentCaseId===requirement.caseId&&canonical(work.result)===canonical(requirement.commit))}));
  const sample:ProtocolReply={kind:'submit',branch:member.binding.kind==='registered'?member.binding.branch:`roundtable/${state.id}/${member.ref.number}`,head:work.baseline,title:'Use the delivered change title',body:`Closes ${repoKey(member.ref.repo)}#${member.ref.number}\n\nInclude actual implementation and outcome evidence.`,template:member.designOnly?'docOnly':'fourLayer',retryNote:null};
  return `${shared(state,input,{id:`work:${work.id}`,revision:work.contentVersion,context})}
角色 ${member.designOnly?'Main designOnly Member':'Owner'}；Issue ${link(member.ref)}
目标 ${repoKey(work.target.repo)} base ${work.target.base}；本工单创建时源头基准 ${work.baseline}
最新 PR 源头读数 ${canonical(currentPr??null)}；源头变化不代替 AcceptedSubmission ${canonical(member.baseline)}，也不消费本 WorkId。
工作目录 ${workspace(state,context,'owner',work.id)}。从远端创建独立 clone，不修改宿主继承 checkout。续作先检查此目录未推送提交；拒绝强推，push 被拒用 blocked。
沿用 PR ${pr}
全部当前契约：
${member.contract.body}
Contract revision ${member.contract.revision}
当前原因 ${canonical(work.reasons)}
必须包含的 repo-qualified commits ${canonical(work.required)}
设计承载依据及 Main 原文条款：${canonical(design)}
依赖及解除依据 ${canonical(refs)}
可用性 ${canonical(held)}。${held.kind==='held'?'暂停执行/提交，可继续无争议部分并 yield；程序不会 wake，等待真实引用终点。':'必须完成明确回复后才能 yield。'}
交付整个 issue，不削减产品预期。按 writing-pr：纯文档 docOnly 解释思路；代码 fourLayer 要实现机制、真实落地、启动顺序、逐预期正负 runtime 证据，测试数量只卫生。same HEAD 修证据仍要新 submit/retryNote；git push 不等圆桌提交完成。
完整端口 JSON 示例（说明文本替换为实际结果，submit head 必须是真实远端 branch SHA）：
${replyExamples(`work:${work.id}`,work.contentVersion,[sample,...claimExamples])}
当前票据随 context 每次完整重注入。`;
}
export function designBrief(state:Agenda,input:Inputs,work:DesignWork):string {
  const parent=state.cases.find(item=>item.id===work.parentCaseId);
  const context=parent?.context??{kind:'agenda' as const};
  const route=work.route;
  const repo=route.kind==='defaultFirst'?route.repo:route.kind==='withPr'?memberOf(state,route.member)?.target.repo:'number'in route.carrier?memberOf(state,route.carrier)?.target.repo:route.carrier.target.repo;
  const snapshot=repo&&input.facts.kind==='available'?input.facts.facts.repos.find(snapshot=>repoKey(snapshot.repo)===repoKey(repo)):undefined;
  const examples:ProtocolReply[]=[...claimExamples];
  if(snapshot)examples.unshift({kind:'designCommit',commit:{repo:snapshot.repo,sha:snapshot.defaultHead}});
  return `${shared(state,input,{id:`work:${work.id}`,revision:work.contentVersion,context})}
Main DesignWork；父决定及真实直接依赖 ${canonical(parent)}
受影响成员 ${canonical(work.affected)}
必须亲自修正的完整设计条款：${canonical(work.clauses)}
设计承载路线 ${canonical(route)}
工作目录 ${workspace(state,{kind:'agenda'},'design',work.id)}
完整检查设计文档每一部分与相关文档的语义；提交并推送真实远端设计产物。defaultFirst 必须证明 exact commit 已在对应 repo default；withPr/future 保留指定 carrier，不换成同 repo 其它成员。父 case applying 不阻塞本 DesignWork；本人新 claim 仍须按自身 hold 等待。
下列 designCommit 示例的 SHA 仅为实际 source default 格式基准，不证明它履行本设计义务；你必须换为自己完成本次设计修复的真实远端提交，不能抄旧 HEAD 或填占位 SHA。缺少真实 repo 读数时没有 designCommit 示例，先处理 sourceUnavailable。
完整工具参数 JSON：
${replyExamples(`work:${work.id}`,work.contentVersion,examples)}`;
}
export function reportBrief(state:Agenda,input:Inputs,report:ReportWork):string {
  const external=state.units.flatMap(unit=>unit.members.flatMap(member=>member.ownerTerminal?.kind==='externallyMerged'?[member.ownerTerminal]:[]));
  return `${shared(state,input,{id:`work:${report.id}`,revision:report.contentVersion,context:{kind:'agenda'}})}
Main 最终报告；全部 unit/parent/设计/效应已确认。向用户实际报告每项 issue、PR、merge、验收证据及仍需说明的风险，然后回复 report；程序不声称用户已经阅读。
外部合并的非回复终局 ${canonical(external)}
完整当前交付结果 ${canonical(state.units.map(unit=>({id:unit.id,members:unit.members.map(member=>({issue:link(member.ref),terminal:member.terminal,ownerTerminal:member.ownerTerminal})),postMerge:unit.postMerge})))}
完整工具参数 JSON：
${replyExamples(`work:${report.id}`,report.contentVersion,[{kind:'report',summary:'填写已经向用户报告的完整实际结果与证据，不把未验证项称为完成'}])}`;
}
export function gateBrief(state:Agenda,input:Inputs,gate:GateJob):string {
  const context=gate.context;
  const members=context.kind==='member'?state.units.flatMap(unit=>unit.members).filter(member=>refKey(member.ref)===refKey(context.member)):context.kind==='unit'?state.units.find(unit=>unit.id===context.unitId)?.members??[]:state.units.flatMap(unit=>unit.members);
  return `${shared(state,input,{id:`gate:${gate.id}`,revision:1,context:gate.context})}\n角色 ${gate.kind}，新 JobId ${gate.id}；必须 fresh holder，不能沿用上一轮评判。\n${gateInstructions[gate.kind]}\n结构化 pin（程序核实，不让模型抄回）：${canonical(gate.stamp)}\n工作目录 ${workspace(state,gate.context,gate.kind,gate.id)}；跨 repo 对每 repo 分别独立 clone，不能选第一个成员代替 scope。\n全部成员与契约：\n${members.map(member=>`${link(member.ref)} contract revision ${member.contract.revision}\n${member.contract.body}`).join('\n\n')}\n完整现行裁定：${canonical(gate.stamp.rulings)}\nverdict 只填 ok/note，不能加 head/逐行/pin/分类字段。需要额外主张时用 claim，程序建立独立 Main case 并撤销本 Job；Main 决定后由 fresh Job/fresh holder 重做。完整端口 JSON 示例：\n${replyExamples(`gate:${gate.id}`,1,[{kind:'verdict',ok:true,note:'填写真实正负入口结果与可复现命令'},{kind:'verdict',ok:false,note:'填写首个违反当前契约的实际发现和复现证据'},...claimExamples])}`;
}
export function caseBrief(state:Agenda,input:Inputs,item:DecisionCase):string {
  const subject=item.subject;
  const effectId=subject.kind==='effectFailure'?subject.effectId:subject.kind==='hostPrecondition'?subject.effectId:null;
  const effect=effectId?state.effects.find(effect=>effect.id===effectId):null;
  const referenced=subject.kind==='stall'?subject.obligations.map(ref=>{
    switch(ref.kind){
      case 'unit':return {ref,object:state.units.find(unit=>unit.id===ref.id)};
      case 'amendment':return {ref,object:state.amendments.find(amendment=>amendment.id===ref.id)};
      case 'draft':return {ref,object:state.drafts.find(draft=>draft.id===ref.id)};
      case 'effect':return {ref,object:state.effects.find(effect=>effect.id===ref.id)};
      case 'case':return {ref,object:state.cases.find(item=>item.id===ref.id)};
      case 'request':return {ref,object:state.requests.find(request=>request.id===ref.id)};
      case 'gate':return {ref,object:gateOf(state,ref.id)};
      case 'work':return {ref,object:state.units.flatMap(unit=>unit.members).find(member=>member.work?.id===ref.id)?.work??state.designWorks.find(work=>work.id===ref.id)??(state.report?.id===ref.id?state.report:null)};
      default:{const exhaustive:never=ref.kind;return exhaustive;}
    }
  }):[];
  const choices=caseChoices(state,input,item);
  return `${shared(state,input,{id:`case:${item.id}`,revision:item.contentVersion,context:item.context})}
Main 裁定；subject ${canonical(item.subject)}
证据 ${item.evidence}
当前正文基准 ${canonical(item.bodyBaselines)}
当前 case 状态 ${canonical(item.state)}
引用效应的完整 action/attempt/error/wait/received/授权依据：${canonical(effect)}
Stall 引用的实际当前对象：${canonical(referenced)}
source 读取 ${input.facts.kind==='available'?`generation ${input.facts.generation} scope ${canonical(input.facts.scope)}`:canonical(input.facts.error)}
先读拥有该语义的完整文档/原 issue，不向操作员问日常裁定，不删除既定义务。applying 只读孩子进度，不能覆盖原决定；awaitingExternal 允许 Main 按本 revision 解除或替换等待。
本 subject 的决定种类：${canonical(allowedDecisionKinds(state,item))}。
${subject.kind==='findings'?'决定语义：upholdOwner = 认定该 finding 成立，交给原成员 owner 修复实现；不是认可当前 PR。upholdMain = 认定 finding 成立，由 Main 先修设计并提交真实 designCommit，owner 等待。reject = 有证据地驳回该 finding，随后必须 fresh gate，不把 not-ok 改成 pass。outOfScope = 将确切超范围义务登记为独立 draft；amend = 按明确正文与设计路线修订契约。不要从英文名字猜含义。':''}
以下完整端口 JSON 使用当前真实身份与正文基准；说明文本必须替换为实际依据。缺少真实候选的 adopt、不可重跑 status、无原实现上下文的 implementationDefect 不可用。retryAfterAbsence/retryHost 明确承担重复风险，不是平台 exactly-once。
${replyExamples(`case:${item.id}`,item.contentVersion,choices.map(decision=>({kind:'decision',decision})))}
correct / correctDesign 对 terminal findings 必须 correctionOf 原 unit，不能重开已 merged 的原 OwnerWork。correctDesign 的 clauses 是 Main 设计工作内容，不是未经 BodyEdit 的旧 issue 契约改写；Main designCommit 前必须源头证明进入 correction target repo default，全部创建/挂接和设计完成后才放入新 correction member，并同次写它的 required commit。
merged 成员 bodyChanged 的 keepWork 接纳当前源头契约并触发 fresh unit 验证，但不制造旧成员工作；有真实实现缺陷时由正式 not-ok/correction 承接，不能把 source change 本身当 finding。
普通 designGap 保留 defaultFirst / withPr / future 三条路线；acceptanceMethod 必须转交原验收义务。每个 ShaRef 保留 repo。新正文基准先正常 source observe，不恢复旧正文绕过 conflict。`;
}
export function spawnBrief(state:Agenda,input:Inputs,request:SeatRequest,candidate:string|null):string {
  return `${shared(state,input,{id:`spawn:${request.id}`,revision:1,context:request.context})}\nMain 原生派出请求 ${request.name}；role ${request.role}；run ${request.runId}\n${candidate?`registry 已有唯一待回执 agent ${candidate}；只回 spawned，不再次 task。`:`用原生异步 task，agent ${request.role==='owner'?input.policy.ownerAgent:input.policy.gateAgent}、isolated:true、name:${request.name}。assignment 只用下列短文本，不复制长策略或代答 child。`}\n${request.assignment}\n只有真实 task 返回和同一 registry 的 exact child 可回 spawned；没有真实 agentId 就不能回执。source parent/session/run 必须匹配，数字后缀只用于发现。\n${replyExamples(`spawn:${request.id}`,1,[{kind:'spawned',agentId:candidate??'填写本请求真实 task 返回的 agentId'}])}`;
}
