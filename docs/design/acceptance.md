# 验收条件

本文规定结果与否定条件。失败修产品或真实环境模型，不删合法组合、不加不存在的公平边。操作员禁止本轮新增或修改测试，并要求功能完整实现前不执行任何测试；下列条件仍须由实现完成后的真实入口、现有可用程序与独立 review 核对，不能用测试脚手架代替功能。证据必须钉最终源码 commit、实际宿主版本、对象与命令；生产代码或 prompt 变动后重新验证受影响完整路径及跨部件正常交付。验收不研究 GitHub API 上限，调用计费或 points 测量不是交付门槛。

## 需求映射

|ID / 来源|必须观察的路径与否定条件|
|---|---|
|R01 / delivering-issues 49–89、160–171|两 issue 严格串行；correction 在原 unit 内结束；前者验收/关闭前后者没有 owner 工作；parent 最后关闭|
|R02 / skill 91–96、briefs 23–75|fresh isolated owner、接管同 branch/PR、恢复未推送提交；独立 clone 不污染 Main checkout|
|R03 / skill 127–152、briefs 77–135|fresh 独立 review/accept、同 head；HEAD/base/契约变撤旧 job，旧 verdict 拒绝；驳回失败不等 pass|
|R04 / skill 154–158 + 程序合并决定|双 gate、required checks、exact closing/target/head、无未结工作/物化；新 HEAD 经 submit 接受后才 merge；真实 gh merge 带 match-head|
|R05 / skill 98–125|question/Main design、正文 CAS 冲突、验收方法转交、same-repo carrier/migration；原义务不消失|
|R06 / skill 160–169|每 repo 合并后验收与 parent 全 children；失败补项、含 noCode correction；merged children 不等 parent complete|
|R07 / skill 49–63、173–179|关闭/人工重开/noCode 失效/外人 merge、恢复确认、旧格式拒绝、晚到结果；外部事实不代系统声明|
|R08 / compact 与回复要求|compact 后完整 context；未答 mustRun yield 拦截；claim 后 mayWait 且不 wake；Main 未行动票据仍可见|
|R09 / 本地状态要求、事故报告 21–31|source 相同/observedAt 不同、重复当前回复、只读：bytes/version/mtime 不变且零 mutation；无协议评论/议程 issue/HMAC|
|R10 / ok-note 与模式要求|mode 外、非 holder、多派者/孙级无端口；verdict 仅 ok/note，程序 pin|
|R11 / 事故报告 33–43|正常路径 native wake 无 Main write/ACK；失败/未知可见 case；delivery receipt 不当工作完成|
|R12 / 报告 45–53|每个 Action 的成功/拒绝/失败/未知与 push/body/park 组合；不只 publish 失败；未回复不通过公平性自动完成|
|R13 / 报告 55–65|最终 commit/真实 host/对象的证据；改代码后重跑，不借旧 commit 成果|

spawn 是 Main 正常义务，R11 只消除 wake 的 Main 执行/回执，不虚构程序 spawn。Main 永不回答时票据 attention 可见，不承诺自动完成。native relay 不是回复/ACK。

## 本地公开路径

功能完整接入根 `index.ts`、controller、端口和包入口后，分别执行现有的检查与公开 API 程序，不创建新的测试文件：

```sh
bun run check
bun run tests/acceptance/public-api.ts
```

类型检查与纯 API 程序不能替代真实产品行为证据。已有独立 driver 不导入作者 fixtures、transition 私有 helpers 或旧 world/gamma；它只调用生产公开 API。真实 AgendaFiles 的恢复与最终文件结果必须另外从实际运行入口核对，不输出 env/token。不存在的测试或验收入口不得写成已经可运行。

必须有以下正负场景：

