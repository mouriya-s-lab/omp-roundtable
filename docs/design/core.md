# core 设计

## 0 定位

- **层级与元素**：L3 component `core`，上级为 [omp-roundtable.md](omp-roundtable.md)。读者：core 的实现者、规则维护者。审批者：操作员。
- **要决定的事**：给定一次存储读数和宿主观察，推导出哪些义务应当存在，以及哪些回复可以写成事实。
- **本文决定**：领域类型、`Situation` 与 `Witness`、规则与守卫、尝试身份、效应、回复准入、验证方法。
- **不在本文决定**：
  - 记录的线上格式与签章，归 store；
  - 投递、注入与 `yield` 拦截，归 seat adapter；
  - C1–C5 由上级 §4 给出；
  - 简报字段与回复 schema 放在附件 [core.briefs.md](core.briefs.md)。
- **非目标**：core 不做 IO，不读时钟，不生成随机数。

输入衔接：需求来自上级 §1 的 R1–R20；抽象来自上级 §3；契约来自上级 §4。

## 1 输入与域性质

`classify(snapshot, host)` 有两类输入：存储读数与宿主观察。

**`Snapshot`**（C1）

- **议程**：
  - 召集清单：不可变；每项带召集载荷，包括交付目标（repo 与 base）、是否仅设计、要接管的 PR。
  - `Decision` 中的插入。
  - 议程 issue 的创建时间；议程 issue 自身带「议程」记录标记，不算交付对象，也不算 parent 的子 issue。
- **issue**：
  - 状态，以及关闭与重开事件（id 与时间）；
  - 正文哈希；
  - 正文中隐藏块里累积的已应用裁定标记；
  - 从正文验收表解析出的验收行 id，形如 `<owner>/<repo>#<issue>/<行号>`，因此跨 issue 全局唯一；
  - 父子图的边。
- **PR**：
  - 状态、head、合并提交、目标 repo 与 base、正文哈希、已应用的 `PrSubmit` 标记；
  - `mergeable: yes | no | unknown`；
  - `checks: pass | fail | pending | unknown`，以及当前失败的 check run 的 id 与最近一次 check run 的创建时间；
  - closing 引用中的 issue（合并后同样保留）；
  - 是否带本议程的来源标记。
- **commit 事实**：记录中引用的每个 sha 是否在默认分支上、是否包含在某个 PR 的 head 里；以及提交之间的包含关系。
- **签章有效的记录**，按写入顺序排列，每条带写入时间。

**宿主观察 `host`**：`seats` 与 `policy` 由 adapter 每轮向宿主查询，不作保存；`execution` 是本进程记下的效应失败时间。

- `seats`：registry 里的每个 agent，含实际 id、请求名（去掉末尾 `-\d+` 后缀）与状态 `live | parked | aborted`。
  - 某个请求名下，由最近一次 `seated` 回执指向、且状态不是 aborted 的 agent，就是该席位的持有者：持有者为 live 或 parked 时，席位分别为 `live` 或 `parked`；没有这样的 agent 时，席位为 `absent`。
- `execution`：本进程内每个效应每次执行失败的时间。重启后为空，等于重新尝试。
- `policy`：简报要附带的策略原文。它只进入 `realize`，只影响简报内容，不影响 id 或 pin。

**域性质**：
- 读数只代表读取那一刻；`unknown` 与 `pending` 是独立的状态。
- 正文版本用哈希表示。
- git 的提交与推送是席位的原生操作；GitHub 协议对象只由程序写。
- 所有 agent 共用一个 GitHub 账号，「作者是谁」不构成归属事实。
- 默认分支会不断前进，所以 pin 只能用不会移动的提交，有效性用「包含」判断，不用「相等」判断。

## 2 驱动

- **可穷举**：规则只读有限类型 `Situation`（上级 Q6）。
- **确定性**：同一输入给出同一输出；恢复与正常路径是同一个函数（Q2）。
- **无陈旧合并**：合并只在全部守卫满足时出现（Q3）。

## 3 模型

### 义务

一条义务 = `{ id, holder, kind, context, pin, attempt, seatName?, seatRequest?, brief }`。

