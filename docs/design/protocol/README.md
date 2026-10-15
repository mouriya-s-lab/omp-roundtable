# 当前协议与纯状态内核

本模块拥有本系统创建的协议对象、回复准入和票据投影。它不拥有 GitHub 的开关、HEAD/checks/mergeability 或 OMP 的 live/parked 状态。生命周期与失败窗口在 [lifecycles.md](lifecycles.md) 定义，I/O 连接在 [integration](../integration/README.md) 定义。

## 对象

`Agenda` 保存 id/version/convenedAt/nextId、按序 units、可选 parent、成员现行契约、work/job/case/effect/draft/amendment/seat 槽位、当前 run 绑定与 ReportWork。召集边界生成 UUID，内核不读钟、不生成随机数。所有其它 ID 从 agenda/type/nextId 的单调 ordinal 分配；一个转移内按 unit/member 顺序、case/work、draft/amendment、effect、gate、seat 固定顺序及 subject key 排序分配。observe 不靠时间/HEAD/随机数制造新身份。

`OwnerWork` 保存稳定 WorkId、member、当前原因集合、required ShaRef、创建工作时的真实远端 baseline/target、contentVersion 和精确 HoldRef。每成员最多一项开放工作；原因同类别替换，不按 push 追加历史。最新源头读数另在 brief 展示，不刷新此工作基准或 Member 的 accepted baseline。HEAD/checks 自然变化不结束工作或改变 contentVersion；新契约、required commit 或明确答复改变内容时版本加一。`WorkAvailability=runnable|held{holds:NonEmpty<HoldRef>}` 由依赖对象当前结果计算，不持久化 blocked 布尔值。

`HoldRef=case{caseId}|amendment{id}|dependency{member}|effect{effectId}` 是依赖意图索引。创建阻塞对象与添加引用在同一转移；parser 拒绝缺失对象、缺少必须依赖边或环。一个 question 与一个前置依赖可同时存在。effect hold 等其生命周期 confirmed/cancelled，不能把取消当成 ApplyingRef 或 Amendment 成功；未交付义务仍由其 case/amendment/替换对象或新工作承接。引用满足后保留到工作终点以重建解除依据；删除对象前原子解除所有引用。DesignWork 不引用自己的父 case 或包含自己的 amendment，Effect 不等待 effectFailure case 结束。

Member 的 accepted baseline 是 `none|adopted{pr,acceptedHead}|submitted{submission:{workId,payload}}`。PR 绑定为 `none|publishing{effectId,previous:none|registered}|registered{pr,headRepo,branch,origin:'adopted'|'published'}`；previous 只保存本系统被当前 publication 暂时替代的准确关联，不是 GitHub 状态副本。confirmed 安装已确认关联，cancelled 仅在源头仍支持同一 PrRef/headRepo/branch/target 时恢复 previous，否则 none；不搜索相似 PR 补位。Adoption 是读取源头后的接管意图基准；AcceptedSubmission 是被接受的完成事实，不随 HEAD 自动刷新。接管不虚构 submit；第一次 conflict/check failure/upheld/design requirement 建稳定 OwnerWork。accepted submit 等待 publish 确认时禁止 gate/merge。

Member 另保存有界 `OwnerWorkTerminal`，区分 submitted{workId,submission}、noCode{workId,reason}、replacePr{workId,pr,reason}、sourceRestored{workId,acceptedHead}、externallyMerged{workId,pr,merge:ShaRef,mergedAt}。真实外部 merge 同次终止开放工作并写最后一种非回复结果，不制造 ReplyResult/owner receipt。Main tickets/context 持续展示它，最终 ReportWork 携带全部外部 merge 事实；新的工作终局可按主体槽替换，但不能在任何 Main 可见机会之前清掉通知。

`GateJob` 保存新 JobId、kind/scope、完整结构化输入戳、SeatRequest，以及 `requested|answered{ok,note}|cancelled{reason}`。review/accept 独立分槽；PR body-only 变化只撤销 review，检查/mergeability 改变只阻止 merge。开放 work/case/物化隐藏其可执行票据并拒绝 verdict/merge；仍匹配的另一 kind job/receipt 可以保留。自己的完整戳改变或评判义务明确替换才 fresh JobId/fresh holder。not-ok 独立成 case，不随旧 job 失效消失；Main 接受修复/驳回并结束该发现的决定后，原失败 job 不复用为 pass。claim 取消原 job，原因 claimOpened；决定后 fresh job，旧 job 返回 superseded。每 kind 只保留当前结果/receipt，不保存代数。

