# core：简报、回复 schema 与 Decision 变体

[core.md](core.md) 的附件，逐项列出三样东西：每类票据的简报必须包含什么、每类回复的载荷 schema、`Decision` 的全部变体。

- 简报模板与 schema 由 core 持有，`realize` 与 `step` 使用它们。
- 它们承接 delivering-issues skill 的 briefs 内容；这里没有列齐之前，skill 原文不删除。

## 所有简报共有的身份块

每一份简报（席位与主会话）都以身份块开头：
- 票据 id、票据种类、context、pin（规范化后的完整内容）；
- 席位票据另有请求名与工作目录；有 parent 时附 parent 链接；
- 完结方式：调用哪个端口操作，提交哪种回复。

## 席位（owner、gate）简报共有的块

主会话简报不带以下各块：主会话本身已经持有这些策略与规则，它的简报在身份块之后只写「圆桌是唯一的协议渠道」、事实、可选的裁定与要求，以及回复模板。

- **分工**：
  - 只对自己的票据负责，不与其他席位就协议事务交流。
  - 契约问题只能用 `Claim(question)` 提出。
  - 不向操作员提问。
  - 设计权威文件只由主会话修改。
  - 不用 `gh` 或其他客户端写 GitHub（评论、编辑、关闭、合并都不行）；可以用 `gh`、`issue://`、`pr://` 完整读取 issue、PR、评论、checks 与图边。git 的提交与推送照常用原生命令。
- **策略原文**：`realize` 当时读到的 `APPEND_SYSTEM.md` 全文，以及系统提示中的 `# Engineering`、`§ Workflow`、`§ Delivery`、`§ Critical`、`<generic-rules>` 各区块，逐字附上。
- **工作目录**：`/tmp/omp-roundtable/<owner>-<repo>-<issue>/<请求名>`。在这里基于远端提交另建 clone 或 worktree，不在继承来的隔离工作区里改动。
- **目标 repo 规则**：先读目标 repo 的 `AGENTS.md`、`CLAUDE.md` 与 rules。
- **证据**：回复必须把证据写进载荷本身。`local://` 只存在于本会话，其他会话读不到，不能作为回复中的证据；不限制长度。

## 各类简报的专有块

| 票据 | 必须包含 |
|---|---|
| `deliver`、`fix` | 交付目标（repo、base、起点 SHA）；要接管或沿用的 PR 与分支；需要合入的设计 commit；需要通读的 issue 与设计章节。PR 正文按 `writing-pr` 选模板：纯文档 PR 用思路要点模板；其他 PR 用四层证据，Layer 2 读回关键行，Layer 4 逐条经真实入口观察正负路径，测试计数只放卫生检查。`fix` 另附触发原因与结论或裁定原文。说明新 HEAD 不消费维持修复，只有 PrSubmit 被接受才完结；Main designFix 未回复时暂停 owner 交付，等票据恢复。续作先检查未推送提交；推送被拒不强推，回复 Claim(blocked)。自己的主张等待裁定时可以 yield |
| review | PR、HEAD、base。按 `review-pr` 依次跑 Gate 1–5，首个失败即停。以 issue 契约为准，不扩大范围；不派审查子代理。此前被驳回、且没有新证据的问题不再提出。问题落在主会话的 commit 上时，在理由里写明 |
| accept | 在干净的 detached checkout 上确认 HEAD。经真实入口逐条观察验收行的正负路径：纯库在仓库外自写 driver；CLI 用真实命令；Web 走 `skill://agent-browser`；纯文档核对文档间的语义。不复用作者的 driver 与测试，最后跑 repo 校验，不改 repo |
| postMerge | 对每个交付目标 repo 分别执行。最新的合并发生在议程召集之后时，在该合并提交的干净 checkout 上执行（R5）；发生在召集之前时（遗留项），在当前默认分支 head 的干净 checkout 上执行，该 head 必须包含合并提交。部署型 repo 在 repo 交付规则规定的目标环境里执行。经真实入口逐条观察覆盖成员的验收行，并跑 repo 校验。与本次无关的失败写在理由里，写明为什么无关 |
| closure | 对每个交付目标 repo，在包含该 repo 全部合并提交的默认分支 head 上，经真实入口逐行核对 parent 的关闭验证，并核对每个子 issue 的终点事实 |
| Main `decide(*)` | subject 对应的回复原文与证据；`effectFailed` 附这次执行失败的错误原文；该 subject 可选的 verdict 及各自的后果；需要替换的正文段落及其当前哈希。设计路线的适用条件：`defaultFirst` 仅在 umbrella 或 repo 约定契约修正先落默认分支、且 repo 规则与权限允许直接提交时可选，推送被拒时改选其他路线；`future` 需要同 repo 的后续承载者，没有就附设计承接项的草稿 |
| Main `designFix` | 当前 attempt 被维持的结论；交付目标 repo/base 与起点 SHA，即使没有可维护 PR。回复真实修复 commit（可引用已经解决设计点的既有契约修正 commit，不造空提交）；Main 回复前没有 owner deliver/fix，回复后由 owner 提交包含所需 commit 的 PrSubmit，再执行 gate |
| Main `spawn` | 先执行，再回执。registry 中已有请求名匹配、而且不是状态里记录的持有者的可用 agent 时，直接回执；否则用原生 `task` 派出，参数为：`agent`（设置给出的席位 agent 类型：owner 默认 `task:high`，gate 默认 `task:mid`）、`isolated: true`、`name` 取请求名、assignment 取简报。前提：宿主设置 `async.enabled` 为真，并且该 agent 类型没有声明 `blocking: true`，否则主会话会同步等待子席位，席位提问时就会死锁。派出后用 `Decision(seated{agentId})` 回执，agentId 取 `task` 返回的实际 id |
| Main `report` | 每项的结局，以及 PR 与 issue 的链接、各验收结论的要点；树关闭的结论；意外写回主会话工作 checkout 的路径。报告由主会话在对话里交给操作员，不写到 GitHub |
| 所有主会话简报 | 圆桌是唯一的协议渠道。子席位 `yield` 时的文字会作为原生消息送达主会话，但它不是回复，不据此行动。末尾给出这张票据的完整回复 JSON：pin 决定的字段由程序填好；需要在整个对象之间选择的 `verdict` 给出一个合法默认值，并列出每个可选对象的完整 JSON；主会话只替换 `<…>` 字符串占位，question 的 `affected` 由主会话列出受影响的成员 |

