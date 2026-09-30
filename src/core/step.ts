// step: the only write path of the agenda state (core.md §4 step, steps 1–6).
// A reply or effect result either leaves the state unchanged (`same`, nothing is written),
// is rejected, or yields the next state, which the store writes once with a version compare.

import { emptyMember, outcomeOf, rowOwners, type Classified, type EffectTarget } from "./classify.ts";
import { derive, type Obligation } from "./derive.ts";
import { bodyHash, canonical, issueKey, replyId, sameIssue, samePr, stripSuffix } from "./identity.ts";
import type {
  AgendaId,
  AgendaState,
  AgentId,
  BodyReplacement,
  Claim,
  ConvenedEntry,
  Context,
  ContractDecision,
  Decision,
  Draft,
  DraftId,
  Facts,
  GateSlot,
  Host,
  IssueRef,
  MemberState,
  Millis,
  ObligationId,
  Policy,
  PrRef,
  PrSubmit,
  ReplyId,
  Route,
  Sha,
  StoredVerdict,
  Verdict,
} from "./types.ts";

export type Caller =
  | { readonly kind: "main" }
  | {
      readonly kind: "sub";
      readonly agentId: AgentId;
      /** The registry entry for `agentId` is attached to the calling session (checked by the adapter). */
      readonly sessionMatches: boolean;
    };

export type Reply =
  | ({ readonly kind: "prSubmit"; readonly obligation: ObligationId } & PrSubmit)
  | { readonly kind: "claim"; readonly obligation: ObligationId; readonly claim: Claim }
  | { readonly kind: "verdict"; readonly obligation: ObligationId; readonly ok: boolean; readonly note: string }
  | {
      readonly kind: "decision";
      /** Null only for the unsolicited `noCode` decision. */
      readonly obligation: ObligationId | null;
      readonly decision: Decision;
      readonly rationale: string;
      readonly drafts: readonly Draft[];
      readonly bodyReplacements: readonly BodyReplacement[];
    };

/** Live facts the adapter fetches for one reply (pure input). */
export interface LiveFacts {
  /** Remote head of the branch named in a `prSubmit`. */
  readonly branchHead: Sha | null;
  /** Commits (among the required design commits) contained in that branch head. */
  readonly branchContains: readonly Sha[];
}

export type EffectResult =
  | { readonly kind: "prApplied"; readonly pr: PrRef }
  | { readonly kind: "bodyApplied" }
  | { readonly kind: "issueCreated"; readonly issue: IssueRef }
  | { readonly kind: "checksRerun" };

export type StepEvent =
  | { readonly kind: "reply"; readonly caller: Caller; readonly reply: Reply; readonly live: LiveFacts; readonly at: Millis }
  | { readonly kind: "effectDone"; readonly effect: ObligationId; readonly result: EffectResult };

export type Transition =
  | { readonly kind: "next"; readonly state: AgendaState }
  | { readonly kind: "same" }
  | { readonly kind: "rejected"; readonly reason: string };

const SAME: Transition = { kind: "same" };
const reject = (reason: string): Transition => ({ kind: "rejected", reason });

/** Initial state written once at convening (core.md §4 convene). */
export function convene(id: AgendaId, at: Millis, parent: IssueRef | null, entries: readonly ConvenedEntry[]): AgendaState {
  return {
    version: 1,
    id,
    convenedAt: at,
    parent,
    convened: entries,
    drafts: [],
    members: entries.map((e) => ({ ...emptyMember(e.issue), prs: e.adoptPr === null ? [] : [e.adoptPr] })),
    units: [],
    closure: { attempt: 1, verdict: null },
    claims: [],
    contracts: [],
    replacements: [],
    subjects: [],
    effectDecisions: [],
    seats: [],
    lastDecision: null,
    reported: false,
  };
}

export function step(state: AgendaState, facts: Facts, host: Host, policy: Policy, event: StepEvent): Transition {
  const derived = derive(state, facts, host, policy);
  const next = event.kind === "effectDone" ? applyEffect(state, derived.classified, event.effect, event.result) : applyReply(state, facts, derived.classified, derived.obligations, event);
  if (next.kind !== "next") return next;
  return canonical({ ...next.state, version: 0 }) === canonical({ ...state, version: 0 }) ? SAME : { kind: "next", state: { ...next.state, version: state.version + 1 } };
}