`DecisionCase` 保存稳定 CaseId、初始为 1 的 contentVersion、精确 subject/context/证据和 openedBy claim receipt。状态为 `open|applying{decision,required:NonEmpty<ApplyingRef>}|awaitingExternal{wait}|resolved{result}|cancelled{reason}`。ApplyingRef 只引用直接孩子 DesignWork/Amendment/Draft/Effect；有 amendment 时不能展开其传递孩子。applying 只读进度和实际可行动孩子，不生成可覆盖原决定的 reply ticket。全部直接孩子成功时 observe 自动 resolved、解除 hold，Main 不再报告应用完成。failed/uncertain/普通 cancelled 不是成功。

Case 的普通等待为 `caseSource{condition}`，effectFailure 等待为 `effect{effectId}`，不复制 effect 的错误/condition。进入等待、条件成立重新 open、subject context 或正文基准替换时 contentVersion 加一，同次最多一次。条件成立只允许 Main 基于新 brief 再判，不自动授权写。mainRelease 仍保留 Main mayWait 票据与合法解除/替换入口。旧 bodyHash 决定拒绝并返回当前输入，不吞 case。
Source case 的 occurrence 不按轮询时间去重：正文偏离保存拥有的 contractRevision；PR/branch 异常保存 exact registered binding、accepted submission WorkId/head 或 adoption head，以及现有 OwnerWork 的 open/terminal phase，PR 事件才附其源头 updatedAt。相同问题已有工作承接时不再开 case；恢复后新的 owned phase 或新的契约偏离不能误用旧 resolved case。checks subject 保存 exact accepted submission 的 responseWorkId 与失败身份，第二次被接受的修复后同 run 仍失败是新裁定义务。old receipt 仍按其原 ticket/revision 重放，不是对当前源头的新接受。

postMerge/closure 的 cause 为真实 verdict{jobId,note} 或 ancestry{comparisons:NonEmpty<{ancestor:ShaRef,descendant:ShaRef}>}。只有源头明确 notContained 才建立 ancestry case；missing/缺少查询不是失败 verdict，也不伪造 GateJob。 unchanged negative 不能靠 reverify 清除；真实修正满足后撤销过时源头 case 并建立 fresh gate。所选验收提交必须同时包含真实 member merges 和 required design commits；VerifyRepo.merges 仅列真实 merge，不把设计 SHA 冒充 merge。


`Effect` 保存稳定 EffectId、Action、前提戳、attempt 及 `ready|executing{attempt,startedAt}|failed{attempt,error,wait}|uncertain{attempt,error,wait}|confirmed{result}|cancelled{reason}`。错误与 EffectWait 只由 Effect 保存；case 只引用 EffectId。ready 意图与 accepted 回复同次创建；真实调用前才 started，attempt 加一。wait 解除只清 wait 并开放裁定，不改 ready。动作完成判据在集成动作表定义。

`SeatRequest` 保存 role、确定请求名、短 assignment、请求 run 和明确接受的 holder。registry 每次向宿主读；不保存 live/parked 副本。请求名为 `Rt` 开头字母数字，含 agenda 短 hash、role、单调 serial，不用 repo slug 或剥离后缀作鉴权。owner request 可跨同成员不同 OwnerWork；gate 每 Job 新 request。

`DesignWork` 是 Main 在 Case 内的真实设计工作：稳定 WorkId、父 CaseId、affected/clauses、route、contentVersion/依赖。只有源头存在的远端 ShaRef 被接受才形成 DesignRequirement 并结束。纯设计交付项仍是 holder Main 的 Member，走 submit/双 gate/merge/postMerge，不与此混用。

`Draft` 保存 DraftId、purpose(split/correction/outsideAgenda/designOnly/migration)、精确 DraftSpec、position、Unit/Agenda 所属、父子挂接、可选 DesignRequirement 及 creationEffectId/必要 attach refs。状态 `proposed|registered{issue}|placed{member}`；失败只读 Effect。outsideAgenda 在真实登记且必要挂接完成后满足；其它只有 IssueRef 和挂接确认后 placed。原始 insertion 在接受时分配真实 refs；replay 不再分配。

