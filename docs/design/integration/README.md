# 集成连接

本模块定义 GitHub、文件、native Host 与插件边界。协议对象及决定在 [protocol](../protocol/README.md)，结束与恢复在 [lifecycles](../protocol/lifecycles.md)。所有外部输入在入口 parse 为命名类型，端口返回 `Result<T,PortError>`；不能以空 facts、空 policy 或 JSON cast 隐藏失败。

## C1 完整源头读取

GitHubPort 提供 facts、contains、branchHead、issue、pr、openPrsByHead、issuesCreatedSince、createIssue、addSubIssue、editIssueBody、setIssueOpen、createPr、editPr、mergePr、rerunCheck 及 checkAttempt(repo,workflowRunId)。所有 repo 身份完整保留。contains 仅缓存成功解析的 immutable repo/ancestor/descendant；缺失 commit 不缓存为永久 false。

Facts 是只读命名 record 数组：
- viewer 是本次完整查询返回的真实认证账号；createIssue action 保存这个账号作为 accepted intent 的 actor。恢复候选查询核对同一 actor/title/body/repo/attempt 时间，不写死本地 CLI 账号。


- IssueSnapshot：ref/body/bodyHash/updatedAt、state open|closed、lastClose/lastReopen LifecycleEvent|null、children IssueRef[]。
- PrSnapshot：ref/headRepo/headBranch/head、target repo/base、body/bodyHash/updatedAt、state open|closed|merged{sha,at}、closes、mergeable yes|no|unknown、ChecksSnapshot。
- RepoSnapshot：repo/defaultBranch/defaultHead、bases BaseSnapshot[]；base 是 missing|present{head,isDefault,rules:MergeRequirements}。
- BranchSnapshot：repo/name、missing|present{head}。
- CommitObservation：repo/ancestor/descendant、contains|notContained|missing。
- maintenance 与轻量 closing links 独立保留。MaintenanceObservation 为 maintainable{basis}|foreign{basis}|unknown{reason}；basis 含 head repo/branch、viewerPermission、author/maintainerCanModify、system-created association 或明确作者授权。权限足够不等于交接，unknown 不通过 adoption。

ChecksSnapshot 是 passing{required:RequiredCheckIdentity[]}|failing{required:NonEmpty<CheckFailure>}|pending{required:NonEmpty<PendingCheck>}|unknown{reason}。它只表达此 HEAD 的目标 base 真正要求的 checks；optional 失败仅诊断。完整规则证明无 required 才 passing 空数组。RequiredCheckIdentity 保留名称及 app/source 约束，不能同名冒充。MergeRequirements 保留 strict/upToDate 与其它有效源头约束。

CheckFailure 分 actions{checkRunId,workflowRunId,jobId,runAttempt,head} 和 status{context,sha}。Actions 映射以结构化 checkSuite.workflowRun/真实 actions API 校对，不把 CheckRun.databaseId 当 workflow runId。status/其它不可重跑 app 没有 rerun 动作。
SourceScope.repos 是 `{repo,bases:string[]}[]`，不能只有 repo 名称。convene 即使没有 adoption PR，也必须显式读取每个 Entry.target.base；源头 null 表示 missing，字段缺失/不完整不是 missing。相同 repo/base 合并去重，default 及其规则单独保留。

available 相对于当前协议状态的完整读集成立：所有 Member/parent、已登记 Draft/待挂接 child、相关 PR/branch/目标 base、当前 gate pin、所需 design/merge/default ancestry，以及相应 workflow attempt/create recovery query 都必须覆盖。新对象或新回复引入读集时先补读再 observe；不能把一次局部成功结果或旧 generation 冒充当前完整输入。


完整 scope 与每个连接分页后才 available。GraphQL partial error、必需节点 null、缺页、读规则失败不得伪造空 children/closes/checks；不能完整读取的连接明确返回 sourceUnavailable。批量 alias 只减少重复读取，不承担 API 上限验收。查询包括 active repo/org rulesets 与 classic branch protection，保留 source integration/app identity。