// ---------------------------------------------------------------- effect results

/**
 * Writes an effect's result back. The effect is looked up among every classified effect, fulfilled ones included: a
 * body replacement that already shows on GitHub is recorded as applied, so a later human edit does not revive it.
 */
function applyEffect(state: AgendaState, c: Classified, effect: ObligationId, result: EffectResult): Transition {
  const found = c.effects.find((e) => e.w.id === effect);
  if (found === undefined) return result.kind === "prApplied" && prRecorded(state, result.pr) ? SAME : reject("这个效应不在当前推导结果里。");
  const t: EffectTarget = found.w.target;
  switch (t.kind) {
    case "openPr":
    case "updatePr": {
      if (result.kind !== "prApplied") return reject(`效应 ${t.kind} 的结果必须是 prApplied。`);
      return next(
        updateMember(state, t.member, (m) => ({
          ...m,
          prs: m.prs.some((p) => samePr(p, result.pr)) ? m.prs : [...m.prs, result.pr],
          submit: m.submit === null ? null : { ...m.submit, applied: true, appliedDesign: t.designCommits },
        })),
      );
    }
    case "applyBody":
      if (result.kind !== "bodyApplied") return reject("效应 applyBody 的结果必须是 bodyApplied。");
      return next({ ...state, replacements: state.replacements.map((r) => (r.decision === t.replacement.decision && sameIssue(r.issue, t.replacement.issue) ? { ...r, applied: true } : r)) });
    case "createIssue":
      if (result.kind !== "issueCreated") return reject("效应 createIssue 的结果必须是 issueCreated。");
      return next({ ...state, drafts: state.drafts.map((d) => (d.id === t.draft.id ? { ...d, issue: result.issue } : d)) });
    case "rerunChecks":
      if (result.kind !== "checksRerun") return reject("效应 rerunChecks 的结果必须是 checksRerun。");
      return next(updateMember(state, t.member, (m) => (m.checks === null ? m : { ...m, checks: { ...m.checks, rerunDone: true } })));
    default:
      return assertNever(t);
  }
}

/** A PR result for an effect that is no longer derived (the PR already carries the submit) is a resend. */
const prRecorded = (state: AgendaState, pr: PrRef): boolean => state.members.some((m) => m.prs.some((p) => samePr(p, pr)) && m.submit?.applied === true);

// ---------------------------------------------------------------- replies

