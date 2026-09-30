# core：走查

[core.md](core.md) §5 的附件。

- 文中的「规则」「守卫」「对账」「验证阶段」「效应」，分别指 core.md §3 中的同名表。
- 每一步都是一次独立的推导：上一步的回复或效应结果已经写进状态，或已经成为 GitHub 事实，本步只从当前状态与事实重新算。步骤之间没有连线，也不存储「下一步是什么」。

## W1 正常交付

1. M 是活跃成员，`ours = none` → Owner `deliver`。席位为 `absent` → Main `spawn`。
2. owner 回复 `PrSubmit`，写进 `submit`，完结 `deliver`。`openPr` 尚未完成，`materialized = pending`，守卫抑制 gate。
3. `openPr` 执行后把 PR 登记进 `prs`、`applied` 置真 → `materialized = settled`，`ours = maintainable`，review 与 accept 都是 `none` → Gate `review` 与 Gate `accept` → 两张 Main `spawn`。
4. 两条结论都是 `valid(pass)`，`mergeable = yes`，`checks = pass` → Program `merge(P, h)`。
5. PR 已合并 → M 的结局为 `delivered`，进入验证阶段 → Gate `postMerge`。合并发生在议程召集之后，所以验收者在该合并提交的干净 checkout 上执行（R5）。
6. 如果 issue 没有自动关闭 → 对账 → Program `close`。
7. postMerge 通过，对账相符，本单元的效应全部完成 → 单元到达终点 → 下一个单元成为当前单元。

## W2 gate 进行中有新推送

1. head 从 h 变为 h'。两条结论或两张 gate 票据都变为 `stale`。
2. 在 h' 上重新给出 gate 票据。pin 不同，请求名也不同，因此由新席位执行。
3. 旧席位不再持有票据。它如果仍提交结论，`step` 在第 2 步拒绝。

## W3 review 不通过，裁定维持

1. reviewer 回复不通过（`ok = false`，理由写在 note）→ 结论为 `valid(fail)`，尚未裁定 → Main `decide(findings)`。守卫抑制 gate。
2. 裁定 `upheld(owner)`。裁定针对的是这条结论本身，不会让它失效 → 出现 owner 待修复项 → Owner `fix`，pin 为 `(h, 结论 id)`，简报附结论的理由。
3. owner 推送 h' 并回复 `PrSubmit` → 旧结论变为 `stale`，待修复项随之消失 → 在 h' 上重新给出 review 与 accept。

## W4 不通过的结论被驳回或判为范围外

review 或 accept 的不通过结论被裁定为 `rejected` 或 `outOfScope` 时算作一次取代事件 → attempt + 1 → 请求名变为 `-a2` → 由新席位重做这一次 gate。被驳回的 review 结论进入之后 review 的清单；`outOfScope` 另由草稿开新 issue。

## W4b 本议程的 PR 被放弃后重新交付

1. owner 回复 `Claim(blocked)`（推送被拒）→ Main `decide(claim)` → `replacePr`；或者 P 被人未合并就关闭。
2. P 不再可维护 → `ours = none`；deliver 的取代事件加一 → attempt + 1 → 新的 `deliver` 与已完结的那张 id 不同。
3. owner 推送新分支并回复 `PrSubmit` → `applied` 为假 → `openPr` 创建新 PR 并登记进 `prs`。

## W5 只改证据的修复

1. 不通过的理由是缺少证据，裁定为 `upheld(owner)` → `fix`。
2. owner 用同一个 h 回复 `PrSubmit` → `updatePr` 完成之前 `materialized = pending`；完成后 PR 正文哈希变化 → review 变为 `stale` → 给出新的 `review`。
3. accept 的清单不含 PR 正文，所以 accept 结论仍然有效。

## W6 owner 提问，裁定为设计缺口（`withPr`）

1. `Claim(question)` 是中间型回复，不完结任何票据 → Main `decide(claim)`。owner 的票据照常存在，简报写明暂停依赖该点的部分。
2. 主会话把 d 推到设计分支，然后回复 `designGap(withPr(d))`，附带正文替换 → 契约里登记 d 与待应用的替换 → `applyBody`。
3. 效应完成之前 `materialized = pending`。完成后，owner 的简报要求合入 d；`step` 检查后续 `PrSubmit` 的 head 是否包含 d。已有的 gate 结论全部 `stale`。