## C2 当前状态文件

AgendaFiles 保存 `{format:3,state:Agenda}` 到 `<dataDir>/state/<agendaId>.json`，权限 0600。load/list 完整 parse；format 1/2、坏文件、缺失分别 unsupportedFormat/corruptState/notFound。不迁移、不删除、不从 GitHub 重建本系统工作。

save 比较 expected version，写同目录临时文件、文件 fsync、原子 rename、目录 fsync。same/rejected 不打开写文件。写入重试固定 envelope；rename 后 durability 不确定按生命周期恢复表处理，不重新 transition。单 writer version 校验不承诺多进程 CAS。mode 进入时 parse 整个 state 目录，不建 active.json；零 active 可 convene，一个 active 提示显式 resume，多个 active ownershipConflict。

## C3 真实 Host 连接

HostPort 每次观察 native registry。只通过宿主包路径 named exports 导入：

HostObservation 含 runId、Main 身份、精确 registry rows 与当前可用 session 的 plan/streaming 观察，另有本 run 内存中的 `turnEnds:{agentId,runId,messageId}[]`。后者来自该 holder 的真实 agent_end，只索引本 controller 已投递且回合已结束的当前 message，不是 registry 推断或完成事实；重启丢失，旧 run 按生命周期恢复。agent_end hook 只更新内存观察/显示，另排独立 hostObserved turn；回调本身不读 GitHub、不写 Agenda。exact message 在真实 delivery 调用前登记，快速回合结束即使早于 confirmation 落盘也保留。无 session 的 parked plan 退出不能猜测，Main retryHost 时 ensureLive 后实际 precheck 决定，不改模式。

```ts
import {AgentRegistry,MAIN_AGENT_ID} from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import {AgentLifecycleManager} from '@oh-my-pi/pi-coding-agent/registry/agent-lifecycle';
import {cfgAsyncEnabled} from '@oh-my-pi/pi-coding-agent/tools/settings';
import {cfgTaskIsolationEnabled} from '@oh-my-pi/pi-coding-agent/task/settings';
```

禁止绝对安装源码、包副本 singleton、自建 bus、irc/bus wildcard fallback。native 对每席位重新执行 extension module graph；process slot 必须是 `globalThis[Symbol.for('omp-roundtable.runtime.v3')]`，不能依赖模块变量或跨 graph 的 constructor instanceof 身份。运行中不热换旧版。绑定按 agentId/sessionManager，park 恢复后重新绑定。

convene preflight 读取真实 Main registry session，要求 async.enabled=true、asyncJobManager 存在、task isolation=true、effective agent 非 blocking、Git cwd 存在。缺项 refuse，不降同步/non-isolated。effective agent 必须按真实 discovery 优先级确认，不只读某个同名 markdown。

wake 先核 exact request/run/parent/holder、非 aborted，再 await ensureLive。返回真实 session 后同步检查 plan/streaming，idle plan-mode 产生 hostPrecondition，不代改模式；检查与调用之间不插入 await。随后 `deliverIrcMessage({id:EffectId+attempt,from:MAIN_AGENT_ID,to:agentId,body,ts:executing.startedAt})`。返回 literal injected|woken 是本次 delivery receipt，不证明 turn 已开始、工作完成或 exactly-once。不 await sendUserMessage 代替 direct delivery，避免 controller 等 child、child 等 controller 的环。

native relay 的自述不是端口回复/ACK。HostPort 不用 registry live 对旧 messageId 作 effectSatisfied。未知 wake 与显式 retryHost 按生命周期异常规则处理。

## C4 统一动作执行

Action 闭合为 publishPr、createIssue、attachChild、replaceBody、setIssueState、rerunChecks、merge、wake。一次 controller turn 处理一个当前 ready effect，不推导整批旧 action 后逐个执行。