function applyReply(
  state: AgendaState,
  facts: Facts,
  c: Classified,
  obligations: readonly Obligation[],
  event: Extract<StepEvent, { kind: "reply" }>,
): Transition {
  const { caller, reply, live, at } = event;

  // unsolicited noCode by the main session (core.md §4 step 2 exception)
  if (reply.kind === "decision" && reply.obligation === null) {
    if (caller.kind !== "main") return reject("只有主会话可以不持票据提出 noCode 裁定。");
    const d = reply.decision;
    if (d.subject !== "noCode") return reject("不持票据的回复只能是 Decision(noCode)。");
    const entry = c.currentUnit?.members.find((m) => sameIssue(m.issue, d.member));
    const issue = facts.issues.find((i) => sameIssue(i.ref, d.member));
    if (entry === undefined || issue === undefined) return reject("目标不是当前单元的成员。");
    if (memberOf(state, d.member).noCode?.bodyHash === issue.bodyHash) return SAME;
    if (outcomeOf(state, facts, entry).kind !== "pending") return reject("目标成员的结局不是 pending。");
    return next(updateMember(state, d.member, (m) => ({ ...m, noCode: { bodyHash: issue.bodyHash, at } })));
  }

  const obligationId = reply.obligation;
  if (obligationId === null) return reject("回复缺少票据 id。");
  const id = replyId(obligationId, reply);

  // step 1: the state already carries this reply
  if (alreadyApplied(state, reply, obligationId, id)) return SAME;

  // step 2: the obligation is current
  const ob = obligations.find((o) => o.id === obligationId);
  if (ob === undefined) return reject("这张票据已不在当前推导结果里（已完结，或输入已变化被撤回）。");

  // step 3: caller identity
  const identity = checkCaller(c, ob, caller);
  if (identity !== null) return reject(identity);

  // step 4: reply kind, decision variant, and binding to the ticket's pin
  if (!ob.accepts.includes(reply.kind)) return reject(`这张票据（${ob.kind}）不接受 ${reply.kind} 回复。`);
  if (reply.kind === "decision") {
    if (!(DECISION_SUBJECTS[ob.kind] ?? []).includes(reply.decision.subject)) return reject(`Decision(${reply.decision.subject}) 不属于票据 ${ob.kind} 可接受的变体。`);
    const unbound = bindingMismatch(c, ob, reply.decision);
    if (unbound !== null) return reject(unbound);
  }
  if (reply.kind === "claim" && claimContextKey(reply.claim) !== ob.context)
    return reject(`主张所指的上下文 ${claimContextKey(reply.claim)} 不是这张票据的上下文 ${ob.context}。`);

  // step 5: live preconditions
  const pre = preconditions(state, facts, c, reply, live);
  if (pre !== null) return reject(pre);

  // step 6: stamp the pin and write the reply into its slot
  switch (reply.kind) {
    case "prSubmit":
      return next(applySubmit(state, c, ob, reply));
    case "claim":
      return next({ ...state, claims: [...state.claims, { id, claim: reply.claim }] });
    case "verdict":
      return applyVerdict(state, c, ob, id, reply);
    case "decision": {
      const d = reply.decision;
      const outOfScope = d.subject === "findings" && d.verdict.kind === "outOfScope" ? [d.verdict.draft] : [];
      const decided = applyDecision(state, c, id, reply, at);
      return next({ ...withAttachments(decided, id, [...reply.drafts, ...outOfScope], reply.bodyReplacements, at), lastDecision: id });
    }
    default:
      return assertNever(reply);
  }
}

function alreadyApplied(state: AgendaState, reply: Reply, ticket: ObligationId, id: ReplyId): boolean {
  switch (reply.kind) {
    case "prSubmit": {
      const { kind: _k, obligation: _o, ...payload } = reply;
      return state.members.some((m) => m.submit !== null && m.submit.answered === ticket && canonical(submitPayload(m.submit)) === canonical(payload));
    }
    case "claim":
      return state.claims.some((c) => c.id === id);
    case "verdict":
      return allSlots(state).some((s) => s.verdict !== null && s.verdict.id === id);
    case "decision":
      return state.lastDecision === id;
    default:
      return assertNever(reply);
  }
}

const submitPayload = (s: PrSubmit): PrSubmit => ({ branch: s.branch, head: s.head, title: s.title, body: s.body, template: s.template, retryNote: s.retryNote });

const allSlots = (state: AgendaState): GateSlot[] => [...state.members.flatMap((m) => [m.review, m.accept]), ...state.units.map((u) => u.postMerge), state.closure];

function applySubmit(state: AgendaState, c: Classified, ob: Obligation, reply: Extract<Reply, { kind: "prSubmit" }>): AgendaState {
  const w = c.member?.w;
  if (w === undefined) return state;
  const { kind: _k, obligation: _o, ...payload } = reply;
  const trigger = ob.kind === "fix" ? w.fixTrigger : null;
  // A later submit supersedes an adjudicated failing verdict on the same pin (evidence-only fix; core.md §3 尝试身份).
  const bump = (slot: GateSlot): GateSlot => (slot.verdict !== null && slot.verdict.adjudication !== null && slot.verdict.attempt === slot.attempt ? { ...slot, attempt: slot.attempt + 1 } : slot);
  return updateMember(state, w.entry.issue, (m) => ({
    ...m,
    submit: { ...payload, answered: ob.id, applied: false, appliedDesign: [] },
    implDefect: null,
    fixNeeded: null,
    fixedRun: trigger !== null && trigger.kind === "checksFail" ? trigger.runId : m.fixedRun,
    review: bump(m.review),
    accept: bump(m.accept),
  }));
}