## W7 reviewer 在 gate 进行中提问

1. 同一 context 内有未决的主张，守卫抑制 gate；reviewer 此刻不持有票据，可以 `yield`。
2. 裁定为 `answered` 或 `outOfDomain`：清单不变，同一个请求名的票据重新出现。席位若 `parked` → Main `wake`；若 `live` → 直接投递。
3. 裁定为 `designGap`：清单变化，由新的 reviewer 执行。

## W8 验收未通过，裁定为验收方法不成立

1. `valid(fail)` → Main `decide(findings)`。
2. 裁定 `acceptanceMethod`：替换验收行，附上承接该义务的 issue 草稿 → `applyBody` 与 `createIssue`，期间 `materialized = pending`。
3. 效应完成后，正文哈希变化 → accept 变为 `stale` → 给出新的 `accept`。

## W9 合并后验收失败

1. postMerge 有效且失败 → Main `decide(postMergeFail)`：裁定 `correction`，附草稿，锚点为 `correctionOf(M)`。
2. `createIssue` → c1 进入修正链，结局为 `pending` → c1 成为活跃成员，按 W1 交付。
3. c1 合并后 → pin 包含 M 与 c1 的合并提交，属于一次新的观察 → Gate `postMerge`，覆盖两者。
4. 通过 → 单元到达终点。
5. c1 被裁定为 `noCode` → 没有新的合并提交，但 pin 包含全部成员及其正文哈希，成员集合多了 c1，所以 pin 变了 → Gate `postMerge`，覆盖 M 与 c1。M 的合并发生在议程召集之后，所以仍在 M 的合并提交上重新验收（R5）。

## W10 召集前已经由合并的 PR 关闭

结局为 `delivered`（不论 PR 是谁开的）→ Gate `postMerge`，pin 为该合并提交。验收者在当前默认分支 head 上执行，这个 head 包含该合并提交 → 通过即到达终点。默认分支继续前进不影响 pin，也不让结论失效。

## W11 召集前被人工关闭，没有裁定理由

1. 结局为 `pending`，issue 已关闭且不是被合并关闭，状态里没有钉住当前关闭事件的 `closed` 裁定 → Main `decide(closed)`。
2. 裁定 `confirmedNoCode` → 结局变为 `noCode`，单元里全是 `noCode` 成员 → 到达终点。
3. 裁定 `reopen` → Program `reopen` → 按 W1 交付。

## W12 issue 开着，但已经满足

主会话不持票据，主动提出 `Decision(noCode, confirmed)` → `step` 走主动提出的分支，写入 noCode 确认 → 结局变为 `noCode` → 对账 → Program `close` → 到达终点。

## W13 拆分

1. owner 回复 `Claim(split)`，这是中间型回复，`deliver` 仍然存在。简报写明「等待裁定，可以 yield」→ Main `decide(claim)`。
2. `confirmed`：附带正文替换，以及锚点为 `before(M)`（新 issue 是前置条件时）或 `after(M)` 的草稿 → 正文变化，`deliver` 的内容按收窄后的范围更新。锚点为 `before` 时，新 issue 成为新的当前单元。
3. `refuted`：`deliver` 始终没有完结，owner 继续交付。

## W14 他人的 PR

1. 他人的 PR 关闭 M，但不在 M 的 `prs` 里 → 不算 `ours` → `ours = none` → Owner `deliver`。
2. 他人的 PR 先合并 → M 的结局为 `delivered`（结局不看作者），owner 的义务随之消失，进入验证阶段。

## W15 召集时指定接管的 PR

召集载荷指定接管 P → `ours = maintainable` → 按 gate 规则给出 review 与 accept；此时没有 owner 票据，也不派 owner。只有出现 owner 义务（`fix`）时，才派出 owner，续作简报包含 P 的分支与 head。P 合并后判为 `delivered`。

## W16 结局确立后又被重开

