// admit: decide whether a seat's reply becomes a fact (core.md §4 admit, steps 1–6).

import { outcomeOf, rowOwners, type Classified } from "./classify.ts";
import { derive, type Obligation } from "./derive.ts";
import { canonical, fnv64, issueKey, sameIssue, stripSuffix } from "./identity.ts";
import type {
  AgentId,
  BodyReplacement,
  Claim,
  Context,
  Decision,
  Draft,
  Hash,
  Host,
  IssueRef,
  Manifest,
  ObligationId,
  Policy,
  RecordBody,
  RecordId,
  Route,
  Sha,
  Snapshot,
  Verdict,
} from "./types.ts";

export type Caller =
  | { readonly kind: "main" }
  | {
      readonly kind: "sub";
      readonly agentId: AgentId;
      /** The registry entry for `agentId` is attached to the calling session (checked by the adapter via sessionManager identity). */
      readonly sessionMatches: boolean;
    };

export type Reply =
  | {
      readonly kind: "prSubmit";
      readonly obligation: ObligationId;
      readonly branch: string;
      readonly head: Sha;
      readonly title: string;
      readonly body: string;
      readonly template: "fourLayer" | "docOnly";
      readonly retryNote: string | null;
    }
  | { readonly kind: "claim"; readonly obligation: ObligationId; readonly claim: Claim }
  | { readonly kind: "verdict"; readonly obligation: ObligationId; readonly verdict: Verdict }
  | {
      readonly kind: "decision";
      /** Null only for the unsolicited `noCode` decision. */
      readonly obligation: ObligationId | null;
      readonly decision: Decision;
      readonly rationale: string;
      readonly drafts: readonly Draft[];
      readonly bodyReplacements: readonly BodyReplacement[];
    };

/** Live facts the adapter fetches for this one reply (pure input). */
export interface AdmitFacts {
  /** Remote head of the branch named in a `prSubmit`. */
  readonly branchHead: Sha | null;
  /** Commits (among the required design commits) contained in that branch head. */
  readonly branchContains: readonly Sha[];
}

export interface NewRecord {
  readonly obligation: ObligationId | null;
  readonly idempotencyKey: string;
  readonly manifest: Manifest | null;
  readonly payloadHash: Hash;
  readonly body: RecordBody;
}

export type Admission =
  | { readonly kind: "record"; readonly record: NewRecord }
  | { readonly kind: "replayed"; readonly existing: string }
  | { readonly kind: "rejected"; readonly reason: string };

const reject = (reason: string): Admission => ({ kind: "rejected", reason });

