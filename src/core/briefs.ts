// Brief templates: the text every obligation carries (docs/design/core.briefs.md).
// A brief must be self-contained: the holder may have lost all context to compaction.

import type { Classified, ClosureWitness, EffectWitness, MemberWitness, ReconcileWitness, SeatWitness, SubjectWitness, Unit, VerificationWitness } from "./classify.ts";
import { canonical, issueKey } from "./identity.ts";
import type { MemberSituation } from "./situation.ts";
import type { AgentId, Hash, IssueRef, PendingClaim, Policy, PrRef, StoredVerdict } from "./types.ts";

export type BriefInput =
  | { readonly kind: "deliver" | "fix"; readonly member: MemberWitness; readonly situation: MemberSituation }
  | { readonly kind: "review" | "accept"; readonly member: MemberWitness }
  | { readonly kind: "postMerge"; readonly verification: VerificationWitness }
  | { readonly kind: "closure"; readonly closure: ClosureWitness }
  | { readonly kind: "decideClaim"; readonly member: MemberWitness; readonly claim: PendingClaim }
  | { readonly kind: "decideVerificationClaim"; readonly claim: PendingClaim; readonly rowOwners: readonly { readonly issue: IssueRef; readonly bodyHash: Hash | null }[] }
  | { readonly kind: "decideFindings"; readonly member: MemberWitness; readonly verdict: StoredVerdict }
  | { readonly kind: "designFix"; readonly member: MemberWitness; readonly verdict: StoredVerdict }
  | { readonly kind: "decideChecks"; readonly member: MemberWitness }
  | { readonly kind: "decideReopened" | "decideClosed"; readonly reconcile: ReconcileWitness }
  | { readonly kind: "decidePostMergeFail"; readonly verification: VerificationWitness; readonly verdict: StoredVerdict }
  | { readonly kind: "decideClosureFail"; readonly closure: ClosureWitness; readonly verdict: StoredVerdict }
  | { readonly kind: "decideSubject"; readonly subject: SubjectWitness }
  | { readonly kind: "decideEffectFailed" | "decideEffectConflict"; readonly effect: EffectWitness }
  | { readonly kind: "report"; readonly units: readonly Unit[] }
  | { readonly kind: "spawn"; readonly seat: SeatWitness; readonly acknowledgeOnly: boolean; readonly pending: AgentId | null; readonly agent: string | null; readonly assignment: string | null }
  | { readonly kind: "acknowledge"; readonly requestName: string; readonly agent: AgentId; readonly previous: AgentId | null }
  | { readonly kind: "wake"; readonly seat: SeatWitness; readonly agent: AgentId }
  | { readonly kind: "stall"; readonly classified: Classified }
  | { readonly kind: "program"; readonly what: string };

/** Identity block shared by every brief (core.briefs.md「身份」). */
export interface BriefIdentity {
  readonly id: string;
  readonly kind: string;
  readonly context: string;
  readonly requestName: string | null;
  readonly workDir: string | null;
  readonly pin: unknown;
  readonly parent: IssueRef | null;
}

const issueUrl = (i: IssueRef): string => `https://github.com/${i.repo.owner}/${i.repo.name}/issues/${i.number}`;
const prUrl = (p: PrRef): string => `https://github.com/${p.repo.owner}/${p.repo.name}/pull/${p.number}`;

const SEAT_DIVISION = [
  "## 分工",
  "- 你只对自己持有的这张票据负责，不与其他席位就协议事务交流；契约问题只用端口提交 `Claim(question)`。",
  "- 不向操作员提问。设计权威文件只由主会话修改。",
  "- 不用 `gh` 或任何客户端写 GitHub（评论、编辑、关闭、合并都不行）；可以用 `gh`、`issue://`、`pr://` 完整读取 issue、PR、评论、checks 与图边。git 提交与推送照常用原生命令。",
  "## 目标 repo 规则",
  "- 动手前先读目标 repo 的 `AGENTS.md`、`CLAUDE.md` 与 rules，并遵守。",
  "## 证据",
  "- 回复一律通过圆桌端口工具提交；证据写进回复载荷本身。`local://` 只在本会话可读，不能作为回复中的证据。不限制长度。",
].join("\n");