/** The seat said ok or not ok; the gate is the ticket's kind and the pin is the ticket's manifest (core.md §4 step 6). */
function applyVerdict(state: AgendaState, c: Classified, ob: Obligation, id: ReplyId, reply: Extract<Reply, { kind: "verdict" }>): Transition {
  const gate = ob.kind;
  if (gate !== "review" && gate !== "accept" && gate !== "postMerge" && gate !== "closure") return reject(`这张票据（${ob.kind}）不是 gate 票据。`);
  const verdict: Verdict = { gate, ok: reply.ok, note: reply.note };
  const store = (slot: GateSlot, manifest: StoredVerdict["manifest"] | null): GateSlot | null =>
    manifest === null ? null : { ...slot, verdict: { id, ticket: ob.id, attempt: slot.attempt, manifest, verdict, adjudication: null, failDecision: null } };
  switch (gate) {
    case "review":
    case "accept": {
      const w = c.member?.w;
      if (w === undefined) return reject("当前没有活跃成员。");
      const m = memberOf(state, w.entry.issue);
      const slot = store(verdict.gate === "review" ? m.review : m.accept, verdict.gate === "review" ? w.reviewManifest : w.acceptManifest);
      if (slot === null) return reject("当前没有可钉住的 PR 输入。");
      return next(updateMember(state, w.entry.issue, (x) => (gate === "review" ? { ...x, review: slot } : { ...x, accept: slot })));
    }
    case "postMerge": {
      const w = c.verification?.w;
      if (w === undefined) return reject("当前不在单元验证阶段。");
      const top = w.unit.top.issue;
      const current = state.units.find((u) => sameIssue(u.top, top))?.postMerge ?? { attempt: 1, verdict: null };
      const slot = store(current, w.manifest);
      if (slot === null) return reject("当前没有可钉住的验收输入。");
      const units = state.units.some((u) => sameIssue(u.top, top)) ? state.units.map((u) => (sameIssue(u.top, top) ? { ...u, postMerge: slot } : u)) : [...state.units, { top, postMerge: slot }];
      return next({ ...state, units });
    }
    case "closure": {
      const slot = store(state.closure, c.closure.w.manifest);
      if (slot === null) return reject("当前没有可钉住的树关闭输入。");
      return next({ ...state, closure: slot });
    }
    default:
      return assertNever(gate);
  }
}