export function admit(snap: Snapshot, host: Host, policy: Policy, caller: Caller, reply: Reply, facts: AdmitFacts): Admission {
  const derived = derive(snap, host, policy);
  const c = derived.classified;
  const activeMember = c.member?.w.entry.issue ?? null;
  if (reply.kind === "prSubmit" && activeMember === null) return reject("当前没有活跃成员，不接受 PrSubmit。");
  const body = toBody(reply, activeMember);
  const payloadHash = fnv64(canonical(body));

  // unsolicited noCode by the main session (core.md §4 step 2 exception)
  if (reply.kind === "decision" && reply.obligation === null) {
    if (caller.kind !== "main") return reject("只有主会话可以不持票据提出 noCode 裁定。");
    const d = reply.decision;
    if (d.subject !== "noCode") return reject("不持票据的回复只能是 Decision(noCode)。");
    const member = c.currentUnit?.members.find((m) => sameIssue(m.issue, d.member));
    const issue = snap.issues.find((i) => sameIssue(i.ref, d.member));
    if (member === undefined || issue === undefined) return reject("目标不是当前单元的成员。");
    const key = `noCode|${issueKey(d.member)}|${issue.bodyHash}`;
    const replay = replayed(snap, key, payloadHash);
    if (replay !== null) return replay;
    return { kind: "record", record: { obligation: null, idempotencyKey: key, manifest: null, payloadHash, body: { ...body, decision: { ...d, bodyHash: issue.bodyHash } } as RecordBody } };
  }

  const obligationId = reply.obligation;
  if (obligationId === null) return reject("回复缺少票据 id。");
  const interim = reply.kind === "claim";
  const key = interim ? `${obligationId}|claim|${payloadHash}` : `${obligationId}`;

  // step 1: replay lookup before currency (crash matrix row 1)
  const replay = replayed(snap, key, payloadHash);
  if (replay !== null) return replay;

  // step 2: the obligation is current
  const ob = derived.obligations.find((o) => o.id === obligationId);
  if (ob === undefined) return reject("这张票据已不在当前推导结果里（已完结，或输入已变化被撤回）。");
  const fullKey = `${ob.context}|${key}`;

  // step 3: caller identity
  const identity = checkCaller(c, ob, caller);
  if (identity !== null) return reject(identity);

  // step 4: reply kind and decision variant
  if (!ob.accepts.includes(reply.kind)) return reject(`这张票据（${ob.kind}）不接受 ${reply.kind} 回复。`);
  if (reply.kind === "decision" && !decisionFits(ob, reply.decision)) return reject(`Decision(${reply.decision.subject}) 不属于票据 ${ob.kind} 可接受的变体。`);
  if (reply.kind === "decision") {
    const unbound = bindingMismatch(c, ob, reply.decision);
    if (unbound !== null) return reject(unbound);
  }
  if (reply.kind === "verdict" && reply.verdict.gate !== ob.kind) return reject(`这张票据是 ${ob.kind}，不接受 ${reply.verdict.gate} 结论。`);
  if (reply.kind === "claim" && claimContextKey(reply.claim) !== ob.context)
    return reject(`主张所指的上下文 ${claimContextKey(reply.claim)} 不是这张票据的上下文 ${ob.context}。`);

  // step 5: live preconditions
  const pre = preconditions(snap, c, ob, reply, facts);
  if (pre !== null) return reject(pre);

  // step 6: the program stamps the pin
  const manifest = reply.kind === "verdict" ? stampManifest(c, ob) : null;
  const stamped = reply.kind === "decision" ? { ...body, decision: stampDecision(snap, c, reply.decision) } : body;
  return { kind: "record", record: { obligation: interim ? null : obligationId, idempotencyKey: fullKey, manifest, payloadHash, body: stamped as RecordBody } };
}

function replayed(snap: Snapshot, key: string, payloadHash: Hash): Admission | null {
  const existing = snap.records.find((r) => r.idempotencyKey === key || r.idempotencyKey.endsWith(`|${key}`));
  if (existing === undefined) return null;
  return existing.payloadHash === payloadHash ? { kind: "replayed", existing: existing.id } : reject("这张票据已经完结，且与已写入的回复内容不同。");
}

function checkCaller(c: Classified, ob: Obligation, caller: Caller): string | null {
  if (ob.holder === "main") return caller.kind === "main" ? null : "这张票据由主会话持有。";
  if (ob.holder === "program") return "程序效应不接受回复。";
  if (caller.kind !== "sub" || ob.seat === null) return "这张票据由子席位持有。";
  if (!caller.sessionMatches) return "调用者的会话与 registry 记录不符。";
  if (stripSuffix(caller.agentId) !== ob.seat.requestName) return `调用者 ${caller.agentId} 不是请求名 ${ob.seat.requestName} 的席位。`;
  const seat = c.seats.find((s) => s.w.requestName === ob.seat?.requestName);
  if (seat === undefined) return "找不到该席位。";
  if (seat.w.holder !== caller.agentId && seat.w.pending !== caller.agentId) return "调用者既不是已回执的持有者，也不是待回执的 agent。";
  return null;
}

const DECISION_SUBJECTS: Record<string, readonly Decision["subject"][]> = {
  decideClaim: ["question", "noCodeClaim", "splitClaim", "blockedClaim"],
  decideFindings: ["findings"],
  designFix: ["designFix"],
  decideChecks: ["checks"],
  decideReopened: ["reopened"],
  decideClosed: ["closed"],
  decidePostMergeFail: ["postMergeFail"],
  decideClosureFail: ["closureFail"],
  "decide:unrelated": ["unrelated"],
  "decide:orphanDesign": ["orphanDesign"],
  "decide:migration": ["migration"],
  "decide:agendaGap": ["agendaGap"],
  decideEffectFailed: ["effectFailed"],
  decideStall: ["stall"],
  report: ["report"],
  spawn: ["seated"],
  wake: ["woken"],
};

function decisionFits(ob: Obligation, d: Decision): boolean {
  return (DECISION_SUBJECTS[ob.kind] ?? []).includes(d.subject);
}