`AmendmentIntent` 属于接受它的 Case，状态 `pending{bodyEdits,designWork,insertions,requiredEffectIds}|effective{revision}`。正文等于 target、真实设计提交取得、必要转交 issue 登记后一次提升 affected contract revision、替换当前条款/DesignRequirement、解除 owner 等待。pending 不假称正文已改。纯 answer 不制造 amendment。

`ReportWork` 是 Agenda 内 Main 的最后工单，summary 与 receipt 保留在 completed Agenda。报告只表示 Main 声明已经向用户报告，不证明用户已读。

## 纯公开 API

```ts
type Result<T,E> = {ok:true,value:T}|{ok:false,error:E};
createAgenda(input:ConveneInput,facts:Facts,now:Millis,id:AgendaId):Result<Agenda,DomainError>;
transition(state:Agenda,input:Inputs,event:Event):Transition;
tickets(state:Agenda,input:Inputs):readonly Ticket[];
parseAgenda(value:unknown):Result<Agenda,ParseError>;
parsePortInput(value:unknown):Result<PortInput,ParseError>;
```

Transition 为 `same{reply:ReplyResult|null}|rejected{error}|next{state,reply}`。next version 恰好加一；same/rejected 不变。ReplyResult 保存接收时 `{ticket,acceptedVersion,outcome:'accepted'|'claimOpened'|'reported',created:readonly DomainRef[]}`，不按之后状态重算。

Inputs 是 `{facts:FactRead,host:HostObservation,policy:Policy}`。FactRead 是 `available{generation,scope,observedAt,facts}|unavailable{error}`，只在进程内；generation 不是平台原子快照。Inputs 没有 now；仅改变 observedAt 不能产生转移。Policy 只影响 brief/agent 选择。

Event 闭合为 observe、hostObserved、reply(caller/ticket/revision/payload/acceptedAt)、mainNoCode(caller/member/bodyHash/reason/acceptedAt)、effectSatisfied(id/result)、effectStarted(id/attempt/startedAt)、effectConfirmed(id/attempt/result)、effectFailed(id/attempt/error/outcome knownFailed|uncertain)、effectCancelled(id/reason)、resume(runId/operatorConfirmedOriginalSessionEnded:true)。hostObserved 是内部宿主生命周期事件，不是 PortInput；它只更新绑定、丢失 holder 的续席、当前通知意图及精确非响应 case，不分类 GitHub、不修改契约、不解除业务依赖或结束工作。内部事件同样精确 parse；effectSatisfied 仅限动作表可查询且 ready/uncertain 的目标，绝不用于 wake。

effectFailed 对 ready 的唯一准入是未发送的 publishPr/replaceBody：outcome=knownFailed、error.kind=precondition，完整源头证明 current bodyHash 既非 expected 也非 target。它保留当前 attempt（可为 0），不伪造 executing/startedAt；同次建立 effectFailure。其它 failed/uncertain 结果只答当前 executing attempt。Main rebaseEdit 原子修改同意图并回 ready，下一次真实调用才 attempt 加一。

Ticket 含稳定 id、revision、holder、准确 context、完整 brief、allowedReplies 与 `runDisposition:mustRun|mayWait`。id 是 `work:<WorkId>|gate:<JobId>|case:<CaseId>|spawn:<RequestId>`；ticket 含 agendaId，旧报告不能路由到新 active。work/case revision 是 contentVersion；gate/spawn 固定 1。所有 held 工作 mayWait，允许继续无争议部分但不得 submit；不得 wake。Main 的源头依赖 case 在 facts unavailable 时 mayWait，open case 仍 attentionRequired，不消费或改写决定；源头恢复后按原对象重新投影。Main 不回复保持 attentionRequired 投影；child 投递后的真实回合已结束仍无回复时建立精确 hostPrecondition.seatNonresponse，不消费原票据。

## 回复准入与回执

先以当前真实 caller 的 session/parent/run/request/holder 鉴权，再查主体仍保留的精确 receipt，再校验对象/revision/kind/payload/source 前提。合法继任 holder 可以重放继承对象的 receipt，不需要旧进程原 session；旧 run caller、非 holder、孙级仍拒绝。