- adopted PR 没有 submit，分别因 conflict、failed check、upholdOwner、design requirement 打开 work；push h2/checks pass 后同 WorkId 且无 gate/merge；正确 submit 接受，远端 head 错/缺 commit 拒绝，confirmed publish 后才 gate。
- 已提交 PR、同 HEAD 证据修复、PR 关闭与 Main design、真实外部 merge、不同 repo 相同 SHA，保持精确归属；source 改变不自动刷新 accepted baseline。外部 merge 结束 Work 时写非回复终局结果，Main context/tickets/report 可持续观察 externallyMerged，不能产生伪 owner receipt。
- owner noCode/split/blocked/question claim 重复 park/timer 零 wake；Main 决定后同 WorkId/新 revision 自动 wake 一次。前置终点与设计生效最后 hold 解除各自动一次，正常 Main retryHost=0。gate claim 后 fresh job/holder，旧 verdict superseded。
- case awaitingExternal 条件成立 revision 加一重新 open，旧决定拒绝，新决定可受理；mainRelease 票据仍可解除。mustRun yield 拦截零 GitHub。
- gate question 经 answer/outOfDomain 后 fresh brief/stamp 保留现行答案；不丢无 bodyEdit 的答复。applying 在设计/body/draft 未确认前不 resolved；部分成功保留，最后直接孩子完成一次 resolved，owner 无循环依赖恢复。
- 每 Action：明确失败、响应丢失、确认读失败、执行后确认 durable 前退出；重启先查源头，无盲重复 create/merge/rerun。create 多候选/零候选保持 uncertain，Main 指定真实结果才继续。wake live 不证明旧 message 投递。
- orphan commit 转交 draft 后真实新 member 承载原 ShaRef，无关设计项不要求；carrier noCode/PR 放弃重新有入口；agendaGap includeExisting 插入原 child。
- parent/body/target/checks 同 HEAD 变化与近 merge preflight：变前提不写；merge 在途不交错同对象 body mutation。
- 真实 AgendaFiles：next 恰一次 durable replace，same/rejected 无写；坏格式/部分 JSON 拒绝；子进程写前退出、rename 后响应前退出只留完整快照；rename 后目录 sync 失败重试固定 envelope、不重 transition。
- defaultFirst/withPr/future、designOnly member、orphan 再失败、非默认 base 关闭窗口、case 回复前 body 变化、Main 不回答 attention 各有正负路径。
- typed occurrence 回归覆盖正文 h0→h1→h0→h1、每次 accepted owner 修复后的同一失败 check、旧 Main receipt 精确重放及 changed-source/stale revision 拒绝；既有 resolved case 不能吞掉新义务。terminal finding 的 correction/correctDesign 要有真实 create/attach/design/carrier/whole-unit/closure/report 终点，不对已 merged 原成员造 work。
- publication cancellation 保留准确 previous 关联和 AcceptedSubmission；advanced uncertain adoption 要分别覆盖 response-lost 与 returned-identity/confirmation-lost，head/title/body 前进、无权限/无交接/branch 不符/身份占用均有否定路径。新 owner submit 前旧 accepted head 不刷新，不把 cancelled child 当 Amendment 成功。
- native 工具边界完整 nested union，不只 registration smoke；strict `{input:PortInput}` 的五个 op、深层 decision、二元 question 与额外字段/非法数值拒绝需通过 actual host root z 和 canonical parser。root/每个 seat 的实际 model/thinking 均需记录且符合操作员选择，不能仅凭 agent 名称判断。


## 独立模型验证

模型直接运行生产 transition/tickets，环境动作来自真实端口能力。所有 Action 有 known failure/unknown/success-but-confirm-lost 边；所有 role 允许永不回复，不添加 Main 最终会行动的公平边。检查 safety：未接受 submit 不 merge、无源头确认不结束意图、失效输入不接受旧 gate；检查可观察进展：runnable 程序动作、已投递/可领取 mustRun、明确 waiting/attention。EF 有完成路径与必然完成分开，永久外部失败/模型沉默不承诺完成。

固定矩阵为 `owner response × source push × gate not-ok × effect failure/unknown × park/abort × body edit` 的 pairwise，另有 adopted+push+failure、claim+park+timer、contract+close+orphan 指定三元组。每类至少一次；到 cap 必须失败并保留最短轨迹，不能截断算通过。已发现合法反例保留固定 trace，不重命名为非法状态排除。真实无出口 stall 是失败，不能因为有 stall 票据就称进展成立。

## 真实宿主与 GitHub

使用现有 sandbox `RiriAgent/rt-e2e-20260930-0931`，actor RiriAgent。本轮对象 namespace 为 `rt-rewrite-<runId>`；既有 issue/PR/branch/file 不改不删，不创建新 repo。临时 HOME、agentDir、state、clone、overlay、gh shim 和输出均在 mktemp `/tmp/rt-rewrite-XXXXXX`。

owner launcher 启动/复用 owner-controlled auth broker，token 只在内存捕获并通过 OMP_AUTH_BROKER_URL/TOKEN 注入；不打印、不复制/链接真实 agent.db/models.yml/config.yml。清除 OMP_PROFILE/PI_PROFILE。child gh 使用 owner 的既有 GH_CONFIG_DIR；隔离 HOME 无法取得 keychain 凭据时，由拥有方 CLI 在内存取得同一 RiriAgent token，经 GH_TOKEN 注入，不改账号配置。专用 broker 只由本轮 launcher 关闭。所有圆桌 e2e 的 root 和 seat 只能使用操作员指定的 task:free 同款模型，或 `opencode-go/deepseek-v4.1-flash:low`；不允许其它模型或 fallback，也不改全局绑定。本轮选择后一种，root 用 `--model opencode-go/deepseek-v4.1-flash --thinking low`，隔离配置选择实际存在的 native `task` 角色，并以 `task.agentModelOverrides.task` 绑定相同 selector 加 `:low`。角色名称不证明实际模型，仍须核对运行记录。该选项有非零定价，但已由操作员明确授权；不能因之前免费-only 约束拒用它。

