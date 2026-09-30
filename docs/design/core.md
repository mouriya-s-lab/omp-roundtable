# core 设计

## 0 定位

- **层级与元素**：L3 component `core`，上级为 [omp-roundtable.md](omp-roundtable.md)。读者：core 的实现者、规则维护者。审批者：操作员。
- **要决定的事**：给定议程的当前状态、GitHub 事实和宿主观察，推导出哪些义务应当存在；给定一条回复或效应结果，算出状态是否转移、转移到什么。
- **本文决定**：状态模型、领域类型、`Situation` 与 `Witness`、规则与守卫、尝试身份、效应、转移函数 `step`、验证方法。
- **不在本文决定**：
  - 状态文件的格式与写法、GitHub 查询的组织、效应执行前的源头核对，归 store；
  - 投递、注入与 `yield` 拦截，归 seat adapter；
  - 简报字段与回复 schema 放在附件 [core.briefs.md](core.briefs.md)。
- **非目标**：core 不做 IO，不读时钟，不生成随机数。需要的时间（召集时间、草稿提出时间）由 adapter 作为输入传入。

输入衔接：需求来自上级 §1 的 R1–R21；抽象来自上级 §3；契约来自上级 §4。

## 1 输入与域性质

`classify(state, facts, host)` 有三类输入。

**议程状态 `AgendaState`**（C1，本系统是它唯一的源头）。每个字段表示「现在是什么」；每个槽位只存最新值，新值替换旧值，不保留历史。

- **议程**：id；召集时间；parent；召集清单（不可变，每项带召集载荷：交付目标 repo 与 base、是否仅设计、要接管的 PR）；草稿（每条带锚点、内容、提出时间，建成后登记 issue）。议程顺序由召集清单加上已建成、要进议程的草稿按锚点插入得出。
- **成员**（每个进入议程的 issue 一份）：
  - `submit`：最新一条 `PrSubmit`，带它完结的 deliver 或 fix 票据 id，以及是否已应用到当前 PR、应用时署名的设计 commit；`prs`：程序为 M 创建的 PR 与召集时接管的 PR；`replaced`：被 `replacePr` 放弃的 PR；
  - `review`、`accept` 两个 gate 槽位：attempt、最新结论（带它的 pin 与 attempt）、主会话对不通过结论的裁定；此前被驳回的 review 结论；
  - 待修复项：`implDefect`、`fixNeeded`（各带裁定理由，下一次 `PrSubmit` 时清除）、主会话的 `designFix` commit；
  - checks：最新的 checks 裁定（钉住 run id，`rerun` 时带是否已执行）；最近一次引出过完结 `fix` 的 run id；
  - noCode 确认（钉住正文哈希与确认时间）；对账裁定（钉住生命周期事件）；`external` 阻塞。
- **单元**：postMerge 槽位（同 gate 槽位，裁定为 `correction` 或 `reverify`）。
- **议程级**：
  - 未决的主张，裁定后清除；
  - 生效的契约裁定（`designGap`、`acceptanceMethod`）及其影响的成员、设计路线与承载者；正文替换，每个 issue 至多一条（基准哈希、目标哈希、是否已应用）；
  - closure 槽位；主题裁定（`orphanDesign`、`migration`、`agendaGap`、`stall`），每个主题只存最新一条及其 pin；效应失败裁定，每个效应只存最新一条；
  - 主会话最近一条被接受的裁定的 id；是否已报告。
- **席位**（按请求名）：持有者 agentId。
- `version`：每次写入加一，供 store 做比较交换；不参与推导。

**GitHub 事实 `Facts`**（C1，只代表读取那一刻，不复制进状态）：

- **issue**：状态；最近一次关闭与重开事件（id 与时间，以及是否由合并关闭）；正文哈希；父子图的边。
- **PR**：分两层读。
  - 登记与接管的 PR（成员 `prs` 与召集时的接管 PR）按编号读全：状态、head 分支与 head、合并提交与合并时间、目标 repo 与 base、标题与正文哈希；`mergeable: yes | no | unknown`；`checks: pass | fail | pending | unknown`，以及当前失败的 check run id；closing 引用中的 issue（合并后同样保留）。
  - 每个被读 issue 的 closing 引用只读成链接：状态、head 分支与 head、合并提交与合并时间、目标 repo 与 base；它关闭的 issue 就是列出它的那些被读 issue。成员结局、子 issue 终点与设计 commit 是否被承载只用到这些字段；mergeable、checks 与正文只对登记的 PR 有意义。
  - base 不是默认分支时 GitHub 不解析 closing keyword，所以 `prs` 里登记的 PR 也算关闭登记它的成员。