1. 读当前 Agenda 与该动作执行时源头。仅可查询动作目标已满足时 effectSatisfied，不发 mutation。
2. 前提戳变化则合法取消未发送意图并 observe；不消费 owner 工作。merge 重新核 PR/issue/checks/contract/design containment、gate stamps 与所有前序 unit 终点。
3. effectStarted/attempt/startedAt durable 后真实调用一次并等待。
4. GitHub 响应后再 source confirm；确认读失败为 uncertain。Host direct delivery 返回即本次 receipt。确定拒绝为 failed，未知写结果为 uncertain；不开自动 mutation retry。
5. confirmation durable 后失效受影响对象/ repo 的读数，合并重读并 observe 至 same。同状态签名重复却 next 是程序错误，不用任意迭代上限掩盖。

|Action|完成判据|响应丢失 / recovered executing|
|---|---|---|
|publishPr|exact PR/headRepo/branch/target、actual branch head、accepted head/title/渲染 body 全匹配，维护与本系统独占关联有效|received identity 不能换成另一 PR；无 identity 时仅唯一全字段 OPEN 匹配自动确认。多候选 uncertain；Main 显式关联已前进候选按生命周期风险例外，不自动接受新 head/正文|
|createIssue|本 attempt 返回真实 IssueRef|按 repo/actor/title/body/startedAt 全分页候选查询；即使唯一也 uncertain，Main adoptResult；零候选也不自动 create；retryAfterAbsence 绑定刚完成的无候选查询与一次重复风险授权|
|attachChild|parent children 含 exact child；action.owner 精确指向 draft 或既有 insertion 决定|已在则确认；failed retry 前重查；uncertain 不重发。确认前不放置 Member，不能以同名新 issue 代替原 child|
|replaceBody|源头 hash 等于 target；仅 expectedHash 相等才写|target 已在仅确认；其它 hash 冲突 Main rebaseEdit，新 expectedHash/body 替换意图，不覆盖后来人工文本|
|setIssueState|状态及生命周期事件顺序符合决定预期|新于裁定的 reopen/close 取消旧动作并开新 case，不机械关回去|
|rerunChecks|exact PR 仍 OPEN 且 head 匹配，实际 workflow/run/attempt 与 action 对应；同 run 新 attempt 大于准备基准|API accepted 不是新 run；无证据 uncertain，不盲 rerun，旧 head 的 run 不能授权当前 PR 重跑|
|merge|exact PR/head/target 的真实 MERGED、取得该 repo merge SHA/时间|不同 head/target 的最终 merge 不算本意图成功；closed-unmerged 或最终不适用可取消；仍 OPEN 且未知保持 case、不重发|
|wake|ensureLive 与 direct delivery 返回|无查询 delivery API；当前 run 未知不凭 live 确认/重投；binding 失效/工作实际消费合法取消，旧进程退出新 run 续作|

PR body 只在新 submit/设计署名变化产生 publishPr；无 pending publish 的人工 body 编辑只撤销 review，不覆盖。pending publishPr 或 replaceBody 的源头 hash 非前置也非 target 时，Effect 记录确定 precondition failure，建立精确引用 EffectId 的 effectFailure case；bodyConflict 只是该失败理由，不是新增 Case subject。rebaseEdit 核当前 expectedHash 后原子替换同 Effect 的 action target/body 前提并回 ready，Case applying 直接等它；AcceptedSubmission 不变，Main 显式发布修订可保留人工文本。存在 uncertain 写入时先确认/合法取消，禁止借 rebase 重发。

GitHub 没有跨 issue body/PR body/checks 的原子 compare-and-merge。preflight 后使用 `--match-head-commit` 和 branch protection，不用 --admin，不承诺完整 manifest 零 TOCTOU。成功 CLI exit 可能只是排队，必须核源头 merged。本进程 merge 在途时不对同对象执行 contract/body mutation。正文替换也有跨客户端读后写窗口，不承诺平台串行事务。