实际宿主入口为 `omp` 加 `-e <implementation-worktree>/index.ts`；隔离配置与凭据由既有 owner-controlled 启动路径注入。已有 `tests/acceptance/host-contract.ts` 只证明 HostPort 边界，不代替根插件的功能验收；不得为填补产品路径而新增测试或探针。

真实 CLI 使用上述已授权显式 model/thinking、--mode rpc、--no-ui、--no-session、--no-title、--no-lsp、--no-extensions、-e 实现 index.ts、隔离 --config、仅此实例 --approval-mode yolo。必要 provider 显式加载，不继承全局插件或备用模型。ready/get_state 后用原生 RPC prompt，模型真实调用工具推进；controller 不代答 Main/owner。另一次 TTY 实际 `/roundtable` 检查可见性。

host-contract 先证明 named exports、同一 registry Main/child、async isolated task、process singleton、工具激活、park/ensureLive/direct delivery、idle plan 拒绝、shutdown sessionManager 清理。缺 native API 是 host-contract failure，不用绝对源码/复制生命周期/Main ACK 替代。

完整 native 场景必须包含：

1. fixture 建 parent、普通 alpha、错误既有 PR 的 adopted beta、应 noCode issue；不手改插件 state。
2. Main 真实召集，alpha submit/publish/fresh 双 gate/merge/postMerge，alpha unit 结束前 beta 没 owner。
3. beta 实际 not-ok/owner 修复。专用 target base 配置真实 required check，workflow 只检查 `qa/<runId>/value.txt` 为 OK，直接 git fetch 当前 GITHUB_SHA，不钉 actions 版本。核 source rule/app identity，错误值拒绝 merge、正确值通过。不能 optional 替代；权限/平台不支持即 checks-native 阻塞。另正常 integration Member 交付专用 base 到 main，不 fixture 偷合并；closure 从 default 验证。最后删除仅本轮创建的 base 规则。
4. 修复 owner push 后先观察 accepted submit/publish；PR OPEN 且真实 owner idle（非 streaming）或 parked 时一次受控远端 push，程序自动投递同一真实 owner 续作并接受。不得合并后 push；自述 ACK 不算，核 state/source/registry。parked 路径还必须真实 ensureLive/rebind。
5. 真实 noCode/split/blocked/question；至少一个 claim 在 idle/parked 等待期间零 wake，决定后同 WorkId 新 revision 一次自动 delivery，无 retryHost。前置/设计最后 hold 解除也核验。受控改 gate 输入，旧 verdict 拒绝，新 fresh holder 生效；Main 不冒充子席位。abort 和 exact turn-end 的宿主续席/非响应独立于 GitHub 可用性；unchanged registry 不写文件。
6. 开放工作中退出完整 OMP 并观察 exit，新进程显式 resume，恢复同 WorkId、新 request、远端 branch 和 owner 未推送 commit。
7. 一次真实 postMerge not-ok，经 Main correction 新 issue 按协议交付；新 postMerge 覆盖原成员/修正；fresh parent closure、真实关闭、Main report/state completed。核 default bytes/closing links/merge SHA/issue 状态，不只工单计数。
8. 真实 GitHub 目标不匹配/closed PR 的 mutation 前提拒绝；权限/超时/结果丢失用 production controller + 真实存储的可控传输层注入，明确标集成注入而非自然 outage。

## 持续功能运行

功能实现后的持续运行覆盖 production controller、GitHubPort、真实 AgendaFiles 与公开端口，不以 timer 空转代替交付。固定十个有序 unit、一个 parent；持续覆盖 submit、双 gate、postMerge、push、not-ok、效应失败、正文变化、精确回复重放及实际进程恢复。至少一次创建结果丢失必须保持 uncertain，恢复不得盲目重复 mutation。已有验收程序不能覆盖时直接通过真实产品入口操作，不新增测试代码。

一小时运行中必须观察：

- 前序 unit 的成员终点、关闭和 postMerge 完成前，后序没有 owner 工作。
- tickets/context/yield/无内容变化 registry 与 accepted replay 不触发 GitHub；same/rejected 不替换状态文件。
- held seat 不 wake；同一 runnable 内容版本自动投递一次；失败和未知结果保持可见入口，timer 不重 mutation。
- 最终 default bytes、PR merge SHA、issue/parent 终态与本地 completed/report 相符。
- GitHub 没有协议评论、议程 issue 或回执写入。

这条路径不替代真实 native 模型席位的完整交付，也不承担 API 限额、GraphQL points、CLI 内部请求费用或账号剩余额测量。

## 交付证据

每记录含 code commit、host version、命令、消敏 input/output、必要 state/registry 投影、真实对象链接及最终 bytes。日志不能保存 env、token、headers 或完整凭据会话。runtime 证据按 writing-pr 进入新的真实 PR；review/acceptance 独立，不由同模块实现 worker 自验替代。所有路径完成前保持 Draft；缺环境必须明确“已改，未完成 runtime 验证”、具体缺口和可运行验证位置，不用 mock/旧成功/blocked 冒称完成。