- **commit**：状态引用的每个 sha 是否在默认分支上、是否包含在某个 PR 的 head 里；提交之间的包含关系；每个交付目标 base 分支的当前 head，它是 deliver 简报给出的起点。

**宿主观察 `host`**：adapter 每轮向宿主查询，不作保存。

- `seats`：registry 里的每个 agent，含实际 id、请求名（去掉末尾 `-\d+` 后缀）、状态 `live | parked | aborted`，parked 时带本次 parked 期的起点。
  - 席位状态：持有者 live 时为 `live`，parked 时为 `parked`；持有者不可用（没有持有者、不在 registry 中或已 aborted）而存在待回执的 agent 时为 `pendingAck`；其余为 `absent`。
- `execution`：本进程内每个效应每次执行失败的时间与错误原文，错误原文写进 `decide(effectFailed)` 的简报。重启后为空，等于重新尝试。
- `policy`：简报要附带的策略原文，以及派出 owner 席位与 gate 席位用的 agent 类型（由设置给出，默认 `task:high` 与 `task:mid`）。它只进入 `realize`，只影响简报与席位请求，不影响 id 或 pin。

**域性质**：
- `unknown` 与 `pending` 是独立的状态；正文版本用哈希表示。
- git 的提交与推送是席位的原生操作；GitHub 上的交付产物只由程序写。
- 所有 agent 共用一个 GitHub 账号，「作者是谁」不构成归属事实；归属看状态里的 `prs`。
- 默认分支会不断前进，所以 pin 只能用不会移动的提交，有效性用「包含」判断，不用「相等」判断。

## 2 驱动

- **可穷举**：规则只读有限类型 `Situation`（上级 Q6）。
- **确定性**：同一输入给出同一输出；恢复与正常路径是同一个函数（Q2）。
- **无陈旧合并**：合并只在全部守卫满足时出现（Q3）。
- **只在转移时写**：`step` 在状态不变时返回 `Same`（Q4）。

## 3 模型

### 义务

一条义务 = `{ id, holder, kind, context, pin, attempt, seatName?, seatRequest?, brief }`。

- `holder` 取以下四种之一：`Main`；`Owner(member)`（仅设计的成员直接由规则给成 `Main`，见 `designOnly`）；`Gate`（一名新席位）；`Program`（效应）。
- `context` 取以下三种之一：`member(M)`、`unitVerification(U)`、`agendaClosure`。
- `id` = 哈希(kind, context, pin, attempt)。

**完结**：`rules` 的最后一步统一执行：`submit` 记录的票据 id 等于当前 deliver 或 fix 的 id 时，不再给出它。其余义务的回复写进状态后，规则本身就不再推导出它们（结论有效、主张已清除、裁定已存在、持有者已变）。pin 改变后同一主题得出新 id 的义务，不受旧回复影响。

**尝试身份**：只用于重试时 pin 不变的义务。

| 义务 | attempt |
|---|---|
| deliver | 1 + `prs` 中未合并就关闭的 PR 数 + `replaced` 中的 PR 数 |
| review、accept、postMerge、closure | 槽位里的 attempt，由 `step` 在取代时加一，见下 |

gate 槽位的取代（`step` 执行）：
- review、accept：对不通过结论的裁定为 `rejected` 或 `outOfScope`；或者裁定为维持，之后 owner 提交了 `PrSubmit`（只改证据的修复）。
- postMerge、closure：对失败结论裁定 `reverify`。

槽位里结论的 attempt 小于槽位 attempt 时，这条结论为 `superseded`。review 结论被驳回时，清单本身也会变（它包含「此前被驳回的结论」），两种变化任一发生都换一名新席位。

### 交付单元、成员与对账

