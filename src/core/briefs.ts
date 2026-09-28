// Brief templates: the text every obligation carries (docs/design/core.briefs.md).
// A brief must be self-contained: the holder may have lost all context to compaction.

import type { ClosureWitness, EffectWitness, MemberWitness, ReconcileWitness, SeatWitness, SubjectWitness, Unit, VerificationWitness } from "./classify.ts";
import { issueKey } from "./identity.ts";
import type { MemberSituation } from "./situation.ts";
import type { AgentId, Policy, StoredRecord } from "./types.ts";
import type { Classified } from "./classify.ts";

export type BriefInput =
  | { readonly kind: "deliver" | "fix"; readonly member: MemberWitness; readonly situation: MemberSituation }
  | { readonly kind: "review" | "accept"; readonly member: MemberWitness }
  | { readonly kind: "postMerge"; readonly verification: VerificationWitness }
  | { readonly kind: "closure"; readonly closure: ClosureWitness }
  | { readonly kind: "decideClaim"; readonly member: MemberWitness; readonly claim: StoredRecord }
  | { readonly kind: "decideVerificationClaim"; readonly claim: StoredRecord }
  | { readonly kind: "decideFindings"; readonly member: MemberWitness; readonly verdict: StoredRecord }
  | { readonly kind: "designFix"; readonly member: MemberWitness; readonly verdict: StoredRecord }
  | { readonly kind: "decideChecks"; readonly member: MemberWitness }
  | { readonly kind: "decideReopened" | "decideClosed"; readonly reconcile: ReconcileWitness }
  | { readonly kind: "decidePostMergeFail"; readonly verification: VerificationWitness; readonly verdict: StoredRecord }
  | { readonly kind: "decideClosureFail"; readonly closure: ClosureWitness; readonly verdict: StoredRecord }
  | { readonly kind: "decideSubject"; readonly subject: SubjectWitness }
  | { readonly kind: "decideEffectFailed" | "decideEffectConflict"; readonly effect: EffectWitness }
  | { readonly kind: "report"; readonly units: readonly Unit[] }
  | { readonly kind: "spawn"; readonly seat: SeatWitness; readonly acknowledgeOnly: boolean; readonly pending: AgentId | null; readonly assignment: string | null }
  | { readonly kind: "acknowledge"; readonly requestName: string; readonly agent: AgentId; readonly previous: AgentId | null }
  | { readonly kind: "wake"; readonly seat: SeatWitness; readonly agent: AgentId }
  | { readonly kind: "stall"; readonly classified: Classified }
  | { readonly kind: "program"; readonly what: string };

const COMMON_DIVISION = [
  "## 分工",
  "- 你只对自己持有的这张票据负责，不与其他席位就协议事务交流；契约问题只用端口提交 `Claim(question)`。",
  "- 不向操作员提问。设计权威文件只由主会话修改。",
  "- 不用 `gh` 或任何客户端写 GitHub（评论、编辑、关闭、合并都不行）；可以用 `gh`、`issue://`、`pr://` 完整读取。git 提交与推送照常用原生命令。",
  "- 回复一律通过圆桌端口工具提交；证据写进回复载荷本身，不要只给 `local://` 路径。不限制长度。",
  "- 先读目标 repo 的 `AGENTS.md`、`CLAUDE.md` 与 rules。",
].join("\n");

function policyBlock(policy: Policy): string {
  return ["## 策略原文（逐字）", policy.appendSystem, policy.systemBlocks].join("\n\n");
}