- `holder` 取以下四种之一：`Main`；`Owner(member)`（仅设计的成员直接由规则给成 `Main`，见 `designOnly`）；`Gate`（一名新席位）；`Program`（效应）。
- `context` 取以下三种之一：`member(M)`、`unitVerification(U)`、`agendaClosure`。
- `id` = 哈希(kind, context, pin, attempt)。

**完结过滤**：`rules` 的最后一步统一执行，删掉已有完结记录的席位义务。

**尝试身份**：只用于重试时 pin 不变的义务。`attempt` = 1 + 以下「取代事件」的数量：

| 义务 | 取代事件 |
|---|---|
| deliver | M 上本议程的 PR 被放弃：未合并就关闭，或者被 `replacePr` 放弃 |
| review、accept | 同一 pin 上的失败结论被取代：它的发现全部为 `rejected` 或 `outOfScope`；或者它有被维持的发现，而 owner 在裁定之后已经提交过 `PrSubmit`（只改证据的修复） |
| postMerge、closure | 同一 pin 上对失败结论裁定 `reverify` |

review 的发现被驳回时，清单本身也会变（它包含「此前被驳回的发现」），两种变化任一发生都换一名新席位。

### 交付单元、成员与对账

- **交付单元**：一个顶层条目，加上它的线性修正链。
- **成员结局**：
  - `delivered(mergeSha)`：存在一个已合并、closing 引用包含 M 的 PR（不论作者、不论 issue 当前是否关闭）；
  - `noCode`：有当前有效的 noCode 确认；
  - `pending`：其他情况。
- **当前单元**：第一个未到终点的单元。
- **活跃成员**：当前单元中第一个结局为 `pending` 的成员。没有这样的成员时，单元处于验证阶段。

**对账**：对当前单元的每个成员都做，不管它是不是活跃成员。每个裁定都钉住它处理的那一次生命周期事件（关闭事件或重开事件的 id）以及当时的正文哈希，只对这一次事件生效；之后发生的新事件，需要新的裁定。

| 对账情形（均针对 issue 的当前状态） | 义务 |
|---|---|
| 结局为 `delivered` 或 `noCode`，issue 开着，结局确立之后从未被关闭过（例如合并后没有自动关闭） | Program `close` |
| 结局为 `delivered` 或 `noCode`，issue 开着，最近一次重开事件还没有钉住它的 `reopened` 裁定 | Main `decide(reopened)`，pin 为该事件 |
| 钉住当前重开事件的裁定为 `restore`；或为 `correction`，且单元有覆盖全部成员的有效 postMerge 通过 | Program `close`，该事件之后出现关闭事件即完成 |
| 结局为 `pending`，issue 已关闭且不是被合并关闭，没有钉住（当前关闭事件，当前正文哈希）的 `closed` 裁定 | Main `decide(closed)`，pin 为该事件与正文哈希 |
| 钉住当前关闭事件的裁定为 `reopen` | Program `reopen`，该事件之后出现重开事件即完成 |

- `reopened` 裁定的取值：
  - `restore`；
  - `correction`：附草稿，锚点为 `correctionOf`；
  - `reopenAccepted`：对 `noCode` 结局而言，相当于撤销确认，成员回到 `pending`。
- 结局为 `pending` 而 issue 已关闭的成员，在 `closed` 裁定作出之前，不给出任何 owner 或 Gate 义务。
- 「当前有效的 noCode 确认」：最新一条 noCode 类裁定为确认，它钉住的正文哈希与当前一致，并且之后没有 `reopenAccepted`。

### 成员情形 `Situation(member M)`（积类型）

| 维度 | 取值 |
|---|---|
| `designOnly` | 召集载荷或设计承接项草稿给出的事实；为真时 owner 类义务的持有者就是 `Main`，不需要席位 |
| `claims` | `none`，或 `pending(kind)`，kind 为 `question`、`noCode`、`split`、`blocked` |
| `ours` | `none`，或 `maintainable(gate)` |
| `foreign` | `true` 或 `false` |
| `materialized` | `settled` 或 `pending`：M 的 `openPr` / `updatePr`，以及改变契约的裁定所要求的 `applyBody` / `createIssue`（含 `acceptanceMethod` 转移出去的承接 issue）是否有尚未完成的；PR head 与最新 `PrSubmit` 的 head 不同也算 `pending` |
| `repair` | owner 与 main 两类待修复项，各自是否存在 |
| `seats` | owner、review、accept 各自所需的席位为 `live`、`parked` 或 `absent` |