非默认 base closing links 为空时，仅显式 publish/adopt 且渲染正文验证恰好一个 closing issue 的本系统关联可用；不匹配外国 PR。merge 后独立 setIssueState 关闭 issue。mergeSha 在其 base containment 验证；设计和 closure 要求 default 时必须另查 default，不能由 target base 合并推断。

## C5 公开端口与精确 parser

```ts
type ToolParameters = {input:PortInput};
type PortInput =
 | {op:'convene';mode:'plan'|'execute';parent:IssueRef|null;entries:readonly Entry[]}
 | {op:'resume';agenda:AgendaId;operatorConfirmedOriginalSessionEnded:true}
 | {op:'tickets';agenda?:AgendaId}
 | {op:'noCode';member:IssueRef;bodyHash:Hash;reason:string}
 | {op:'reply';ticket:TicketId;revision:number;reply:ProtocolReply};
type Entry={issue:IssueRef;target:{repo:Repo;base:string};designOnly:boolean;adoptPr:PrRef|null};
```
工具名只有 `roundtable`，其 parameters 为 strict ToolParameters；内层每个 PortInput/reply/decision 分支也 strict。`{op:'tickets'}` 不是工具根参数；工具调用形状为 `{"input":{"op":"tickets"}}`。native 自己附加并在 dispatch 前移除的 intent 元数据不进入 PortInput/Agenda。

`buildPublicGrammar(z)` 只定义一份公开语法。canonical 运行时 parser 使用直接依赖 `@oh-my-pi/omptype/zod`，插件用宿主 root z 重新构造完整 nested grammar；两边不传递 schema 对象，不混入 Zod4、不建 opaque JSON bridge/optional-field bag。execute 对 unknown 参数用 canonical parseToolParameters 一次构造精确 ToolParameters，再把其 input 交 controller；纯库 parsePortInput 仍只接收内层协议。strict-object、safe integer、SHA/hash/ticket 格式与恰好二元 question readings 在运行时校验；宿主 wire schema 未展示 regex 不代表 canonical 放宽。


convene 完整校验 source、去重、base、adoption、parent 和宿主前提后才 execute 创建；plan 只返回检查，零文件写/Effect。nested 不能改 active。tickets 显式 agenda 精确读取，不存在 notFound，不回退 active；省略只用本 session 明确 selection，或恰一 active，否则 agendaRequired。convene/resume/显式 tickets 成功才改 session selection，此索引不持久化、不重启 timer。

ProtocolReply 为以下 closed union，额外字段拒绝：

- submit{branch,head,title,body,template:'fourLayer'|'docOnly',retryNote:string|null}，只答 owner Member work。
- claim{claim:question|noCode|split|blocked}，只答 work/gate。question 有 reproduction、readings:[string,string]、earliestGap、proposal；其它为 noCode{evidence}、split{proposal}、blocked{category,attempts}。
- verdict{ok:boolean,note:string}，只答 gate，程序盖 kind/pin，不接受模型提供 head/行/commit。
- spawned{agentId}，只答 spawn；designCommit{commit:ShaRef}，只答 Main DesignWork；report{summary}，只答 ReportWork；decision{decision:CaseDecision}，只答 case。

Insertion 为 existing{entry,position}|draft{draft:DraftSpec,position}。Position 为 before{unitId}|after{unitId}|correctionOf{unitId}|outsideAgenda。DraftSpec 的 repo/title/body/target/designOnly 完整，repo/target 一致、非空、锚点存在，拒绝重复成员/修正环/跨 repo carrier。所有 CaseDecision 变体在协议文档定义，不兼容旧 payload。

## C6 输入戳与新回复读集

戳保存完整结构化 record，再 canonical sorted values/SHA-256 比较；不能只存 digest。generation 不代表 GitHub 原子快照。