1. 最近一次重开事件还没有钉住它的 `reopened` 裁定 → Main `decide(reopened)`。
2. 各裁定的后果：
   - `restore` → Program `close`；之后不再有更新的重开事件，这一行不再成立。
   - `correction` → 进入 W9 的第 1 步；修正链交付完、postMerge 覆盖全部成员并通过之后，对账 → Program `close` 重新关闭 M。
   - `reopenAccepted` → 清除 noCode 确认，成员回到 `pending`，按 W1 交付。
3. 没有重开事件、只是合并后 issue 没自动关闭 → Program `close`。

## W17 设计 commit 失去承载者

d 不在默认分支上，也没有任何可维护的 PR 包含它，承载者已不能承载 → Main `decide(orphanDesign)` → 裁定附设计承接项的草稿。该条目 `designOnly = true`，规则直接把 owner 类义务交给主会话。

## W18 `defaultFirst` 的迁移失去承担者

迁移来源尚未满足，承担迁移的成员已关闭 → Main `decide(migration)` → 迁移草稿插在当前单元之后，成为下一项。

## W19 树关闭

1. parent 的某个子 issue 不在议程里，也没有已核实的终点事实 → Main `decide(agendaGap)`。
2. 全部单元到达终点，没有滞留的设计义务 → Gate `closure`。
3. 通过 → Program `closeParent`；失败 → Main `decide(closureFail)`。
4. parent 在没有有效通过的情况下被关闭 → Program `reopen(parent)`，之后照常执行 `closure`。

## W20 等待

`mergeable = unknown`，或 `checks = pending | unknown`，其他条件都已满足 → 不给出义务，也不算停滞。

## W21 checks 在同一个 head 上反复失败

1. `checks = fail`，当前失败的 check run 为 r1 → Owner `fix`，pin 为 r1。
2. owner 判断代码没有问题，用同一个 h 回复 `PrSubmit`，完结 `fix`；checks 仍失败在 r1 → r1 已经引出过一次完结的 `fix` → Main `decide(checks)`，pin 为 r1。
3. 各裁定的后果：
   - `rerun` → Program `rerunChecks`，执行后裁定置为已执行。新 run r2 仍然失败 → r2 还没有引出过 `fix` → Owner `fix`，pin 为 r2；之后如果仍失败在 r2，再次 `decide(checks)`，pin 为 r2。
   - `fixNeeded` → 产生 owner 待修复项 → Owner `fix`，pin 为该裁定。
   - `external` → 进入等待集合，并立即报告操作员。

## W22 owner 中途 aborted

1. 状态里的持有者是 X，现在 X 在 registry 中的状态为 aborted，已不可用；也没有待回执的 agent → Main `spawn`，pin 为（请求名，X），简报写明派出。
2. 主会话用原生 `task` 派出，registry 追加 `-2`，实际 id 为 Y。Y 是待回执的 agent，票据仍在，简报改为「只需回执」→ 主会话回复 `Decision(seated{Y})`；`step` 核对 Y 是待回执的 agent，然后把持有者改为 Y。即使 Y 在回执之前就完成了自己的工作，这张回执票据依然存在。主会话没回执就结束这一轮时，`agent_end` 检查会要求它先回执。
3. 续作 owner 回到同一个工作目录，先检查未推送的提交。

## W23 效应执行失败

某个效应执行失败，最近一次失败还没有钉住它的裁定 → 该效应暂停执行 → Main `decide(effectFailed)`，pin 为（效应 id，失败时间）：
- `retry`：只放行这一次失败，下一轮重新执行；再失败时，失败时间不同，于是得到新的裁定票据。
- `external`：该效应在裁定有效期间不再执行，进入等待集合，并报告操作员。

如果这个效应属于 `materialized` 的范围，在它完成之前，gate 与合并一直被抑制。

## W24 收尾报告

交付完成，状态里还没有报告 → Main `report` → 主会话在对话里把报告交给操作员，并回复 `Decision(report)`，状态记为已报告。

## W25 同一 parked 期的重复唤醒

持有者 X 进入 parked，起点为 t → Main `wake`，pin 为（X，t）→ 主会话回复 `woken{X}`，状态记下已唤醒 t，然后唤醒。X 在唤醒生效前仍是 parked、起点仍为 t → 已唤醒的就是这一期，不再推导出票据，不再写状态。X 之后再次 parked，起点为 t' → 新的一张 `wake`。