- **交付单元**：一个顶层条目，加上它的线性修正链。
- **成员结局**：
  - `delivered(mergeSha)`：存在一个已合并、关闭 M 的 PR（closing 引用包含 M，或登记在 M 的 `prs` 里；不论作者、不论 issue 当前是否关闭）。有多个时取合并时间最晚的，同一时间取 PR 引用较小的，结果与读取顺序无关；
  - `noCode`：有当前有效的 noCode 确认；
  - `pending`：其他情况。
- **当前单元**：第一个未到终点的单元。
- **活跃成员**：当前单元中第一个结局为 `pending` 的成员。没有这样的成员时，单元处于验证阶段。

**对账**：对当前单元的每个成员都做，不管它是不是活跃成员。每个对账裁定都钉住它处理的那一次生命周期事件（关闭或重开事件的 id）以及当时的正文哈希，只对这一次事件生效；之后发生的新事件需要新的裁定。

| 对账情形（均针对 issue 的当前状态） | 义务 |
|---|---|
| 结局为 `delivered` 或 `noCode`，issue 开着，结局确立之后从未被关闭过（例如合并后没有自动关闭） | Program `close` |
| 结局为 `delivered` 或 `noCode`，issue 开着，最近一次重开事件还没有钉住它的 `reopened` 裁定 | Main `decide(reopened)`，pin 为该事件 |
| 钉住当前重开事件的裁定为 `restore`；或为 `correction`，且单元有覆盖全部成员的有效 postMerge 通过 | Program `close`，该事件之后出现关闭事件即完成 |
| 结局为 `pending`，issue 已关闭且不是被合并关闭，没有钉住（当前关闭事件，当前正文哈希）的 `closed` 裁定 | Main `decide(closed)`，pin 为该事件与正文哈希 |
| 钉住当前关闭事件的裁定为 `reopen` | Program `reopen`，该事件之后出现重开事件即完成 |

- `reopened` 裁定的取值：`restore`；`correction`（附草稿，锚点为 `correctionOf`）；`reopenAccepted`（对 `noCode` 结局而言，清除确认，成员回到 `pending`）。
- 结局为 `pending` 而 issue 已关闭的成员，在 `closed` 裁定作出之前，不给出任何 owner 或 Gate 义务。
- 「当前有效的 noCode 确认」：状态里有 noCode 确认，并且它钉住的正文哈希与当前一致。

### 成员情形 `Situation(member M)`（积类型）

| 维度 | 取值 |
|---|---|
| `designOnly` | 召集载荷或设计承接项草稿给出的事实；为真时 owner 类义务的持有者就是 `Main`，不需要席位 |
| `claims` | `none`，或 `pending(kind)`，kind 为 `question`、`noCode`、`split`、`blocked` |
| `ours` | `none`，或 `maintainable(gate)` |
| `materialized` | `settled` 或 `pending`：M 的 `openPr` / `updatePr`，以及改变契约的裁定所要求的 `applyBody` / `createIssue`（含 `acceptanceMethod` 转移出去的承接 issue）是否有尚未完成的；PR head 与 `submit` 的 head 不同也算 `pending` |
| `repair` | owner 与 main 两类待修复项，各自是否存在 |
| `seats` | owner、review、accept 各自所需的席位为 `live`、`parked` 或 `absent` |

- `maintainable`：PR open，登记在 M 的 `prs` 里且不在 `replaced` 里，恰好关闭 M，目标正确。
- `gate`：
  - review 与 accept 各取一个值：`none`、`valid(pass)`、`valid(fail, 已裁或未裁)`、`superseded`、`stale`；
  - 另含 `mergeable` 与 `checks`。

| 规则 | 义务 |
|---|---|
| `claims = pending(k)` | Main `decide(claim)` |
| `ours = none` | Owner `deliver` |
| 有效的不通过结论还没有裁定 | Main `decide(findings)` |
| owner 待修复项，或 `mergeable = no`，或 `checks = fail` 且当前失败的 run 不是最近引出过完结 `fix` 的 run | Owner `fix`，pin 为触发原因，按以下优先级取第一个：PR head 与 `submit` 的 head 不同（owner 推送了但还没回复）；被维持的不通过结论；`implDefect` 裁定；`checks` 的 `fixNeeded` 裁定；主会话的 designFix commit 未合入；该成员承载的设计 commit 未合入；冲突；失败的 check run |
| main 待修复项 | Main `designFix` |
| `checks = fail`，当前失败的 run 已经引出过一次完结的 `fix` | Main `decide(checks)`，pin 为该 run 的 id |
| review 不是 `valid` | Gate `review` |
| accept 不是 `valid` | Gate `accept` |
| review 与 accept 都 `valid(pass)`，`mergeable = yes`，`checks = pass` | Program `merge(P, h)` |