function identityBlock(ident: BriefIdentity, completion: string): string {
  return [
    `# 圆桌票据：${ident.kind}`,
    `- 票据 id：${ident.id}`,
    `- context：${ident.context}`,
    ident.requestName === null ? "" : `- 请求名：${ident.requestName}`,
    ident.workDir === null ? "" : `- 工作目录：${ident.workDir}。在这里基于远端提交另建 clone 或 worktree，不在继承来的隔离工作区里改动。`,
    `- pin：${canonical(ident.pin)}`,
    ident.parent === null ? "" : `- parent：${issueUrl(ident.parent)}`,
    `- 完结方式：${completion}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function seatBrief(ident: BriefIdentity, completion: string, sections: readonly string[], policy: Policy): string {
  return [identityBlock(ident, completion), SEAT_DIVISION, ...sections, "## 策略原文（逐字）", policy.appendSystem, policy.systemBlocks]
    .filter((l) => l !== "")
    .join("\n\n");
}

function mainBrief(ident: BriefIdentity, title: string, facts: string, options: string): string {
  return [
    identityBlock({ ...ident, kind: `${ident.kind}（主会话）：${title}` }, "用端口回复对应的 `Decision`；只有回复才算消费这张票据。"),
    "- 圆桌是唯一的协议渠道。子席位 yield 时的文字会作为原生消息送达你，但它不是回复，不据此行动。",
    "## 事实",
    facts,
    "## 可选裁定与要求",
    options,
  ].join("\n\n");
}

function readingList(m: MemberWitness, ident: BriefIdentity): string {
  return [
    "## 必读（动手前通读全文，不以 grep 代替）",
    `- issue 全文与全部评论：${issueUrl(m.entry.issue)}`,
    ident.parent === null ? "" : `- parent 的契约与设计修正评论：${issueUrl(ident.parent)}`,
    m.contractDecisions.length === 0 ? "" : `- 适用的契约裁定：${m.contractDecisions.join(", ")}。它们的内容已写进 issue 正文与下列设计 commit。`,
    "- issue 列出的全部设计章节、契约类型与例子。",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const ROUTES =
  "设计路线：defaultFirst 仅在 umbrella 或 repo 约定契约修正先落默认分支、且 repo 规则与权限允许直接提交时可选，推送被拒就改选其他路线；withPr 的 commit 在设计分支上，由发现或提问所在的成员合入；future 需要同 repo 的后续承载者，没有就附设计承接项的草稿。";

const VERDICT_COMPLETION =
  "用端口回复 `verdict`：`ok` 为 true 或 false，`note` 写理由（不通过时写清问题、位置与复现方式）。head、验收行与观察到的提交由程序按票据的 pin 盖入，不用填写。";

function replyFact(label: string, id: string, payload: unknown): string {
  return `- ${label} ${id}：${canonical(payload)}`;
}

function memberFacts(m: MemberWitness): string {
  return [
    `- 成员：${issueUrl(m.entry.issue)}，当前正文哈希 ${m.issue?.bodyHash ?? "?"}`,
    m.pr === null ? "- PR：尚无" : `- PR：${prUrl(m.pr.ref)}，head ${m.pr.head}，checks ${m.pr.checks.state}`,
  ].join("\n");
}

export function briefFor(input: BriefInput, ident: BriefIdentity, policy: Policy): string {
  switch (input.kind) {
    case "deliver":
    case "fix": {
      const m = input.member;
      const pause =
        input.situation.claim === "question"
          ? "- 你的契约问题尚未裁定：暂停依赖该点的部分，继续其余部分。"
          : input.situation.claim === "none"
            ? ""
            : "- 你的主张正在等待裁定，可以 yield；裁定后票据会重新投递给你。";
      return seatBrief(
        ident,
        "推送分支后，用端口回复 `PrSubmit`（分支、观察到的 head、标题、正文、PR 模板类型；重试时加重试说明）。",
        [
          readingList(m, ident),
          [
            "## 交付",
            `- 交付目标：${m.entry.target.repo.owner}/${m.entry.target.repo.name}，base ${m.entry.target.base}，起点：${m.startSha ?? `远端 ${m.entry.target.base} 分支的当前 head`}。`,
            m.pr === null ? "- 新开分支；PR 由程序依据你的 PrSubmit 创建。" : `- 沿用 PR ${prUrl(m.pr.ref)}，当前 head ${m.pr.head}。`,
            m.designCommits.length > 0 ? `- 必须合入的设计 commit：${m.designCommits.join(", ")}（圆桌会检查 head 是否包含它们）。` : "",
            "- PR 正文按 `writing-pr` 选模板：纯文档 PR 用思路要点模板；其他 PR 用四层证据：Layer 2 读回关键行，Layer 4 逐条经真实入口观察正负路径，测试计数只放卫生检查。",
            "- 发现无需代码、需要拆分，或被阻塞（例如推送被拒——不强推）时，回复 `Claim(noCode|split|blocked)`。",
            "- 续作时：先检查工作目录里未推送的提交。",
            input.kind === "fix" && m.fixTrigger !== null
              ? [
                  `- 触发原因：${canonical(m.fixTrigger)}；check run 在 PR 的 checks 页。`,
                  m.ownerVerdict === null ? "" : replyFact("引出修复的结论", m.ownerVerdict.id, { verdict: m.ownerVerdict.verdict, adjudication: m.ownerVerdict.adjudication }),
                  m.repairRationale === null ? "" : `- 主会话裁定的理由：${m.repairRationale}`,
                ]
                  .filter((l) => l !== "")
                  .join("\n")
              : "",
            pause,
          ]
            .filter((l) => l !== "")
            .join("\n"),
        ],
        policy,
      );
    }
    case "review": {
      const m = input.member;
      return seatBrief(
        ident,
        VERDICT_COMPLETION,
        [
          readingList(m, ident),
          [
            "## 做法",
            `- PR ${m.pr === null ? "?" : prUrl(m.pr.ref)}，HEAD ${m.pr?.head ?? "?"}，base ${m.entry.target.base}。在工作目录里干净 detached checkout 该 HEAD 并确认；HEAD 变化就停下回复。`,
            "- 先读 `skill://review-pr`，依次跑 Gate 1–5，首个失败即停；以 issue 契约为准，不扩大范围；不派审查子代理。",
            "- 此前被驳回、且没有新证据的问题不再提出。问题落在主会话的 commit 上时，在 note 里写明。",
          ].join("\n"),
        ],
        policy,
      );
    }
    case "accept": {
      const m = input.member;
      return seatBrief(
        ident,
        `${VERDICT_COMPLETION} ok 表示每一条验收行都通过。`,
        [
          readingList(m, ident),
          [
            "## 做法",
            `- PR ${m.pr === null ? "?" : prUrl(m.pr.ref)}，HEAD ${m.pr?.head ?? "?"}。在工作目录里干净 detached checkout 该 HEAD 并确认。`,
            "- 经真实入口逐条观察验收行的正负路径：纯库在仓库外自写 driver；CLI 用真实命令；Web 走 `skill://agent-browser`；纯文档核对文档间语义。不复用作者的 driver 与测试，最后跑 repo 校验，不改 repo。",
          ].join("\n"),
        ],
        policy,
      );
    }
    case "postMerge": {
      const v = input.verification;
      const merges = v.manifest.gate === "postMerge" ? v.manifest.merges.map((o) => `${o.repo.owner}/${o.repo.name}@${o.commit}`).join(", ") : "";
      return seatBrief(
        ident,
        `${VERDICT_COMPLETION} ok 表示覆盖成员的每一条验收行都通过；与本次无关的失败写在 note 里并写明为什么无关。`,
        [
          [
            "## 必读",
            ...v.unit.members.map((m) => `- ${issueUrl(m.issue)}（全文与全部评论）`),
          ].join("\n"),
          [
            "## 做法",
            `- 合并提交：${merges}。`,
            v.legacy
              ? "- 召集前已合并的遗留项：在当前默认分支 head 的干净 checkout 上执行，该 head 必须包含上述合并提交。"
              : "- 每个 repo 在该 repo 中最新合并提交的干净 checkout 上执行（R5），它必须包含该 repo 的其余合并提交。",
            "- 部署型 repo 在交付规则规定的目标环境里执行。经真实入口逐条观察覆盖成员的验收行，最后跑 repo 校验。",
          ].join("\n"),
        ],
        policy,
      );
    }
    case "closure":
      return seatBrief(
        ident,
        `${VERDICT_COMPLETION} ok 表示 parent 关闭验证的每一行都通过。`,
        [
          [
            "## 做法",
            `- parent：${input.closure.parent === null ? "?" : issueUrl(input.closure.parent)}。`,
            "- 对每个交付目标 repo，在包含该 repo 全部合并提交的默认分支 head 上，经真实入口逐行核对关闭验证，并核对每个子 issue 的终点事实。",
          ].join("\n"),
        ],
        policy,
      );
    case "decideClaim":
      return mainBrief(
        ident,
        "裁定契约问题或主张",
        [replyFact("主张", input.claim.id, input.claim.claim), memberFacts(input.member)].join("\n"),
        [
          "question：",
          "- answered 或 outOfDomain：主张结束，owner 按你的答复继续原票据。",
          "- implDefect：owner 得到修复票据。",
          `- designGap(route)：改变契约，已有结论失效、gate 重新执行。${ROUTES}`,
          `- acceptanceMethod：改变契约，须附对成员验收行的正文替换，基准为当前正文哈希 ${input.member.issue?.bodyHash ?? "?"}；gate 重新执行。`,
          "noCode / split：confirmed 改变结局（noCode 结束该成员；split 须附拆分后的正文替换与草稿）；refuted 让 owner 继续原票据。",
          "blocked：replacePr 放弃当前 PR，owner 以新的 attempt 重新交付；external 让该成员进入等待集合，须立即报告操作员；refuted 让 owner 继续。",
        ].join("\n"),
      );
    case "decideVerificationClaim":
      return mainBrief(
        ident,
        "裁定验收席位的契约问题",
        [
          replyFact("主张", input.claim.id, input.claim.claim),
          ...input.rowOwners.map((o) => `- 验收行所在 issue：${issueUrl(o.issue)}，当前正文哈希 ${o.bodyHash ?? "?"}`),
        ].join("\n"),
        [
          "- answered 或 outOfDomain：主张结束，席位按你的答复继续原票据。",
          `- designGap(route)：改变契约。${ROUTES}`,
          "- acceptanceMethod：改变契约，须附对上列验收行所在 issue 之一的正文替换，基准为该 issue 的当前正文哈希；验收以新的验收行重新执行。",
        ].join("\n"),
      );
    case "decideFindings":
      return mainBrief(
        ident,
        "裁定 gate 的不通过结论",
        [replyFact("结论", input.verdict.id, input.verdict.verdict), memberFacts(input.member)].join("\n"),
        [
          "对这条结论给出一个裁定：",
          "- upheld(owner)：owner 得到修复票据；upheld(main)：你得到 designFix 票据，在设计分支上修复。",
          "- rejected(依据)：结论作废，该 gate 以新的 attempt 重新执行，review 清单会带上这条被驳回的结论。",
          "- outOfScope(附草稿)：问题移出本 PR，草稿由程序建成新 issue；该 gate 以新的 attempt 重新执行。",
          `- designGap(route)：改变契约，已有结论失效、gate 重新执行。${ROUTES}`,
          `- acceptanceMethod：改变契约，须附对成员验收行的正文替换，基准为当前正文哈希 ${input.member.issue?.bodyHash ?? "?"}；gate 重新执行。`,
        ].join("\n"),
      );
    case "designFix":
      return mainBrief(
        ident,
        "修复设计 commit 上被维持的发现",
        [replyFact("结论", input.verdict.id, { verdict: input.verdict.verdict, adjudication: input.verdict.adjudication }), memberFacts(input.member)].join("\n"),
        "在设计分支上修复后，回复 Decision(designFix) 附 commit；之后 owner 得到合入该 commit 的修复票据，gate 重新执行。",
      );
    case "decideChecks":
      return mainBrief(
        ident,
        "checks 在同一个 head 上反复失败",
        [`- 失败 run：${input.member.failedRun ?? "?"}（owner 已就这个 run 完成过一次修复）`, memberFacts(input.member)].join("\n"),
        [
          "- rerun：程序重跑 checks；之后仍失败，交给下一次 decide(checks)。",
          "- fixNeeded：owner 得到修复票据，须推送新 head。",
          "- external：该成员进入等待集合，须立即报告操作员。",
        ].join("\n"),
      );
    case "decideReopened":
      return mainBrief(
        ident,
        "结局确立后 issue 被重新打开",
        `- 成员：${issueUrl(input.reconcile.member)}\n- 重开事件：${input.reconcile.eventForDecision ?? "?"}`,
        [
          "- restore：程序重新关闭该 issue。",
          "- correction(附修正草稿，锚点 correctionOf)：草稿建成新 issue 并进入议程；单元重新通过 postMerge 之后，程序关闭该 issue。",
          "- reopenAccepted（仅限结局为 noCode 的成员）：撤销 noCode 确认，成员回到待交付。",
        ].join("\n"),
      );
    case "decideClosed":
      return mainBrief(
        ident,
        "待交付成员已被关闭",
        `- 成员：${issueUrl(input.reconcile.member)}\n- 关闭事件：${input.reconcile.eventForDecision ?? "?"}\n- 当前正文哈希：${input.reconcile.bodyHash ?? "?"}`,
        [
          "- confirmedNoCode(附理由)：成员结局为 noCode，裁定钉住当前正文哈希；正文之后变化则失效。",
          "- reopen：程序重新打开该 issue，成员继续交付。",
        ].join("\n"),
      );
    case "decidePostMergeFail":
      return mainBrief(
        ident,
        "合并后验收失败",
        replyFact("结论", input.verdict.id, input.verdict.verdict),
        [
          "- correction(附修正草稿，锚点 correctionOf)：草稿建成新 issue 并插入议程，修正落地后再验收。",
          "- reverify：以新的 attempt 在同一提交上重新验收。",
        ].join("\n"),
      );
    case "decideClosureFail":
      return mainBrief(
        ident,
        "树关闭验收失败",
        replyFact("结论", input.verdict.id, input.verdict.verdict),
        ["- 补项草稿：建成新 issue 并插入议程，落地后再做关闭验收。", "- reverify：以新的 attempt 重新做关闭验收。"].join("\n"),
      );
    case "decideSubject":
      return mainBrief(
        ident,
        `裁定 ${input.subject.subject}`,
        `- ${canonical(input.subject)}`,
        ["- resolved(附草稿或插入)：补上缺失的承载者、迁移或议程项。", "- external：进入等待集合，须立即报告操作员。"].join("\n"),
      );
    case "decideEffectFailed":
      return mainBrief(
        ident,
        "程序效应执行失败",
        `- 效应 ${input.effect.id}（${input.effect.target.kind}）：${canonical(input.effect.target)}`,
        [
          "- retry：只放行这一次失败，程序重新执行；再失败会得到新的票据。",
          "- external：该裁定有效期间不再执行，进入等待集合，须立即报告操作员。",
        ].join("\n"),
      );
    case "decideEffectConflict":
      return mainBrief(
        ident,
        "正文替换的基准哈希已不符",
        `- 效应 ${input.effect.id}：${canonical(input.effect.target)}`,
        `- 回复 Decision(stall{key: ${input.effect.conflictKey}})：resolved 时附上以当前正文哈希为基准的新替换，它取代这次冲突的替换；external 表示外部阻塞，须立即报告操作员。`,
      );
    case "report":
      return mainBrief(
        ident,
        "交付完成，写给操作员的汇总",
        input.units.map((u) => u.members.map((m) => issueUrl(m.issue)).join(" → ")).join("\n"),
        "列出每项结局与 PR、issue 链接，以及各验收结论的要点；树关闭结论；意外写回主会话工作 checkout 的路径。在对话里把报告交给操作员，然后回复 Decision(report)。",
      );
    case "spawn":
      return input.acknowledgeOnly
        ? mainBrief(ident, "回执已派出的席位", `请求名 ${input.seat.requestName}，待回执 agent ${input.pending ?? "?"}`, "先执行、再回执：它已存在，直接回复 Decision(seated{agentId})。")
        : mainBrief(
            ident,
            "派出席位",
            `请求名 ${input.seat.requestName}（${input.seat.role}），成员 ${issueUrl(input.seat.issue)}`,
            [
              `先执行、再回执：用原生 \`task\` 派出；参数 agent 为 ${input.agent ?? "?"}；isolated: true；name 取请求名；assignment 取下面的简报原文。`,
              "前提：宿主设置 async.enabled 为真，并且该 agent 类型没有声明 blocking: true。",
              "派出后回复 Decision(seated{agentId})，agentId 取 task 返回的实际 id。",
              input.assignment === null ? "" : `\n---\n${input.assignment}`,
            ].join("\n"),
          );
    case "acknowledge":
      return mainBrief(ident, "回执已存在的席位", `请求名 ${input.requestName}，agent ${input.agent}，上一任 ${input.previous ?? "无"}`, "直接回复 Decision(seated{agentId})。");
    case "wake":
      return mainBrief(
        ident,
        "唤醒席位",
        `agent ${input.agent}（请求名 ${input.seat.requestName}，成员 ${issueUrl(input.seat.issue)}），本次 parked 期起点 ${input.seat.parkedSince ?? "?"}`,
        `先回执、再执行：先回复 Decision(woken{agentId: ${input.agent}, parkedSince: ${input.seat.parkedSince ?? "?"}})，再用原生 \`write agent://<id>\` 唤醒。`,
      );
    case "stall":
      return mainBrief(
        ident,
        "停滞：推导不出任何义务，也不在等待集合里",
        canonical(input.classified.stall),
        `回复 Decision(stall{key: ${input.classified.stall.key}})：resolved 附上补充事实（草稿、插入）；external 表示外部阻塞，须立即报告操作员。`,
      );
    case "program":
      return `程序效应：${input.what}（${ident.id}）`;
    default:
      return assertNever(input);
  }
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