/**
 * The records, events and keys a decision names must be the ones its ticket is pinned to (core.md §4 admit step 4):
 * a reply cannot answer one ticket while deciding another subject.
 */
function bindingMismatch(c: Classified, ob: Obligation, d: Decision): string | null {
  const pin = canonical(c.pins.get(ob.id) ?? null);
  const expect = (named: unknown, what: string): string | null =>
    canonical(named) === pin ? null : `Decision 指向的${what}与这张票据钉住的不一致（票据 pin ${pin}）。`;
  const reconcileMember = (): IssueRef | null =>
    c.reconcile.find((r) => r.w.ids.decideReopened === ob.id || r.w.ids.decideClosed === ob.id)?.w.member ?? null;
  switch (d.subject) {
    case "question":
    case "noCodeClaim":
    case "splitClaim":
    case "blockedClaim":
      return expect(d.claim, "主张记录");
    case "findings":
    case "designFix":
    case "postMergeFail":
    case "closureFail":
    case "unrelated":
      return expect(d.verdictRecord, "结论记录");
    case "checks": {
      const pr = c.member?.w.pr?.ref ?? null;
      if (pr === null || pr.number !== d.pr.number || pr.repo.owner !== d.pr.repo.owner || pr.repo.name !== d.pr.repo.name) return "Decision 指向的 PR 不是当前成员的 PR。";
      return expect(d.runId, "check run");
    }
    case "reopened": {
      const member = reconcileMember();
      if (member === null || !sameIssue(member, d.member)) return "Decision 指向的成员不是这张票据的成员。";
      return expect(d.event, "重开事件");
    }
    case "closed": {
      const member = reconcileMember();
      if (member === null || !sameIssue(member, d.member)) return "Decision 指向的成员不是这张票据的成员。";
      return expect({ event: d.event, body: d.bodyHash }, "关闭事件与正文哈希");
    }
    case "orphanDesign":
    case "migration":
    case "agendaGap":
      return expect(d.key, "主题");
    case "stall":
      // a stall ticket is pinned to its stall key; an effect-conflict ticket (also answered by `stall`) to its conflict key
      return expect(d.key, ob.id === c.stall.id ? "停滞状态" : "冲突的效应");
    case "effectFailed":
      return expect({ effect: d.effect, failedAt: d.failedAt }, "效应失败");
    case "seated":
      return expect({ requestName: d.requestName, previous: d.previous }, "席位与上一任 agent");
    case "woken":
      return expect({ agent: d.agentId, count: d.count }, "agent 与唤醒次数");
    case "report":
    case "noCode":
      return null;
    default:
      return assertNever(d);
  }
}