**守卫**：可单独测试的不变量，作用于所有规则。

- 有未决的主张、`materialized = pending`、有未裁定的不通过结论，或有任一类待修复项时：不给出 Gate 义务，也不给出 `merge`。
- owner 自己的 `noCode`、`split` 或 `blocked` 主张未决时，它的义务照常存在，简报写明「等待裁定，可以 yield」，`yield` 拦截对这张票据放行；`question` 未决时，简报写明暂停依赖该点的部分。
- 被守卫抑制的 Gate 义务不被任何席位持有。守卫解除后，同名义务重新出现，席位被唤醒或重派。

主张一律是中间型回复，不完结任何义务：驳回之后原义务仍然有效；确认之后状态或事实会变（`noCode` 改变结局，`split` 改变正文，`replacePr` 让 `ours` 变为 `none`，`external` 进入等待集合），义务随之改变。

### 有效性

| 结论 | pin | 有效条件 |
|---|---|---|
| review | head、目标与 base、PR 正文哈希、成员正文哈希、改变契约的裁定、设计 commit、此前被驳回的结论 | 与当前逐字段相等，并且结论的 attempt 等于槽位 attempt；针对这条结论本身的裁定不让它失效 |
| accept | head、目标与 base、成员正文哈希、改变契约的裁定、设计 commit | 同上 |
| postMerge | 单元内全部成员的合并提交、各成员正文哈希、改变契约的裁定、设计 commit | 同上。在哪个提交上验收由简报规定：召集之后的合并在该 repo 最新的合并提交上（R5），召集之前的遗留项在包含合并提交的默认分支 head 上 |
| closure | 全部成员的合并提交、parent 正文哈希、子 issue 集合及各自的终点事实、滞留设计义务的集合 | 同上 |

- 改变契约的裁定只有 `designGap` 与 `acceptanceMethod` 两类。
- 有效结论完结它的 Gate 义务：通过和失败都算完结；失败引出的后续义务由规则另行给出。
- 结论只有通过（`ok`）或不通过，附席位写的理由。head、合并提交这些事实是票据的 pin，由程序盖入，席位不回报；验收行由席位按简报逐条核对，`ok` 表示全部通过。

### 单元验证阶段与议程收尾

以下义务的 `context` 分别为 `unitVerification` 或 `agendaClosure`。`claims` 也在各自的 context 里判断，守卫只抑制同一 context 内的 Gate 义务。

| 情形 | 义务 |
|---|---|
| 没有 `pending` 成员，至少一个成员 `delivered`，postMerge 槽位没有有效结论 | Gate `postMerge`，覆盖全部成员 |
| postMerge 有效且失败 | Main `decide(postMergeFail)`：`correction`（附草稿）或 `reverify` |
| 设计 commit 不在默认分支上，没有可维护的 PR 包含它，承载者已不能承载 | Main `decide(orphanDesign)` |
| 迁移来源尚未满足，而承担迁移的成员已经关闭 | Main `decide(migration)` |
| parent 的某个子 issue 不在议程里，也没有已核实的终点事实 | Main `decide(agendaGap)` |
| 全部单元到达终点，没有滞留的设计义务，parent 存在，closure 槽位没有有效结论 | Gate `closure` |
| closure 有效且失败 | Main `decide(closureFail)`：补项草稿或 `reverify` |
| closure 有效且通过，parent 开着 | Program `closeParent` |
| parent 在没有有效通过的情况下已关闭 | Program `reopen(parent)` |
| 交付完成，状态里还没有报告 | Main `report` |

- 子 issue 的已核实终点事实：被合并关闭；或者有当前有效的 noCode 确认。
- **单元终点**：没有 `pending` 成员；对账全部相符；该单元里改变成员事实的效应（`close`、`reopen`、`applyBody`、进议程的 `createIssue`）全部完成；并且全部成员都是 `noCode`，或者有覆盖全部成员的有效 postMerge 通过。
- **交付完成**：全部单元到达终点；没有滞留的设计义务；没有 parent，或者 parent 有有效的 closure 通过并且已经关闭。