function seatHeader(kind: string, member: MemberWitness | null, name: string | null, workDir: string | null, completion: string): string {
  return [
    `# 圆桌票据：${kind}`,
    member === null ? "" : `- 成员：${issueKey(member.entry.issue)}（交付目标 ${member.entry.target.repo.owner}/${member.entry.target.repo.name}@${member.entry.target.base}）`,
    name === null ? "" : `- 请求名：${name}`,
    workDir === null ? "" : `- 工作目录：${workDir}。在这里基于远端提交另建 clone 或 worktree，不在继承来的隔离工作区里改动。`,
    `- 完结方式：${completion}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function briefFor(input: BriefInput, policy: Policy): string {
  switch (input.kind) {
    case "deliver":
    case "fix": {
      const m = input.member;
      const pause =
        input.situation.claim === "question"
          ? "\n- 你的契约问题尚未裁定：暂停依赖该点的部分，继续其余部分。"
          : input.situation.claim === "none"
            ? ""
            : "\n- 你的主张正在等待裁定，可以 yield；裁定后票据会重新投递给你。";
      const trigger =
        input.kind === "fix" && m.fixTrigger !== null ? `\n- 触发原因：${JSON.stringify(m.fixTrigger)}（读 PR 上对应的记录）。` : "";
      return [
        seatHeader(input.kind, m, m.names.owner, null, "推送分支后，用端口回复 `PrSubmit`（分支、观察到的 head、标题、正文、PR 模板类型；重试时加重试说明）。"),
        COMMON_DIVISION,
        "## 交付",
        `- 起点：${m.entry.target.base}；${m.pr === null ? "新开分支，由程序创建 PR。" : `沿用 PR #${m.pr.ref.number}，head ${m.pr.head}。`}`,
        m.designCommits.length > 0 ? `- 必须合入设计 commit：${m.designCommits.join(", ")}` : "",
        "- 按 `writing-pr` 选模板：纯文档 PR 用思路要点模板；其他 PR 用四层证据，Layer 2 读回关键行，Layer 4 逐条经真实入口观察正负路径，测试计数只放卫生检查。",
        "- 发现无需代码、需要拆分或被阻塞（例如推送被拒，不强推）时，回复 `Claim(noCode|split|blocked)`。",
        "- 续作时：先检查工作目录里未推送的提交。",
        trigger + pause,
        policyBlock(policy),
      ]
        .filter((l) => l !== "")
        .join("\n\n");
    }
    case "review": {
      const m = input.member;
      return [
        seatHeader("review", m, m.names.review, null, "用端口回复 `Verdict(review)`：观察到的 head、Gate 1–5 各自状态、每个发现的 file:line、后果、复现命令、责任人。"),
        COMMON_DIVISION,
        "## 做法",
        `- PR #${m.pr?.ref.number ?? "?"}，HEAD ${m.pr?.head ?? "?"}。在干净 detached checkout 上确认 HEAD，变化就停下回复。`,
        "- 按 `review-pr` 依次跑 Gate 1–5，首个失败即停；以 issue 契约为准，不扩大范围；不派审查子代理。",
        "- 此前被驳回、且没有新证据的发现不再提出。落在主会话 commit 上的发现，责任人写 main。",
        policyBlock(policy),
      ].join("\n\n");
    }
    case "accept": {
      const m = input.member;
      return [
        seatHeader("accept", m, m.names.accept, null, "用端口回复 `Verdict(accept)`：观察到的 head、每条验收行 id 的命令、输出与判定、未覆盖项、无关失败。"),
        COMMON_DIVISION,
        "## 做法",
        `- PR #${m.pr?.ref.number ?? "?"}，HEAD ${m.pr?.head ?? "?"}。在干净 detached checkout 上确认 HEAD。`,
        "- 经真实入口逐条观察验收行的正负路径：纯库在仓库外自写 driver；CLI 用真实命令；Web 走 `skill://agent-browser`；纯文档核对文档间语义。不复用作者的 driver 与测试，最后跑 repo 校验，不改 repo。",
        policyBlock(policy),
      ].join("\n\n");
    }
    case "postMerge": {
      const v = input.verification;
      const target = v.legacy
        ? "当前默认分支 head 的干净 checkout（它必须包含合并提交）"
        : `合并提交的干净 checkout：${v.manifest.gate === "postMerge" ? v.manifest.merges.map((o) => `${o.repo.name}@${o.commit}`).join(", ") : ""}`;
      return [
        seatHeader("postMerge", null, v.name, null, "用端口回复 `Verdict(postMerge)`：每个 repo 观察到的提交、每条验收行的命令、输出与判定、无关失败（写明为什么无关）。"),
        COMMON_DIVISION,
        "## 做法",
        `- 覆盖成员：${v.unit.members.map((m) => issueKey(m.issue)).join(", ")}。`,
        `- 在${target}上，经真实入口逐条观察；部署型 repo 在交付规则规定的目标环境里执行；最后跑 repo 校验。`,
        policyBlock(policy),
      ].join("\n\n");
    }
    case "closure":
      return [
        seatHeader("closure", null, input.closure.name, null, "用端口回复 `Verdict(closure)`：每个 repo 观察到的提交、parent 关闭验证逐行结果。"),
        COMMON_DIVISION,
        `- parent：${input.closure.parent === null ? "?" : issueKey(input.closure.parent)}。对每个交付目标 repo，在包含全部合并提交的默认分支 head 上逐行核对关闭验证，并核对每个子 issue 的终点事实。`,
        policyBlock(policy),
      ].join("\n\n");
    case "decideClaim":
    case "decideVerificationClaim":
      return mainBrief(
        "裁定契约问题或主张",
        `记录：${input.claim.id}。内容：${JSON.stringify(input.claim.body)}`,
        "可选：question → answered | outOfDomain | implDefect | designGap(route) | acceptanceMethod；noCode/split → confirmed | refuted；blocked → replacePr | external | refuted。设计路线：defaultFirst 仅在约定契约修正先落默认分支且允许直接提交时可选，推送被拒就改选；future 需要同 repo 的后续承载者，没有就附设计承接项草稿。需要替换正文时附基准哈希。",
      );
    case "decideFindings":
      return mainBrief("裁定 gate 发现", `结论：${input.verdict.id}。内容：${JSON.stringify(input.verdict.body)}`, "对每个发现：upheld(owner|main) | rejected(依据) | outOfScope(附草稿) | designGap(route) | acceptanceMethod。");
    case "designFix":
      return mainBrief("修复设计 commit 上被维持的发现", `结论：${input.verdict.id}`, "在设计分支上修复后，回复 Decision(designFix) 附 commit；owner 会被要求合入。");
    case "decideChecks":
      return mainBrief("checks 在同一个 head 上反复失败", `PR：${input.member.pr?.ref.number ?? "?"}，失败 run：${input.member.failedRun ?? "?"}`, "可选：rerun | fixNeeded | external（external 需立即报告操作员）。");
    case "decideReopened":
      return mainBrief("结局确立后 issue 被重新打开", `成员：${issueKey(input.reconcile.member)}，事件：${input.reconcile.eventForDecision ?? "?"}`, "可选：restore | correction(附修正草稿，锚点 correctionOf)；成员结局为 noCode 时还可选 reopenAccepted（撤销确认，回到待交付）。");
    case "decideClosed":
      return mainBrief("待交付成员已被关闭", `成员：${issueKey(input.reconcile.member)}，事件：${input.reconcile.eventForDecision ?? "?"}，正文哈希：${input.reconcile.bodyHash ?? "?"}`, "可选：confirmedNoCode(附理由) | reopen。");
    case "decidePostMergeFail":
      return mainBrief("合并后验收失败", `结论：${input.verdict.id}`, "可选：correction(附修正草稿，锚点 correctionOf) | reverify。");
    case "decideClosureFail":
      return mainBrief("树关闭验收失败", `结论：${input.verdict.id}`, "可选：补项草稿 | reverify。");
    case "decideSubject":
      return mainBrief(`裁定：${input.subject.subject}`, JSON.stringify(input.subject), "附草稿或插入；或 external（立即报告操作员）。");
    case "decideEffectFailed":
      return mainBrief("程序效应执行失败", `效应：${input.effect.id}（${input.effect.target.kind}）`, "可选：retry | external（立即报告操作员）。");
    case "decideEffectConflict":
      return mainBrief("正文替换的基准哈希已不符", `效应：${input.effect.id}`, "重新读取当前正文后，以新的裁定给出替换，或说明放弃。");
    case "report":
      return mainBrief("交付完成，写给操作员的汇总", input.units.map((u) => u.members.map((m) => issueKey(m.issue)).join(" → ")).join("\n"), "列出每项结局与 PR、issue、验收记录链接；树关闭结论；意外写回主会话工作 checkout 的路径。回复 Decision(report)。");
    case "spawn":
      return input.acknowledgeOnly
        ? mainBrief("回执已派出的席位", `请求名：${input.seat.requestName}，待回执 agent：${input.pending ?? "?"}`, "先执行、再回执：它已存在，直接回复 Decision(seated{agentId})。")
        : mainBrief(
            "派出席位",
            `请求名：${input.seat.requestName}（${input.seat.role}）`,
            [
              "先执行、再回执：用原生 `task` 派出，参数 agent 为 owner→task:high、其他→task:mid；isolated: true；name 取请求名；assignment 取下面的简报。",
              "前提：task.async 已开启，并且该 agent 类型没有声明 blocking: true。",
              "派出后回复 Decision(seated{agentId})，agentId 取 task 返回的实际 id。",
              input.assignment === null ? "" : `\n---\n${input.assignment}`,
            ].join("\n"),
          );
    case "acknowledge":
      return mainBrief("回执已存在的席位", `请求名：${input.requestName}，agent：${input.agent}，上一任：${input.previous ?? "无"}`, "直接回复 Decision(seated{agentId})。");
    case "wake":
      return mainBrief("唤醒席位", `agent：${input.agent}`, "先回执、再执行：先回复 Decision(woken{agentId})，再用原生 `write agent://<id>` 唤醒。");
    case "stall":
      return mainBrief("停滞：推导不出任何义务，也不在等待集合里", JSON.stringify(input.classified.stall), "补充事实（草稿、插入），或裁定 external 并立即报告操作员。");
    case "program":
      return `程序效应：${input.what}`;
    default:
      return assertNever(input);
  }
}

function mainBrief(title: string, facts: string, options: string): string {
  return [
    `# 圆桌票据（主会话）：${title}`,
    "- 完结方式：用端口回复对应的 `Decision`。",
    "- 圆桌是唯一的协议渠道。子席位 yield 时的文字不是记录，不据此行动。",
    "## 事实",
    facts,
    "## 可选裁定与要求",
    options,
  ].join("\n\n");
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