function preconditions(snap: Snapshot, c: Classified, ob: Obligation, reply: Reply, facts: AdmitFacts): string | null {
  switch (reply.kind) {
    case "prSubmit": {
      const w = c.member?.w;
      if (w === undefined) return "当前没有活跃成员。";
      if (facts.branchHead === null || facts.branchHead !== reply.head) return `远端分支 ${reply.branch} 的 head 与回复中的 head 不一致。`;
      const missing = w.designCommits.filter((d) => !facts.branchContains.includes(d));
      if (missing.length > 0) return `head 尚未包含应合入的设计 commit：${missing.join(", ")}。`;
      return null;
    }
    case "verdict": {
      const v = reply.verdict;
      if (v.gate === "review" || v.gate === "accept") {
        const pr = c.member?.w.pr;
        if (pr === undefined || pr === null || pr.head !== v.observedHead) return "观察到的 head 与票据钉住的 head 不一致。";
        if (v.gate === "accept") return rowsMatch(snap, c.member?.w.entry.issue ?? null, v.rows.map((r) => r.rowId));
        return null;
      }
      if (v.gate === "postMerge") {
        const w = c.verification?.w;
        if (w === undefined || w.manifest.gate !== "postMerge") return "当前不在单元验证阶段。";
        // Per target repo: one observed commit. Non-legacy: exactly the unit's latest merge in that repo (R5),
        // which must contain the repo's earlier merges. Legacy: any commit containing all of the repo's merges.
        const repos = [...new Map(w.manifest.merges.map((m) => [`${m.repo.owner}/${m.repo.name}`, m.repo])).values()];
        for (const repo of repos) {
          const merges = w.manifest.merges.filter((m) => m.repo.owner === repo.owner && m.repo.name === repo.name);
          const obs = v.observed.find((o) => o.repo.owner === repo.owner && o.repo.name === repo.name);
          if (obs === undefined) return `缺少 ${repo.name} 的观察提交。`;
          const containsCommit = (commit: Sha): boolean =>
            obs.commit === commit || snap.commits.contains.some((x) => x.ancestor === commit && x.descendant === obs.commit);
          const latest = merges.at(-1);
          if (!w.legacy && latest !== undefined && obs.commit !== latest.commit) return `${repo.name} 的观察提交须恰好是最新的合并提交 ${latest.commit}。`;
          const missing = merges.find((m) => !containsCommit(m.commit));
          if (missing !== undefined) return `${repo.name} 的观察提交须包含合并提交 ${missing.commit}。`;
        }
        const rows = w.unit.members.flatMap((m) => snap.issues.find((i) => sameIssue(i.ref, m.issue))?.acceptanceRows ?? []);
        return sameSet(rows, v.rows.map((r) => r.rowId)) ? null : "验收行 id 集合与覆盖成员的验收行不一致。";
      }
      const parent = c.closure.w.parent;
      return rowsMatch(snap, parent, v.rows.map((r) => r.rowId));
    }
    case "decision": {
      for (const b of reply.bodyReplacements) {
        const issue = snap.issues.find((i) => sameIssue(i.ref, b.issue));
        if (issue === undefined || issue.bodyHash !== b.baseHash) return `正文替换的基准哈希与 ${issueKey(b.issue)} 当前正文不符。`;
      }
      const d = reply.decision;
      if (d.subject === "seated") {
        const seat = c.seats.find((s) => s.w.requestName === d.requestName);
        const pendingAck = c.pendingAcks.find((p) => p.agentId === d.agentId);
        if (seat?.w.pending !== d.agentId && pendingAck === undefined) return "该 agent 不是待回执的 agent（须在 registry 中、非 aborted、请求名匹配、尚无回执）。";
      }
      if (d.subject === "woken") {
        const seat = c.seats.find((s) => s.w.holder === d.agentId);
        if (seat === undefined || seat.state !== "parked") return "该 agent 当前不是 parked 的席位持有者。";
      }
      if (d.subject === "reopened" && d.verdict === "reopenAccepted") {
        const entry = c.currentUnit?.members.find((m) => sameIssue(m.issue, d.member));
        if (entry === undefined || outcomeOf(snap, entry).kind !== "noCode") return "reopenAccepted 只适用于结局为 noCode 的成员；已合并的成员请选 restore 或 correction。";
      }
      const methodContext: Context | null =
        d.subject === "question" && d.verdict.kind === "acceptanceMethod"
          ? questionContext(snap, d.claim)
          : d.subject === "findings" && d.perFinding.some((f) => f.verdict.kind === "acceptanceMethod") && c.member !== null
            ? { kind: "member", member: c.member.w.entry.issue }
            : null;
      if (methodContext !== null) {
        const owners = rowOwners(snap, methodContext);
        if (!reply.bodyReplacements.some((b) => owners.some((o) => sameIssue(o, b.issue))))
          return `acceptanceMethod 裁定必须附带正文替换，替换对象为验收行所在的 issue 之一：${owners.map(issueKey).join("、") || "（无）"}。`;
      }
      if (d.subject === "findings") {
        for (const f of d.perFinding) if (f.verdict.kind === "designGap") {
          const bad = routeIssue(snap, c, f.verdict.route);
          if (bad !== null) return bad;
        }
      }
      if (d.subject === "question" && d.verdict.kind === "designGap") return routeIssue(snap, c, d.verdict.route);
      return null;
    }
    case "claim":
      void ob;
      return null;
    default:
      return assertNever(reply);
  }
}