**停滞**：没到终点，规则给不出义务，也不在等待集合里 → Main `decide(stall)`。这条规则对单元和议程都适用。等待集合包括：
- `mergeable = unknown`；
- `checks = pending | unknown`；
- 一条当前有效的 `blocked` 裁定：它钉住产生停滞的具体事实，这些事实一变就失效；它的简报要求主会话立即报告操作员。

### 效应（Program 义务）

效应按整个议程的状态推导，不限于当前单元，所以当前单元前进不会漏掉尚未完成的效应。有「结果写回」的效应，执行成功后以一次 `step(EffectDone)` 写回状态；其余效应的结果就是 GitHub 事实本身，不写状态。

| 效应 | 依据 | 完成的判定 | 结果写回 |
|---|---|---|---|
| `openPr` / `updatePr` | 成员的 `submit`，未应用，或应用时署名的设计 commit 与当前应合入的不同 | 已应用，且署名的设计 commit 与当前应合入的相同。PR 正文由程序渲染，含设计 commit 的署名 | PR 登记进 `prs`；记为已应用，并记下署名的设计 commit |
| `applyBody(issue, baseHash, targetHash)` | 契约里未应用的正文替换 | 状态里已应用。当前正文已等于目标时，执行只写回结果，不写 GitHub；这样之后有人再改正文，也不会让它重新生效 | 替换置为已应用 |
| `createIssue(draftId)` | 未登记 issue 的草稿 | 草稿已登记 issue | 登记 issue |
| `close`、`reopen` | 对账表 | 对账表第一行：issue 已关闭；其余各行：裁定钉住的事件之后，出现了相应的关闭或重开事件 | — |
| `rerunChecks(runId)` | checks 裁定为 `rerun` 且未执行 | 状态里已执行 | 裁定置为已执行；之后仍然失败时交给下一次 `decide(checks)`，不再盲目重跑 |
| `merge(P, h)` | 规则表 | PR 已合并 | —；head 变化后不再推导出来 |
| `closeParent`、`reopen(parent)` | 收尾表 | parent 状态已相符 | — |
| `wake(agentId)` | 席位仍然需要，持有者处于 parked；pin 为（agentId，本次 parked 期的起点） | registry 里持有者不再处于这次 parked 期。由 adapter 经宿主 IRC 总线以主会话的名义发消息执行，宿主随之恢复会话 | — |

- 正文替换的基准哈希与当前正文不符、当前正文也不等于目标时，不写入，转为 `decide(stall)`。
- 崩溃发生在效应执行之后、结果写回之前时，store 在执行前先核对源头（上级 §4 C3），效果已经存在就只写回结果。
- 效应执行失败：`execution` 记下每次失败的时间与错误原文。
  - 有结果写回的效应：最近一次失败还没有钉住它的 `effectFailed` 裁定时，这个效应暂停执行，并给出 Main `decide(effectFailed)`，pin 为（效应 id，失败时间）。`retry` 只放行这一次失败；再失败会得到新的 pin 和新的裁定。`external` 让这个效应在该裁定有效期间不再执行，并进入等待集合。
  - 没有结果写回的效应（`close`、`reopen`、`merge`、`closeParent`、`reopen(parent)`、`wake`）：下一轮按事实重新推导，条件仍成立就再执行一次。`wake` 投递失败时持有者仍是 parked；持有者已 aborted 时席位变为 `absent`，改由 `spawn` 续作。
- **Main `spawn(请求名)`：先执行，再回执**。插件不能派出原生子 agent，所以由主会话执行；重复派出会多出一个 agent，所以回执必须证明动作已经生效。
  - 「可用的 agent」：在 registry 中，状态不是 aborted，去掉后缀后等于请求名。「待回执的 agent」：只在持有者不可用时存在，是 registry 顺序里第一个不是持有者的可用 agent。持有者可用时，同名的其他 agent 是多派出的重复：不持有票据，也不要求回执，所以两个 agent 不会轮流被回执成持有者。
  - pin 为（请求名，状态里的持有者或「无」）。以下任一成立时推导出来：
    - 存在待回执的 agent。此时不论席位是否仍然需要都要回执，即使子席位已经先完成了工作；简报写明「只需回执」。
    - 席位仍然需要，持有者已不可用（或还没有持有者），并且没有待回执的 agent。简报写明「用原生 `task` 派出」。
  - 回执为 `Decision(seated{agentId})`，把持有者改为该 agent；pin 随之改变，这张票据完结。回执改变席位状态，所以只在持有者变化时写入。