|job|基准|
|---|---|
|review|PR ref/accepted head/target、PR body hash、issue ref/body hash、contract revision、required ShaRef、review 当前驳回/问答集合|
|accept|review 去 PR body/review 裁定，改验收自己的现行集合|
|postMerge|unit/member 身份、各 repo merge SHA/指定验收 commit、成员 bodyHash/contract revision/ShaRef、scope 现行问答分类；遗留 default 前进只验包含旧基准|
|closure|parent ref/bodyHash、全部 child refs/源头终点或本地 noCode 基准、全部 unit job/pass 身份、各 repo 验收 commit/ancestry、未落地设计集合、scope 现行裁定|

新 submit 必须刷新 branch/PR/target/design containment，fork branch repo 从登记 PR 的 headRepo 得到，新 branch 用 target repo，payload 不选 repo。gate 必须刷新自己的全部 stamp 源头；postMerge 包括 merge/issue 终点/指定 ancestry/body；closure 包括 parent/children/repo heads；契约/closed/reopened/source 决定包括精确 subject/body/route。controller 对这些源头依赖的新回复读取当前完整集合及新输入引入的引用；不把旧缓存补成“新鲜”完整输入。claim/spawned/report 只本地/registry；准确 replay 鉴权后本地 receipt，均零 GitHub。刷新失败拒绝且不消费工作。
fork head 的设计包含关系仍按 required ShaRef 所属 target repo 向源头 compare。headRepo 与 target repo 不同，即使 SHA 文本相同也必须有该 target repo 的显式 ancestry observation；不能以 fork 名称、权限或 SHA 相等替代。completed report receipt 的身份只要求当前真实 Main，精确重放不受旧 Agenda.run 限制，不改完成文件或启动 timer。


## C7 调度与只读缓存

controller 缓存最近完整 FactRead 仅供 tickets/context/yield；失败失效对应 scope，不用旧 pass 放行。没有完整 facts 则 sourceUnavailable，由初始化/定时/新完成回复取得，不由 yield 偷启动网络。

默认每 120 秒完整事实轮询。ctx/tickets/agent_end/yield/accepted replay 与无内容变化 registry 均零 GitHub、零文件写。registry、turn-end 与新本地回复只排独立 hostObserved macrotask；无变化返回 same。hostObserved 刷新真实绑定、owner same WorkId/new Request、requested gate same stamp/new Job/new Request、失效通知及精确非响应 case；通知资格只取只读 Ticket 投影，不以缓存推进 GitHub 业务或解除业务 hold。所有后台 turn 先核宿主生命周期，因此 GitHub 失败不阻止续席。source 相同只有 observedAt 变化返回 same。一次 controller turn 处理一个当前效应，后续效应独立排队并重新 preflight；准确 replay 与只读查询不主动执行 hostObserved。

只向 runnable 且 native idle（非 streaming）或 parked 的 holder 自动投递，每个 `(workId,contentVersion,holder,runId)` 或 `(jobId,holder,runId)` 一次。idle 保留真实 session，parked 需 ensureLive；不要求宿主先 park，也不代改 task TTL。spawn assignment 不冒充本次 delivery receipt。相同版本投递后真实回合结束仍未回复，hostObserved 建精确 hostPrecondition.seatNonresponse；实际 terminal reply 消费义务可取消已无用途的通知意图，但不声称旧消息已投递。已接受的 host recovery 不反过来阻塞它直接等待的 wake，其它工作/case/依赖仍阻塞。timer 不无限启动回合。Main 每新 ticket/revision 每 run 提醒一次；未回复一轮后 ui.notify/tickets attention，不伪造进展。

## C8 席位简报、身份与工作目录

完整 brief 每次 context hook 注入，compact 后仍齐全。长 policy 不让 Main 抄进 task assignment。短 assignment 固定为“圆桌席位 <requestName>；完整票据由 context 注入；先调 roundtable tickets，再按票据工作”。生产 owner 默认 task:high、gate task:mid；所有圆桌 e2e 的 root/seat 仅用操作员指定 task:free 同款模型或 opencode-go DeepSeek v4.1 Flash:low，测试 override 只作用隔离配置，不改全局、不加其它 fallback。