function applyDecision(state: AgendaState, c: Classified, id: ReplyId, reply: Extract<Reply, { kind: "decision" }>, at: Millis): AgendaState {
  const d = reply.decision;
  const rationale = reply.rationale;
  const active = c.member?.w ?? null;
  const dropClaim = (claim: ReplyId) => (s: AgendaState): AgendaState => ({ ...s, claims: s.claims.filter((x) => x.id !== claim) });
  // A contract decision applies to the members it names and to every issue whose body it replaces.
  const contract = (affected: readonly IssueRef[], routes: ContractDecision["routes"]) => (s: AgendaState): AgendaState => ({
    ...s,
    contracts: [...s.contracts, { id, affected: uniqueIssues([...affected, ...reply.bodyReplacements.map((b) => b.issue)]), routes }],
  });
  const claimOf = (claim: ReplyId): Claim | null => state.claims.find((x) => x.id === claim)?.claim ?? null;
  const claimMember = (claim: Claim | null): IssueRef | null =>
    claim === null ? null : claim.kind === "question" ? (claim.context.kind === "member" ? claim.context.member : null) : claim.member;

  switch (d.subject) {
    case "question": {
      const claim = claimOf(d.claim);
      const asker = claimMember(claim);
      const s = dropClaim(d.claim)(state);
      switch (d.verdict.kind) {
        case "answered":
        case "outOfDomain":
          return s;
        case "implDefect":
          return asker === null ? s : updateMember(s, asker, (m) => ({ ...m, implDefect: { id, rationale } }));
        case "designGap": {
          const route: Route = d.verdict.route;
          const carrier = route.kind === "future" ? route.carrier : route.kind === "withPr" ? (asker ?? d.affected[0] ?? null) : null;
          return contract(d.affected, [{ route, carrier }])(s);
        }
        case "acceptanceMethod":
          return contract(d.affected, [])(s);
        default:
          return assertNever(d.verdict);
      }
    }
    case "noCodeClaim":
    case "splitClaim": {
      const s = dropClaim(d.claim)(state);
      return d.subject === "noCodeClaim" && d.verdict === "confirmed" ? updateMember(s, d.member, (m) => ({ ...m, noCode: { bodyHash: d.bodyHash, at } })) : s;
    }
    case "blockedClaim": {
      const s = dropClaim(d.claim)(state);
      const member = claimMember(claimOf(d.claim));
      if (member === null) return s;
      if (d.verdict === "replacePr") {
        const pr = active?.pr?.ref ?? null;
        return pr === null ? s : updateMember(s, member, (m) => ({ ...m, replaced: m.replaced.some((p) => samePr(p, pr)) ? m.replaced : [...m.replaced, pr] }));
      }
      return d.verdict === "external" ? updateMember(s, member, (m) => ({ ...m, external: true })) : s;
    }
    case "findings": {
      if (active === null) return state;
      const member = active.entry.issue;
      const v = d.verdict;
      const routes = v.kind === "designGap" ? [{ route: v.route, carrier: v.route.kind === "future" ? v.route.carrier : v.route.kind === "withPr" ? member : null }] : [];
      const changesContract = v.kind === "designGap" || v.kind === "acceptanceMethod";
      const dismissed = v.kind === "rejected" || v.kind === "outOfScope";
      const adjudicate = (slot: GateSlot): GateSlot =>
        slot.verdict === null || slot.verdict.id !== d.verdictId ? slot : { attempt: dismissed ? slot.attempt + 1 : slot.attempt, verdict: { ...slot.verdict, adjudication: v } };
      const rejected = v.kind === "rejected" ? [d.verdictId] : [];
      const s = updateMember(state, member, (m) => ({
        ...m,
        review: adjudicate(m.review),
        accept: adjudicate(m.accept),
        rejectedFindings: m.review.verdict?.id === d.verdictId ? [...new Set([...m.rejectedFindings, ...rejected])] : m.rejectedFindings,
      }));
      return changesContract ? contract([member], routes)(s) : s;
    }
    case "closed": {
      const s = updateMember(state, d.member, (m) => ({ ...m, closed: { event: d.event, bodyHash: d.bodyHash, verdict: d.verdict } }));
      return d.verdict === "confirmedNoCode" ? updateMember(s, d.member, (m) => ({ ...m, noCode: { bodyHash: d.bodyHash, at } })) : s;
    }
    case "reopened": {
      const s = updateMember(state, d.member, (m) => ({ ...m, reopened: { event: d.event, verdict: d.verdict } }));
      return d.verdict === "reopenAccepted" ? updateMember(s, d.member, (m) => ({ ...m, noCode: null })) : s;
    }
    case "checks": {
      if (active === null) return state;
      return updateMember(state, active.entry.issue, (m) => ({
        ...m,
        checks: { runId: d.runId, verdict: d.verdict, rerunDone: false },
        fixNeeded: d.verdict === "fixNeeded" ? { id, rationale } : m.fixNeeded,
      }));
    }
    case "postMergeFail":
    case "closureFail": {
      const fail = (slot: GateSlot): GateSlot =>
        slot.verdict === null || slot.verdict.id !== d.verdictId
          ? slot
          : { attempt: d.verdict === "reverify" ? slot.attempt + 1 : slot.attempt, verdict: { ...slot.verdict, failDecision: d.verdict } };
      return d.subject === "postMergeFail" ? { ...state, units: state.units.map((u) => ({ ...u, postMerge: fail(u.postMerge) })) } : { ...state, closure: fail(state.closure) };
    }
    case "orphanDesign":
    case "migration":
    case "agendaGap":
    case "stall": {
      const rest = state.subjects.filter((x) => !(x.subject === d.subject && x.key === d.key));
      return { ...state, subjects: [...rest, { subject: d.subject, key: d.key, verdict: d.verdict }] };
    }
    case "effectFailed": {
      const rest = state.effectDecisions.filter((x) => x.effect !== d.effect);
      return { ...state, effectDecisions: [...rest, { effect: d.effect, failedAt: d.failedAt, verdict: d.verdict }] };
    }
    case "designFix": {
      if (active === null) return state;
      return updateMember(state, active.entry.issue, (m) => ({ ...m, designFixes: [...m.designFixes.filter((x) => x.verdictId !== d.verdictId), { verdictId: d.verdictId, commit: d.commit }] }));
    }
    case "report":
      return { ...state, reported: true };
    case "noCode":
      return state;
    case "seated": {
      const rest = state.seats.filter((x) => x.requestName !== d.requestName);
      return { ...state, seats: [...rest, { requestName: d.requestName, holder: d.agentId }] };
    }
    default:
      return assertNever(d);
  }
}