- 唤醒没有回执：是否已唤醒是 registry 的事实，状态里不留副本。

### 回复与 `Decision` 变体

| 回复 | 回复者 | 写进的槽位 | 完结的义务 |
|---|---|---|---|
| `PrSubmit` | owner | 成员的 `submit`（`applied` 置假，清除已处理的待修复项） | `deliver`、`fix` |
| `Claim(question \| noCode \| split \| blocked)` | owner、reviewer、验收者 | 对应 context 的 `claim` | 不完结（中间型） |
| `Verdict(ok, note)` | Gate | 票据种类对应的 gate 槽位，由程序盖入 gate 与 pin | 对应的 Gate 义务 |
| `Decision(subject, verdict, drafts?, bodyReplacements?)` | 主会话 | subject 对应的槽位；草稿与正文替换进入议程与契约 | 对应的 `decide`、`designFix`、`report`、`spawn`（`seated`） |

`Decision` 按 subject 划分变体，每个 subject 只接受自己的一组 verdict。完整的变体表见附件 [core.briefs.md](core.briefs.md)「Decision 变体」。其中改变状态中契约或结局的变体包括：
- `claim(question)` 的 `implDefect`：产生 owner 待修复项，只适用于成员 context 的问题；
- `designGap` 与 `acceptanceMethod`：改变契约；
- `reopenAccepted`：清除 noCode 确认；
- `replacePr`：把当前 PR 加入 `replaced`。

- 草稿 id 为 `(票据 id, 序号)`；锚点为 `before`、`after` 或 `correctionOf`。插在当前单元之前的草稿会成为新的当前单元。
- 设计路线：
  - `defaultFirst(commit)`：commit 必须已在默认分支上。适用条件写在主会话的简报里，推送被拒时改选其他路线。
  - `withPr(commit)`：commit 在设计分支上，承载者是提问的成员（或被裁定结论所属的成员），由它合入。
  - `future(carrier, commit)`：承载者与 commit 同 repo，并位于当前单元之后。没有合适的承载者时，裁定必须附带设计承接项的草稿。

### 席位名

- **请求名**：
  - owner：`rt-<repoSlug>-<issue>-owner`；
  - gate：`rt-<repoSlug>-<issue>-<kind>-h<pinHash>-a<attempt>`。
- 请求名只用 `[a-z0-9-]`，长度不超过 44，给 registry 的后缀留出空间。
- **工作目录**：`/tmp/omp-roundtable/<owner>-<repo>-<issue>/<请求名>`。续作 owner 会回到同一个工作目录。

## 4 函数

- `convene(清单, parent, 召集时间) → AgendaState`：召集时建立初始状态，版本为 1。
- `classify(state, facts, host) → (Situation, Witness)`
  - 是一个全函数。
  - `Witness` 把规则可能提到的每个槽位，映射到具体的 id 与事实。
- `rules(Situation) → Spec[]`：只读 `Situation`；最后一步执行完结。
- `realize(Witness, Spec[], policy) → Obligation[]`：不读状态与事实。
- `step(state, facts, host, policy, event) → Rejected(reason) | Same | Next(state')`，`event` 为回复（带调用者、实时前提与接受时间）或效应结果，依次检查：
  1. 已生效：状态里已是这条回复（席位回复在它的槽位里，主张在未决列表里，主会话的裁定是状态记录的最近一条），或效应结果已登记 → `Same`。
  2. 义务在当前推导结果里，否则拒绝为「已完结」或「无此票据」。唯一的例外是主会话主动提出的 `noCode`：目标必须是当前单元中结局为 `pending` 的成员。
  3. 调用者身份：`ctx.agent.id` 去掉后缀等于请求名，registry 中该 id 的会话就是调用者的会话，状态不是 aborted，并且调用者是该席位的持有者，或是待回执的 agent（子席位可能在主会话回执之前就完成工作）。主会话凭 `kind = main` 通过；效应结果只接受 adapter 自己。
  4. 回复种类与 `Decision` 变体都可接受；`Decision` 指名的结论、事件、主题、席位或 agent 必须正好是这张票据的 pin；主张所指的上下文必须是这张票据的上下文；裁定主张时 subject 与主张的种类一致，noCode、split 的成员与正文哈希就是主张的成员及其当前正文哈希。结论的 gate 就是票据的种类，席位不填写。不能借一张票据裁定、判定或主张另一件事。
  5. 实时前提成立：`PrSubmit` 的 head 等于远端 head，并且包含应合入的设计 commit。结论只有通过或不通过，没有需要核对的事实。
  6. 由程序把 pin 盖入回复，按上表写进槽位并应用它带来的变化，得到 `state'`。`state'` 与 `state` 相等 → `Same`；否则 `Next(state')`，版本加一。