Terminal key 为 `(ticket,revision,kind:'terminal')`；同键同 canonical digest 返回原 ReplyResult、same、零 GitHub I/O；同键不同 terminal payload 为 replyConflict。无精确 receipt 时：替换对象 superseded，当前旧 revision staleRevision，从未存在 unknownTicket。不能拿旧 revision 覆盖新决定。owner receipt 留到该成员下一 OwnerWork terminal reply 被接受；gate receipt 留到新 Job 安装；case 按精确 carrier/subjectKind/subjectIdentity 留最近 receipt；report 永久保留。不建全 Agenda replay log。

Claim subject 的身份包含原 ticket、原 revision 与 claim 内容；Claim key 是 `(ticket,revision,kind:'claim',digest)`，receipt 在 Case.openedBy。相同 key 重放 same；已有 pending claim 的不同 claim 为 pendingClaim。owner case 决定后同 WorkId 新 revision 才能 submit；相同文字在新 revision 提交是新 CaseId，不复用 resolved case 或覆盖旧 openedBy。gate 原 job 不恢复。任何本人 claim 包括 question 都暂停其执行，不能以 submit 绕过。

接受 terminal reply 时，work/receipt/ReplyResult/AcceptedSubmission 或 Draft/Amendment 及确定产生的 ready Effect 必须一次 durable 写入。fsync 后立即返回；不能在原 RPC 返回前执行 publish/observe 并删除 replay 槽。

DomainError.kind 闭合为 unauthorized、wrongTicketKind、wrongContext、unknownTicket、staleRevision、superseded、replyConflict、pendingClaim、premiseChanged、missingDesignCommit、invalidDecision、sourceUnavailable、unsupportedFormat、ownershipBlocked、ownershipConflict、roundtableInactive、notFound、agendaRequired。ParseError 含 field path 和理由；边界拒绝额外字段、错误引用及非法状态组合，不能把 JSON cast 成 Agenda。

## 业务分类与决定

先查真实 merged，再判 open/可维护；非默认 base merge 后 issue 仍 open 只生成 close Effect，不生成新 deliver。无可维护 PR 的 open 当前成员建初次工作；外国 PR 不改 branch、不接管，另开本任务 PR。维护权限本身不是作者交接。

HEAD 偏离 accepted baseline 建/保留 unsubmittedPush work，旧 AcceptedSubmission 保留；回到旧 SHA 也不自动结束，必须新 submit 或 sourceRestored。issue 人工关闭、PR closed-unmerged、branch 消失、target/base/维护权变化暂停原工作并开精确 source case。source-only 结束工作只允许真实外部 merge，原因 externallyMerged 必须通知，不能伪造 owner 回复。

review/accept not-ok 每份独立 findings case。upholdOwner 形成/累积 owner 修复；upholdMain 建 Main DesignWork，owner 到设计和 amendment 完成前暂停，即使 PR 已关。reject/outOfScope 不把失败改 pass，而是 fresh gate。现行 gate 裁定为 findingRejected 或 questionAnswered(answer|outOfDomain)，保存依据及 applicableContractRevision；相同 subject 替换，revision 变化失效，逐字注入对应 kind/scope 的 fresh brief 和 stamp。

checks 首次失败建 OwnerWork；接受对应完成回复后同 run 仍失败才建 checks case，保留 fixed run 责任。rerun 只限源头可映射的 Actions workflow/attempt；status/其它 app 只能 fix/external。mergeable=no 要求 owner 整合当前 base；unknown 只等待。

## 完整 CaseDecision 联合

下表每个变体只能回答对应精确 case，context/subject 不由 payload 自报；不能用 generic key 覆盖另一对象。