/** Drafts and body replacements a decision carries (common to every variant). */
function withAttachments(state: AgendaState, id: ReplyId, drafts: readonly Draft[], replacements: readonly BodyReplacement[], at: Millis): AgendaState {
  const newDrafts = drafts.map((draft) => ({ id: `${id}#${draft.index}` as DraftId, draft, proposedAt: at, issue: null }));
  const kept = state.replacements.filter((r) => !replacements.some((b) => sameIssue(b.issue, r.issue)));
  return {
    ...state,
    drafts: [...state.drafts, ...newDrafts.filter((n) => !state.drafts.some((d) => d.id === n.id))],
    replacements: [...kept, ...replacements.map((b) => ({ decision: id, issue: b.issue, baseHash: b.baseHash, body: b.body, targetHash: bodyHash(b.body), applied: false }))],
  };
}

// ---------------------------------------------------------------- checks shared with the previous admission rules

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
  "decide:orphanDesign": ["orphanDesign"],
  "decide:migration": ["migration"],
  "decide:agendaGap": ["agendaGap"],
  decideEffectFailed: ["effectFailed"],
  decideStall: ["stall"],
  report: ["report"],
  spawn: ["seated"],
};

/**
 * The verdicts, events and keys a decision names must be the ones its ticket is pinned to (core.md §4 step 4):
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
      return expect(d.claim, "主张");
    case "findings":
    case "designFix":
    case "postMergeFail":
    case "closureFail":
      return expect(d.verdictId, "结论");
    case "checks": {
      const pr = c.member?.w.pr?.ref ?? null;
      if (pr === null || !samePr(pr, d.pr)) return "Decision 指向的 PR 不是当前成员的 PR。";
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
    case "report":
    case "noCode":
      return null;
    default:
      return assertNever(d);
  }
}

function preconditions(state: AgendaState, facts: Facts, c: Classified, reply: Reply, live: LiveFacts): string | null {
  switch (reply.kind) {
    case "prSubmit": {
      const w = c.member?.w;
      if (w === undefined) return "当前没有活跃成员。";
      if (live.branchHead === null || live.branchHead !== reply.head) return `远端分支 ${reply.branch} 的 head 与回复中的 head 不一致。`;
      const missing = w.designCommits.filter((d) => !live.branchContains.includes(d));
      if (missing.length > 0) return `head 尚未包含应合入的设计 commit：${missing.join(", ")}。`;
      return null;
    }
    case "verdict":
      return null;
    case "decision": {
      for (const b of reply.bodyReplacements) {
        const issue = facts.issues.find((i) => sameIssue(i.ref, b.issue));
        if (issue === undefined || issue.bodyHash !== b.baseHash) return `正文替换的基准哈希与 ${issueKey(b.issue)} 当前正文不符。`;
      }
      const d = reply.decision;
      if (d.subject === "seated") {
        const seat = c.seats.find((s) => s.w.requestName === d.requestName);
        const pendingAck = c.pendingAcks.find((p) => p.agentId === d.agentId);
        if (seat?.w.pending !== d.agentId && pendingAck === undefined) return "该 agent 不是待回执的 agent（须在 registry 中、非 aborted、请求名匹配、不是已记录的持有者）。";
      }
      const claimFailure = claimBinding(state, facts, d);
      if (claimFailure !== null) return claimFailure;
      if (d.subject === "reopened" && d.verdict === "reopenAccepted") {
        const entry = c.currentUnit?.members.find((m) => sameIssue(m.issue, d.member));
        if (entry === undefined || outcomeOf(state, facts, entry).kind !== "noCode") return "reopenAccepted 只适用于结局为 noCode 的成员；已合并的成员请选 restore 或 correction。";
      }
      const methodContext: Context | null =
        d.subject === "question" && d.verdict.kind === "acceptanceMethod"
          ? questionContext(state, d.claim)
          : d.subject === "findings" && d.verdict.kind === "acceptanceMethod" && c.member !== null
            ? { kind: "member", member: c.member.w.entry.issue }
            : null;
      if (methodContext !== null) {
        const owners = rowOwners(state, methodContext);
        if (!reply.bodyReplacements.some((b) => owners.some((o) => sameIssue(o, b.issue))))
          return `acceptanceMethod 裁定必须附带正文替换，替换对象为验收行所在的 issue 之一：${owners.map(issueKey).join("、") || "（无）"}。`;
      }
      if (d.subject === "findings" && d.verdict.kind === "designGap") {
        const bad = routeIssue(facts, c, d.verdict.route);
        if (bad !== null) return bad;
      }
      if (d.subject === "question" && d.verdict.kind === "designGap") return routeIssue(facts, c, d.verdict.route);
      return null;
    }
    case "claim":
      return null;
    default:
      return assertNever(reply);
  }
}

function routeIssue(facts: Facts, c: Classified, route: Route): string | null {
  switch (route.kind) {
    case "defaultFirst": {
      const repo = c.member?.w.entry.target.repo ?? c.currentUnit?.top.target.repo;
      const landed = repo !== undefined && facts.commits.onDefault.some((x) => x.sha === route.commit && x.repo.name === repo.name && x.repo.owner === repo.owner);
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

/**
 * A claim decision must match the claim it answers: the subject names the claim's kind; noCode and split name the
 * claim's member and its current body hash (the confirmation is pinned to it); `implDefect` needs an owner to repair,
 * so only a member-context question can take it.
 */