function routeIssue(snap: Snapshot, c: Classified, route: Route): string | null {
  switch (route.kind) {
    case "defaultFirst": {
      const repo = c.member?.w.entry.target.repo ?? c.currentUnit?.top.target.repo;
      const landed = repo !== undefined && snap.commits.onDefault.some((x) => x.sha === route.commit && x.repo.name === repo.name && x.repo.owner === repo.owner);
      return landed ? null : "defaultFirst 路线要求 commit 已在默认分支上；推送被拒时请改选其他路线。";
    }
    case "withPr":
      return null;
    case "future": {
      const idx = c.units.findIndex((u) => u.members.some((m) => sameIssue(m.issue, route.carrier)));
      const cur = c.currentUnit === null ? -1 : c.units.indexOf(c.currentUnit);
      const carrier = c.units[idx]?.members.find((m) => sameIssue(m.issue, route.carrier));
      const repo = c.member?.w.entry.target.repo ?? c.currentUnit?.top.target.repo;
      const sameRepoOk = carrier !== undefined && repo !== undefined && carrier.target.repo.owner === repo.owner && carrier.target.repo.name === repo.name;
      return idx > cur && sameRepoOk ? null : "future 路线的承载者必须与 commit 同 repo，并位于当前单元之后；没有合适的承载者时请附设计承接项草稿。";
    }
    default:
      return assertNever(route);
  }
}

function rowsMatch(snap: Snapshot, issueRef: IssueRef | null, rows: readonly string[]): string | null {
  const issue = issueRef === null ? undefined : snap.issues.find((i) => sameIssue(i.ref, issueRef));
  if (issue === undefined) return "找不到验收行所属的 issue。";
  return sameSet(issue.acceptanceRows, rows) ? null : "验收行 id 集合与 issue 的验收行不一致（缺行或重复）。";
}

/** Context of the question a `claim(question)` decision answers (null when the record is not a question). */
function questionContext(snap: Snapshot, claimId: RecordId): Context | null {
  const r = snap.records.find((x) => x.id === claimId);
  return r !== undefined && r.body.kind === "claim" && r.body.claim.kind === "question" ? r.body.claim.context : null;
}

/** Obligation context a claim speaks for, in derive's context keys (member, `verify:<unit>`, `closure`). */
function claimContextKey(claim: Claim): string {
  switch (claim.kind) {
    case "question":
      switch (claim.context.kind) {
        case "member":
          return issueKey(claim.context.member);
        case "unitVerification":
          return `verify:${issueKey(claim.context.unit)}`;
        case "agendaClosure":
          return "closure";
        default:
          return assertNever(claim.context);
      }
    case "noCode":
    case "split":
    case "blocked":
      return issueKey(claim.member);
    default:
      return assertNever(claim);
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && new Set(b).size === b.length && a.every((x) => b.includes(x));
}

function stampManifest(c: Classified, ob: Obligation): Manifest | null {
  switch (ob.kind) {
    case "review":
      return c.member?.w.reviewManifest ?? null;
    case "accept":
      return c.member?.w.acceptManifest ?? null;
    case "postMerge":
      return c.verification?.w.manifest ?? null;
    case "closure":
      return c.closure.w.manifest;
    default:
      return null;
  }
}

function stampDecision(snap: Snapshot, c: Classified, d: Decision): Decision {
  if (d.subject === "noCodeClaim" || d.subject === "splitClaim") {
    const member = c.member?.w.entry.issue ?? d.member;
    const issue = snap.issues.find((i) => sameIssue(i.ref, member));
    return { ...d, member, bodyHash: issue?.bodyHash ?? d.bodyHash };
  }
  if (d.subject === "blockedClaim") {
    return { ...d, abandon: d.verdict === "replacePr" ? (c.member?.w.pr?.ref ?? null) : null };
  }
  return d;
}

/** Record body for a reply; `member` is the active member, required for `prSubmit` (checked by the caller). */
function toBody(reply: Reply, member: IssueRef | null): RecordBody {
  switch (reply.kind) {
    case "prSubmit":
      if (member === null) throw new Error("toBody: prSubmit requires the active member (admit checks this first)");
      return {
        kind: "prSubmit",
        member,
        branch: reply.branch,
        head: reply.head,
        title: reply.title,
        body: reply.body,
        template: reply.template,
        retryNote: reply.retryNote,
      };
    case "claim":
      return { kind: "claim", claim: reply.claim };
    case "verdict":
      return { kind: "verdict", obligation: reply.obligation, verdict: reply.verdict };
    case "decision":
      return { kind: "decision", decision: reply.decision, rationale: reply.rationale, drafts: reply.drafts, bodyReplacements: reply.bodyReplacements };
    default:
      return assertNever(reply);
  }
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