|subject|合法决定|
|---|---|
|question|answer{basis}、outOfDomain{basis}、implementationDefect{basis}、amend{amendment}；implementationDefect 仅限原 Member 实现义务|
|noCode|confirmNoCode{bodyHash,reason}、refute{basis}|
|split|split{bodyEdit,insertions:NonEmpty<Insertion>}、refute{basis}；原 work 保留收窄义务，不能隐式 noCode|
|blocked|replacePr{pr,reason}、waitExternal{condition,reason}、refute{basis}|
|findings，原成员 pending|upholdOwner{basis}、upholdMain{basis}、reject{basis}、outOfScope{draft:DraftSpec}、amend{amendment}|
|findings，源头已在原 finding 的 exact PR/head/target 合并|reject{basis}、outOfScope{draft}、correct{insertion}、correctDesign{insertion,clauses:NonEmpty<string>}；correctionOf 必须指向原 unit，不重开已结束原 owner|
|closed|confirmNoCode{bodyHash,reason}、reopen{eventId}|
|reopened|restore{eventId}、correct{draft:DraftSpec}、revokeNoCode{eventId}|
|checks|rerun{runId}、fix{basis}、waitExternal{condition,reason}|
|postMerge / closure|reverify{basis}、correct{insertion:Insertion}、correctDesign{insertion,clauses:NonEmpty<string>}；源头 ancestry negative 未变时 reverify 拒绝，不能改 pass|
|orphanDesign|assignCarrier{commit:ShaRef,carrier:MemberRef或DraftSpec}、waitExternal{condition,reason}|
|migration|assignMigration{original:IssueRef,migration:IssueRef或DraftSpec}、waitExternal{condition,reason}|
|agendaGap|includeExisting{issue:IssueRef,position:Position}、confirmNoCode{issue:IssueRef,bodyHash,reason}、waitExternal{condition,reason}|
|effectFailure|retry{effectId,attempt}、waitExternal{condition,reason}、adoptResult{effectId,result:CreatedPr或CreatedIssue}、retryAfterAbsence{effectId,attempt}、rebaseEdit{effectId,expectedHash,body}；动作不适用即拒绝|
|unexpectedSourceChange|pending 成员：keepWork{basis}、replacePr{pr,reason}、sourceRestored{acceptedHead:Sha}、acceptExternalMerge{pr:PrRef}、amend{amendment}；merged 成员仅 keepWork/amend，不制造旧 OwnerWork|
|hostPrecondition|retryHost{requestId}、waitExternal{condition,reason}；实际 plan/isolation/async 未改变拒绝；seatNonresponse 允许 Main 显式承担重复风险的一次投递|
|stall|includeExisting{issue:IssueRef,position:Position}、assignCarrier{commit:ShaRef,carrier:MemberRef或DraftSpec}、rebaseEdit{effectId,expectedHash,body}、waitExternal{condition,reason}；没有 generic resolved|

所有决定对象都有 `kind` 字面量区分，所有 basis/reason/body 是非空 string；Hash/Sha 是经边界格式验证的字符串，attempt 是非负整数，正文 replacement 可按明确产品输入表示空正文。`MemberRef=IssueRef`；`CreatedPr={kind:'pr',pr:PrRef}`，`CreatedIssue={kind:'issue',issue:IssueRef}`。持久责任引用 `Carrier={kind:'member',member:MemberRef}|{kind:'draft',draftId:DraftId}`；assignCarrier 的输入 MemberRef 或 DraftSpec 经 parser 区分后一次生成该引用。case subject 固定 request/effect/attempt，retryHost 不让 payload 覆盖它，旧 case revision 拒绝。SourceCondition、DraftSpec、Position、Amendment 的完整字段分别在生命周期与集成 C5 定义。

Main 无票据 noCode 是唯一业务例外，只限当前 unit pending 明确成员、新鲜 bodyHash/证据，不能吞 executing/uncertain mutation。相同理由/hash same；真实 merged 必须走 postMerge。noCode 理由本地保存，正文改变失效；真实 reopen 需要 restore/correction/revokeNoCode，不能自动关回去。

Amendment 为 designGap{affected,bodyEdits,route} 或 acceptanceMethod{affected,bodyEdits:NonEmpty,transfer}。验收义务转移必须有真实 transfer，不能删产品预期。BodyEdit 为 issue/expectedHash/body，实际源头基准不符拒绝并给当前 hash。defaultFirst 需 commit 已在同 repo default；withPr 绑定本成员；future 绑定同 repo 后续成员或 designOnly draft。design commit 真实被接受后形成精确 Carrier；carrier noCode/放弃且 default 未落地重开原转交 case。migration/agendaGap 必须能 include 既有 IssueRef，不能创建相似 issue 冒充原对象。

`correctDesign` 让 Main 先按 clauses 修正设计并以 defaultFirst 源头证明提交已经在 correction target repo 的 default。一个 Amendment 直接拥有该 DesignWork 和完整 insertion 意图；正文不是把 clauses 伪装成旧契约替换。真实 issue/create/attach、设计提交全部确认后，原子放置原 unit 的 correction Member，并把确切 DesignRequirement 交给新 carrier；旧 merged Member 不开工作、不改写原 accepted submission。普通 designGap 的 defaultFirst/withPr/future 不因此合并为一条路线。