## 回复载荷 schema

| 回复 | 必填字段 | `step` 额外检查的项目 |
|---|---|---|
| `PrSubmit` | 分支、观察到的 head、标题、正文、PR 模板类型；非首次提交时加重试说明 | 远端分支 head 等于观察到的 head；base 等于交付目标；head 包含应合入的设计 commit |
| `Claim(question)` | 最小复现（`path: bytes`）、两种读法及各自的权威出处、最早缺信息的环节、建议 | — |
| `Claim(noCode \| split \| blocked)` | 证据；拆分提案；阻塞类别与已尝试的途径 | — |
| `Verdict` | `ok`（通过或不通过）；`note`：理由，不通过时写清问题、位置与复现方式。gate 席位只回复这两项；accept、postMerge 与 closure 的 `ok` 表示每一条验收行都通过 | 无；gate 取自票据种类，head、合并提交等事实是票据的 pin |
| `Decision` | subject、verdict，以及该变体要求的字段（见下表） | verdict 属于该 subject；设计路线满足适用条件；正文替换的基准哈希等于当前哈希；`orphanDesign`、`migration`、`agendaGap` 的 `resolved` 附至少一份草稿 |

所有回复里的输入清单都由程序按 pin 盖入，席位不填写。

## Decision 变体

| subject | verdict |
|---|---|
| `claim(question)` | `answered`、`outOfDomain`、`implDefect`（产生 owner 待修复项，只适用于成员 context 的问题）、`designGap(route)`、`acceptanceMethod`（须附正文替换，对象是问题所涉验收行所在的 issue：成员 context 为该成员，单元验收为该单元的成员之一，树关闭为 parent） |
| `claim(noCode)`、`claim(split)` | `confirmed`、`refuted` |
| `claim(blocked)` | `replacePr`、`external`、`refuted` |
| `findings` | 对这条不通过的结论给出一个裁定：`upheld(owner \| main)`、`rejected`、`outOfScope`（附草稿）、`designGap(route)`、`acceptanceMethod`（须附对该成员的正文替换） |
| `closed` | `confirmedNoCode`、`reopen` |
| `reopened` | `restore`、`correction`（附草稿）、`reopenAccepted` |
| `checks` | `rerun`、`fixNeeded`、`external` |
| `postMergeFail`、`closureFail` | `correction` 或补项（附草稿）、`reverify` |
| `orphanDesign`、`migration`、`agendaGap` | `resolved`（必须附补项草稿，受理不证明源头事实已满足）、`external`（当前主题进入等待，报告操作员及对应源头解除条件） |
| `effectFailed` | `retry`、`external` |
| `stall` | `external`（正文冲突由操作员恢复基准或设为目标解除），或附补充事实；正文冲突的 `resolved` 附以当前正文为基准的新替换 |
| `designFix` | 设计 commit |
| `report` | 汇总 |
| `seated` | 实际 agentId：该 agent 是待回执的 agent（持有者不可用时，registry 顺序里第一个在 registry 中、不是 aborted、去掉后缀后等于请求名、不是持有者的 agent） |
| `noCode`（主会话不持票据，主动提出） | `confirmed`（附理由） |