function claimBinding(state: AgendaState, facts: Facts, d: Decision): string | null {
  if (d.subject !== "question" && d.subject !== "noCodeClaim" && d.subject !== "splitClaim" && d.subject !== "blockedClaim") return null;
  const claim = state.claims.find((x) => x.id === d.claim)?.claim;
  if (claim === undefined) return "Decision 指向的主张不在未决列表里。";
  const kind = { question: "question", noCodeClaim: "noCode", splitClaim: "split", blockedClaim: "blocked" }[d.subject];
  if (claim.kind !== kind) return `主张 ${d.claim} 是 ${claim.kind}，不能用 subject ${d.subject} 裁定。`;
  if (d.subject === "question" && d.verdict.kind === "implDefect" && (claim.kind !== "question" || claim.context.kind !== "member"))
    return "implDefect 只适用于成员 context 的问题；验收席位的问题请选 answered、outOfDomain、designGap 或 acceptanceMethod。";
  if (d.subject === "noCodeClaim" || d.subject === "splitClaim") {
    if (claim.kind === "question" || !sameIssue(claim.member, d.member)) return `Decision 的 member 不是主张 ${d.claim} 所指的成员。`;
    const current = facts.issues.find((i) => sameIssue(i.ref, d.member))?.bodyHash ?? null;
    if (current !== d.bodyHash) return `bodyHash 不是 ${issueKey(d.member)} 的当前正文哈希${current === null ? "" : `（当前为 ${current}）`}。`;
  }
  return null;
}

/** Context of the pending question a `claim(question)` decision answers (null when it is not a pending question). */
function questionContext(state: AgendaState, claimId: ReplyId): Context | null {
  const claim = state.claims.find((x) => x.id === claimId)?.claim;
  return claim !== undefined && claim.kind === "question" ? claim.context : null;
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

// ---------------------------------------------------------------- state helpers

const next = (state: AgendaState): Transition => ({ kind: "next", state });

const memberOf = (state: AgendaState, ref: IssueRef): MemberState => state.members.find((m) => sameIssue(m.issue, ref)) ?? emptyMember(ref);

function updateMember(state: AgendaState, ref: IssueRef, f: (m: MemberState) => MemberState): AgendaState {
  const exists = state.members.some((m) => sameIssue(m.issue, ref));
  return { ...state, members: exists ? state.members.map((m) => (sameIssue(m.issue, ref) ? f(m) : m)) : [...state.members, f(emptyMember(ref))] };
}

function uniqueIssues(list: readonly IssueRef[]): IssueRef[] {
  const out: IssueRef[] = [];
  for (const i of list) if (!out.some((o) => sameIssue(o, i))) out.push(i);
  return out;
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