- `maintainable`：open，恰好关闭 M，目标正确，带本议程的来源标记或在召集时指定接管，并且没有被 `replacePr` 裁定放弃。
- `gate`：
  - review 与 accept 各取一个值：`none`、`valid(pass)`、`valid(fail, 已裁或未裁)`、`superseded`、`stale`。`superseded` 的条件同上表；
  - 另含 `mergeable` 与 `checks`。

| 规则 | 义务 |
|---|---|
| `claims = pending(k)` | Main `decide(claim)` |
| `ours = none` | Owner `deliver` |
| `ours ≠ none` 且 `foreign` | Program `noticeForeignPr` |
| 某条有效的失败结论还有未裁的发现 | Main `decide(findings)` |
| owner 待修复项，或 `mergeable = no`，或 `checks = fail` 且当前失败的 check run 尚未引出过 `fix` | Owner `fix`，pin 为触发原因，按以下优先级取第一个：PR head 与最新 `PrSubmit` 的 head 不同（owner 推送了但还没回复）；被维持的发现所在的结论；`implDefect` 裁定；`checks` 的 `fixNeeded` 裁定；主会话的 designFix commit 未合入；该成员承载的设计 commit 未合入；冲突；失败的 check run |
| main 待修复项 | Main `designFix` |
| `checks = fail`，当前失败的 check run 已经引出过一次完结的 `fix` | Main `decide(checks)`，pin 为该 run 的 id |
| review 不是 `valid` | Gate `review` |
| accept 不是 `valid` | Gate `accept` |
| review 与 accept 都 `valid(pass)`，`mergeable = yes`，`checks = pass` | Program `merge(P, h)` |

**守卫**：可单独测试的不变量，作用于所有规则。

- 有未决的主张、`materialized = pending`、有未裁的发现，或有任一类待修复项时：不给出 Gate 义务，也不给出 `merge`。
- owner 自己的 `noCode`、`split` 或 `blocked` 主张未决时，它的义务照常存在，简报写明「等待裁定，可以 yield」，`yield` 拦截对这张票据放行；`question` 未决时，简报写明暂停依赖该点的部分。
- 被守卫抑制的 Gate 义务不被任何席位持有。守卫解除后，同名义务重新出现，席位被唤醒或重派。

主张一律是中间型回复，不完结任何义务：驳回之后原义务仍然有效；确认之后事实会变（`noCode` 改变结局，`split` 改变正文，`replacePr` 让 `ours` 变为 `none`，`external` 进入等待集合），义务随之改变。

### 有效性

| 结论 | pin | 有效条件 |
|---|---|---|
| review | head、目标与 base、PR 正文哈希、成员正文哈希、改变契约的裁定、设计 commit、此前被驳回的发现 | 与当前逐字段相等；针对这条结论本身的裁定不让它失效 |
| accept | head、目标与 base、成员正文哈希、改变契约的裁定、设计 commit | 同上 |
| postMerge | 单元内全部成员的合并提交、各成员正文哈希、改变契约的裁定、设计 commit | 契约字段相等；每个交付目标 repo 各有一个观察到的提交，它必须包含该 repo 的全部合并提交。最新的合并发生在议程 issue 创建之后时，它还必须恰好是该 repo 中单元最新的合并提交（R5）；发生在之前时（召集前的遗留项），可以是更新的提交 |
| closure | 全部成员的合并提交、parent 正文哈希、子 issue 集合及各自的终点事实、滞留设计义务的集合 | 契约字段相等；每个交付目标 repo 各有一个观察到的提交，并包含该 repo 的全部合并提交 |

- 改变契约的裁定只有 `designGap` 与 `acceptanceMethod` 两类。
- 有效结论完结它的 Gate 义务：通过和失败都算完结；失败引出的后续义务由规则另行给出。
- 「通过」要求每一条验收行 id 都有一行判定为通过。

### 单元验证阶段与议程收尾

以下义务的 `context` 分别为 `unitVerification` 或 `agendaClosure`。`claims` 也在各自的 context 里判断，守卫只抑制同一 context 内的 Gate 义务。