Policy 取 Main 最新 before_agent_start 原文，Engineering/Workflow/Delivery/Critical/generic-rules 整块保留；getAgentDir 下 APPEND_SYSTEM.md 存在则逐字附入，不存在保留实际 systemPrompt 的 appendix 原文；读错 sourceUnavailable，不空策略。before_agent_start 的 systemPrompt 是 string[]。

brief 必含：ticket/revision/context、issue/parent 链接、repo rules、准确远端起点/工作目录、完整策略、owner 全预期与 PR 四层证据/重试要求、review Gate1–5 与现行裁定、accept 独立真实入口/干净 checkout、postMerge 全 unit/指定 commit、closure 全 child/parent 行、Main 设计依据及每个允许回复 JSON。只删除已覆盖的协议评论/复杂 verdict/手工 merge-wake，不削弱角色要求。relay/yield 文本不是协议回复。

候选匹配 exact requestedName 或 native 数字后缀，仅用于发现。按 createdAt 升序、同时间 registry 顺序选唯一，已有可用 holder 不被第二名覆盖。注册后 Main 回执前允许唯一候选答其工单，但鉴权必须核 session/parent/run/request；多派者/孙级不可见。已有 pending 候选 Main 只 spawned 回执、不再 spawn。

目录根为 `/tmp/omp-roundtable/<agendaId>`：owner `/members/<memberKey>/owner`；review/accept `/members/<memberKey>/gates/<jobId>`；postMerge `/units/<unitId>/gates/<jobId>`；closure `/agenda/gates/<jobId>`；Main design `/design/<workId>`。跨 repo gate 各建 clone，不取第一个 repo。owner 从远端独立 clone，不改继承 isolation checkout；续作保留未推送提交，拒绝强推。owner request 跨工作复用，abort/新 run 才换；gate 每 Job fresh。

## C9 插件模式、运行与错误

根 index.ts 默认导出 ExtensionAPI factory，以宿主 root z 构造 strict `{input:PortInput}` 的 defaultInactive `roundtable` 工具。Main slash `/roundtable`/off；Main 可全部公开操作，owner/gate 仅 tickets/reply。session_start/before_agent_start 按 active request/session/run 更新 getActiveTools/setActiveTools；tool_call/execute 仍拒绝越权。mustRun child 的 yield 拦截返回完整票据，held mayWait 可退出；普通最终文本没有 yield hook，agent_end 不消费义务。registry.onChange callback 同步触发，异步 controller 工作必须显式处理错误；宿主 pi.sendMessage 返回 void 时只依原生报错通道，不能宣称 durable reminder receipt。--no-ui 下 ui.notify 不显示，attention/tickets 仍需可见。

设置通过 native typed registry 的 `roundtable.recomputeIntervalSeconds`（默认 120）、`roundtable.dataDir`（默认 `<getAgentDir()>/omp-roundtable`）、`roundtable.ownerAgent`（默认 task:high）、`roundtable.gateAgent`（默认 task:mid）读取，对应 OMP_ROUNDTABLE_RECOMPUTE_SECONDS/DIR/OWNER_AGENT/GATE_AGENT。handle 读取实际 Main session.settings；同进程每个 id 只注册一次，不读全局 harness cfg 或靠 prompt 猜配置。依赖正常包管理解析，不钉宿主版本。package 保留当前发布版本/CI，发布 index.ts，声明 omp.extensions:['./index.ts']；strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes 全开。

PortError.kind 为 permission|rateLimited{resetAt}|unavailable|precondition|invalidResponse|uncertainOutcome，保留消敏上游内容。读失败不等空集合；写超时不等确定失败。认证/存储故障显示运维原因，不让 Main 编造业务裁定。native required export/API 不可用是 host-contract failure，不 fallback 到旧源码/副本 bus。