## 5 走查

完整走查见附件 [core.walkthroughs.md](core.walkthroughs.md)。

## 6 验证

1. **规则层穷举**：枚举 `Situation` 的全部值，检查以下性质：
   - 全覆盖：不在终点时，要么有义务，要么在等待集合里；`stall` 只出现在列举过的情形中。
   - 守卫：守卫条件成立时，被禁止的义务不出现。
   - 确定性：同一输入给出同一输出。
   - 每条规则至少触发一次。
2. **抽象层**：只对「一致」的 `Situation` 构造具体输入 `(state, facts, host)`。某个值不一致，指它违反了具体输入之间必然成立的约束，例如没有 PR 就不可能有 gate 结论；每条这样的约束都写进测试的约束表，并附理由。
   - ReconcileSituation、VerificationSituation、ClosureSituation：每一个一致的值都构造两份不同的具体输入（γ₁、γ₂）。
   - MemberSituation 的一致值有几十万个，无法逐个构造。对它取系统覆盖：基线加上每个维度的每个取值，再加上 claim × ours × review × accept × materialized 的全积；另外用固定种子随机抽取至少 5,000 个一致值。
   - 每个取到的值都要求 γ₁、γ₂ 都归类到这个值，并且 `realize` 接回的对象正确。任何一致值构造失败，都算 core 的缺陷。
   - 用随机生成的具体输入检查 `classify` 是全函数。
3. **转移**：对每种回复与效应结果：
   - `step` 返回 `Next(state')` 时 `state' ≠ state`；对 `state'` 再提交同一事件得到 `Same`。
   - 满足与完结：在 `state'` 上推导，被回复的票据或被写回的效应不再出现。
   - 不改变状态的事件（重复回执、与当前值相同的裁定）得到 `Same`。
4. **模型检查**：
   - 边定义为 α(apply(γ(s), e))，回复与效应结果经 `step` 施加；检查稳定性：取 γ₁ 与 γ₂ 得到的后继状态相同。
   - 边的种类：
     - 回复的全部变体；
     - 效应，包括执行失败，以及执行成功但结果未写回；
     - 扰动：推送、正文编辑、人工关闭或重开、checks 或 `mergeable` 变化、席位 parked 或 absent、默认分支前进。默认分支只前进了状态没有引用的提交时，`Situation` 必须不变。
   - 性质：
     - AG 不变量，其中包括进展：没到终点、也不在等待集合里时，总有主会话、程序或一名 live 席位持有义务。只由 parked 席位持有、又没有人唤醒的义务就是静默停住。
     - EF 交付完成，前提是以下公平性假设：`unknown` 与 `pending` 最终落定；外部阻塞最终解除；gate 可以失败任意次，但成功始终可达；唤醒的投递最终成功。
   - 这只证明「有路可走」，不证明一定能成功交付。

## 7 维护

- 加一条规则，就在规则表加一行，同时在 `Situation` 与 `Witness` 里加上对应的槽位；需要同步的地方由编译器指出。
- 状态里新增字段之前先确认 GitHub 没有保存这项事实；GitHub 已有的，只读不存。
- 测试失败时依次怀疑：规则 → `Situation` 维度 → `classify` → 等待集合。不为了通过测试而扩大等待集合或 `stall` 白名单。
- 清单字段变更时，同步更新上级 §6 的敏感点说明与附件。