| 情形 | 义务 |
|---|---|
| 没有 `pending` 成员，至少一个成员 `delivered`，当前 attempt 上没有有效结论 | Gate `postMerge`，覆盖全部成员 |
| postMerge 有效且失败 | Main `decide(postMergeFail)`：`correction`（附草稿）或 `reverify` |
| 议程中任一有效结论列出了与本次无关的失败，而还没有针对该结论的 `unrelated` 裁定 | Main `decide(unrelated)`：附草稿，锚点为「不进议程」；不阻塞该单元 |
| 设计 commit 不在默认分支上，没有可维护的 PR 包含它，承载者已不能承载 | Main `decide(orphanDesign)` |
| 迁移来源尚未满足，而承担迁移的成员已经关闭 | Main `decide(migration)` |
| parent 的某个子 issue（不含议程 issue）不在议程里，也没有已核实的终点事实 | Main `decide(agendaGap)` |
| 全部单元到达终点，没有滞留的设计义务，parent 存在，当前 attempt 上没有有效结论 | Gate `closure` |
| closure 有效且失败 | Main `decide(closureFail)`：补项草稿或 `reverify` |
| closure 有效且通过，parent 开着 | Program `closeParent` |
| parent 在没有有效通过的情况下已关闭 | Program `reopen(parent)` |
| 交付完成，没有 `Decision(report)` | Main `report` |

- 子 issue 的已核实终点事实：被合并关闭；或者有当前有效的 noCode 确认。
- **单元终点**：没有 `pending` 成员；对账全部相符；该单元里改变成员事实的效应（`close`、`reopen`、`applyBody`、进议程的 `createIssue`）全部完成；并且全部成员都是 `noCode`，或者有覆盖全部成员的有效 postMerge 通过。
- **交付完成**：全部单元到达终点；没有滞留的设计义务；没有 parent，或者 parent 有有效的 closure 通过并且已经关闭。

**停滞**：没到终点，规则给不出义务，也不在等待集合里 → Main `decide(stall)`。这条规则对单元和议程都适用。等待集合包括：
- `mergeable = unknown`；
- `checks = pending | unknown`；
- 一条当前有效的 `blocked` 裁定：它钉住产生停滞的具体事实，这些事实一变就失效；它的简报要求主会话立即报告操作员。

### 效应（Program 义务）

效应按整个议程的记录推导，不限于当前单元，所以当前单元前进不会漏掉尚未完成的效应。

| 效应 | 依据 | 完成的判定 | 取代规则 |
|---|---|---|---|
| `createAgenda`、`closeAgenda`、`attachAgenda` | 召集 | 议程 issue 已存在、已关闭、已挂到 parent 下 | — |
| `openPr` / `updatePr` | 成员最新一条 `PrSubmit` | PR 正文带该条的已应用标记。PR 正文由程序渲染，含设计 commit 的署名 | 只处理最新一条 |
| `applyBody(decision, issue, baseHash)` | `Decision` 中的正文替换 | 隐藏块里有该裁定的标记，或者同一 issue 上更晚的替换已经应用。每次写入都保留隐藏块里已有的全部标记 | 基准哈希不符，并且没有被更晚的替换取代时，转为 `decide(stall)` |
| `createIssue(draftId)` | `Decision` 中的草稿 | 存在带该草稿标记的 issue | — |
| `noticeDecision(decision, issue)` | 受影响的每个 issue | 存在该通知 | — |
| `noticeForeignPr` | 规则表 | 存在该通知 | — |
| `close`、`reopen` | 对账表 | 对账表第一行：issue 已关闭；其余各行：裁定钉住的事件之后，出现了相应的关闭或重开事件 | 新的生命周期事件需要新的裁定 |
| `rerunChecks(decision)` | `decide(checks)` 的裁定为 `rerun` | 存在创建时间晚于该裁定的 check run | 之后仍然失败时，交给下一次 `decide(checks)` 裁定，不再盲目重跑 |
| `merge(P, h)` | 规则表 | PR 已合并 | head 变化后不再推导出来 |
| `closeParent`、`reopen(parent)` | 收尾表 | parent 状态已相符 | — |

- 效应执行失败：`execution` 记下每次失败的时间。
  - 最近一次失败还没有钉住它的 `effectFailed` 裁定时：这个效应暂停执行，并给出 Main `decide(effectFailed)`，pin 为（效应 id，失败时间）。
  - `retry` 只放行这一次失败；再失败会得到新的 pin 和新的裁定。`external` 让这个效应在该裁定有效期间不再执行，并进入等待集合。
  - `execution` 只用来暂停效应和触发裁定。重启后它为空，效应会再试一次。
- Main `spawn(请求名)` 与 Main `wake(请求名)`：和其他票据一样，只有主会话显式回复才算消费；回复写成议程 issue 上的记录，事后可以看到每个席位由哪个 agent 持有。
  - **spawn：先执行，再回执**。重复派出会多出一个 agent，所以回执必须证明动作已经生效。
    - 「可用的 agent」：在 registry 中，状态不是 aborted，去掉后缀后等于请求名。「待回执的 agent」：可用、但还没有任何 `seated` 回执指向它。
    - pin 为（请求名，最近一次 `seated` 回执里的 agentId，或「无」）。以下任一成立时推导出来：
      - 存在待回执的 agent。此时不论席位是否仍然需要都要回执，即使子席位已经先完成了工作；简报写明「只需回执」。
      - 席位仍然需要，最近一次回执的 agent 已不可用（或还没有回执），并且没有待回执的 agent。简报写明「用原生 `task` 派出」。
    - 回执为 `Decision(seated{agentId})`。`admit` 核对该 agent 是待回执的 agent。回执之后 pin 改变，这张票据完结。
  - **wake：先回执，再执行**。重复唤醒无害，而唤醒之后席位就不再 parked，回执在执行之后已经无从核对。
    - pin 为（agentId，该 agent 已有的 `woken` 回执数）；推导条件是该 agent 处于 parked。
    - 回执为 `Decision(woken{agentId})`，之后主会话用原生 `write agent://` 唤醒；如果仍处于 parked，回执数已经加一，于是得出一张新票据。

### 记录与 `Decision` 变体

| 记录 | 写者 | 完结的义务 |
|---|---|---|
| `PrSubmit` | owner | `deliver`、`fix` |
| `Claim(question \| noCode \| split \| blocked)` | owner、reviewer、验收者 | 不完结（中间型） |
| `Verdict(review \| accept \| postMerge \| closure)` | Gate | 对应的 Gate 义务 |
| `Decision(subject, verdict, drafts?, bodyReplacements?)` | 主会话 | 对应的 `decide`、`designFix`、`report`、`spawn`（`seated`）、`wake`（`woken`） |

`Decision` 按 subject 划分变体，每个 subject 只接受自己的一组 verdict。完整的变体表见附件 [core.briefs.md](core.briefs.md)「Decision 变体」。其中改变事实的变体包括：
- `claim(question)` 的 `implDefect`：产生 owner 待修复项；
- `designGap` 与 `acceptanceMethod`：改变契约；
- `reopenAccepted`：撤销 noCode 确认；
- `replacePr`：放弃当前 PR。

- 草稿 id 为 `(Decision id, 序号)`；锚点为 `before`、`after` 或 `correctionOf`。插在当前单元之前的草稿会成为新的当前单元。
- 设计路线：
  - `defaultFirst(commit)`：commit 必须已在默认分支上。适用条件写在主会话的简报里，推送被拒时改选其他路线。
  - `withPr(commit)`：commit 在设计分支上，承载者是提问的成员（发现所在结论的成员），由它合入。
  - `future(carrier, commit)`：承载者与 commit 同 repo，并位于当前单元之后。没有合适的承载者时，裁定必须附带设计承接项的草稿。

### 席位名

- **请求名**：
  - owner：`rt-<repoSlug>-<issue>-owner`；
  - gate：`rt-<repoSlug>-<issue>-<kind>-h<pinHash>-a<attempt>`。
- 请求名只用 `[a-z0-9-]`，长度不超过 44，给 registry 的后缀留出空间。
- **工作目录**：`/tmp/omp-roundtable/<owner>-<repo>-<issue>/<请求名>`。续作 owner 会回到同一个工作目录。

## 4 函数

- `classify(snapshot, host) → (Situation, Witness)`
  - 是一个全函数。
  - `Witness` 把规则可能提到的每个槽位，映射到具体的 id 与事实。
  - 同一槽位有多个候选时，只在这里按记录顺序选取。
- `rules(Situation) → Spec[]`：只读 `Situation`；最后一步执行完结过滤。
- `realize(Witness, Spec[], policy) → Obligation[]`：不读 `Snapshot`。
- `admit(snapshot, host, caller, reply) → Record | Replayed | Rejected`，依次检查：
  1. 按幂等键查找已有记录：载荷相同返回 `Replayed`，不同则拒绝为「已完结」。
  2. 义务在当前推导结果里。唯一的例外是主会话主动提出的 `noCode`：目标必须是当前单元中结局为 `pending` 的成员，幂等键为（成员，正文哈希）。
  3. 调用者身份：`ctx.agent.id` 去掉后缀等于请求名，registry 中该 id 的会话就是调用者的会话，状态不是 aborted，并且调用者是该席位的持有者，或是待回执的 agent（子席位可能在主会话回执之前就完成工作）。主会话凭 `kind = main` 通过。
  4. 记录种类与 `Decision` 变体都可接受；`Decision` 指名的记录、事件、主题键、席位或 agent 必须正好是这张票据的 pin，不能借一张票据裁定另一件事。
  5. 实时前提成立，例如：`PrSubmit` 的 head 等于远端 head，并且包含应合入的设计 commit；结论观察到的 head 或提交满足有效条件；结论的验收行 id 集合等于 issue 的验收行 id 集合。
  6. 由程序把 pin 盖入记录。

## 5 走查

完整走查见附件 [core.walkthroughs.md](core.walkthroughs.md)。

## 6 验证

1. **规则层穷举**：枚举 `Situation` 的全部值，检查以下性质：
   - 全覆盖：不在终点时，要么有义务，要么在等待集合里；`stall` 只出现在列举过的情形中。
   - 守卫：守卫条件成立时，被禁止的义务不出现。
   - 满足与完结：一个义务的效果写入之后，它不再出现。
   - 确定性：同一输入给出同一输出。
   - 每条规则至少触发一次。
2. **抽象层**：只对「一致」的 `Situation` 构造具体读数。某个值不一致，指它违反了具体读数之间必然成立的约束，例如没有 PR 就不可能有 gate 结论；每条这样的约束都写进测试的约束表，并附理由。
   - ReconcileSituation、VerificationSituation、ClosureSituation：每一个一致的值都构造两份不同的具体 Snapshot（γ₁、γ₂）。
   - MemberSituation 的一致值有几十万个，无法逐个构造。对它取系统覆盖：基线加上每个维度的每个取值，再加上 claim × ours × review × accept × materialized 的全积；另外用固定种子随机抽取至少 5,000 个一致值。
   - 每个取到的值都要求 γ₁、γ₂ 都归类到这个值，并且 `realize` 接回的对象正确。任何一致值构造失败，都算 core 的缺陷。
   - 用随机生成的 Snapshot 检查 `classify` 是全函数。
3. **模型检查**：
   - 边定义为 α(applyConcrete(γ(s), e))，并检查稳定性：取 γ₁ 与 γ₂ 得到的后继状态相同。
   - 边的种类：
     - 回复的全部变体；
     - 效应，包括执行失败；
     - 扰动：推送、正文编辑、人工关闭或重开、checks 或 `mergeable` 变化、席位 parked 或 absent、默认分支前进。默认分支只前进了没有被任何记录引用的提交时，`Situation` 必须不变。
   - 性质：
     - AG 不变量。
     - EF 交付完成，前提是以下公平性假设：`unknown` 与 `pending` 最终落定；外部阻塞最终解除；gate 可以失败任意次，但成功始终可达。
   - 这只证明「有路可走」，不证明一定能成功交付。

## 7 维护

- 加一条规则，就在规则表加一行，同时在 `Situation` 与 `Witness` 里加上对应的槽位；需要同步的地方由编译器指出。
- 测试失败时依次怀疑：规则 → `Situation` 维度 → `classify` → 等待集合。不为了通过测试而扩大等待集合或 `stall` 白名单。
- 清单字段变更时，同步更新上级 §6 的敏感点说明与附件。
