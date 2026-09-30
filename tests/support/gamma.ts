// γ: concrete inputs (agenda state + GitHub facts) for a given abstract Situation (core.md §6.2 抽象层).
// Each constructor is parametrised by a Variant so γ₁ and γ₂ differ in numbers, ids, timestamps and irrelevant state.

import { bodyHash, canonical, classify, computeUnits, emptyMember, obligationId } from "../../src/core/index.ts";
import { unitManifest } from "../../src/core/classify.ts";
import type {
  AgendaId,
  AgendaState,
  AgentId,
  Claim,
  ClosureSituation,
  ContractDecision,
  DraftState,
  DraftId,
  EventId,
  Facts,
  FindingVerdict,
  GateSlot,
  Hash,
  Host,
  IssueFact,
  IssueRef,
  LifecycleEvent,
  Manifest,
  MemberSituation,
  MemberState,
  Millis,
  ObligationId,
  PendingClaim,
  PrFact,
  PrRef,
  ReplacementState,
  ReplyId,
  RepoRef,
  Sha,
  StoredVerdict,
  SubjectDecision,
  UnitState,
  Verdict,
} from "../../src/core/index.ts";
import type { Classified } from "../../src/core/classify.ts";
import { CLOSURE_CONSTRAINTS, MEMBER_CONSTRAINTS, violations } from "./consistency.ts";

export interface Variant {
  readonly name: string;
  readonly repo: RepoRef;
  readonly member: number;
  readonly pr: number;
  readonly t0: number;
  /** Add state and facts no rule may read (another issue's claim and PR, an unrelated seat, stray commits), and use GitHub's other closing-reference shape. */
  readonly noise: boolean;
}

export const VARIANTS: readonly [Variant, Variant] = [
  { name: "γ1", repo: { owner: "lab", name: "sandbox" }, member: 11, pr: 21, t0: 2_000, noise: false },
  { name: "γ2", repo: { owner: "Other-Org", name: "Big.Repo" }, member: 437, pr: 9_001, t0: 7_777_000, noise: true },
];

export type Built = { readonly kind: "built"; readonly state: AgendaState; readonly facts: Facts; readonly host: Host } | { readonly kind: "infeasible"; readonly reason: string };

const infeasible = (reason: string): Built => ({ kind: "infeasible", reason });

// ------------------------------------------------------------------ assembly helpers

class Assembly {
  readonly v: Variant;
  readonly m: IssueRef;
  private clock: number;
  private seq = 0;
  issues: IssueFact[];
  prs: PrFact[] = [];
  onDefault: Sha[] = [];
  designOnly = false;
  adoptPr: PrRef | null = null;
  member: MemberState;
  members: MemberState[] = [];
  drafts: DraftState[] = [];
  claims: PendingClaim[] = [];
  contracts: ContractDecision[] = [];
  replacements: ReplacementState[] = [];
  units: UnitState[] = [];
  closure: GateSlot = { attempt: 1, verdict: null };
  subjects: SubjectDecision[] = [];
  reported = false;

  constructor(v: Variant) {
    this.v = v;
    this.m = { repo: v.repo, number: v.member };
    this.clock = v.t0;
    this.member = emptyMember(this.m);
    this.issues = [this.issue(v.member)];
    if (v.noise) {
      this.issues.push(this.issue(v.member + 500));
      this.onDefault.push(`noise-${v.member}` as Sha);
    }
  }

  issue(n: number, over: Partial<IssueFact> = {}): IssueFact {
    return {
      ref: { repo: this.v.repo, number: n },
      open: true,
      events: [],
      bodyHash: `body-${this.v.name}-${n}` as Hash,
      children: [],
      ...over,
    };
  }

  now(): Millis {
    this.clock += 7;
    return this.clock as Millis;
  }

  id(prefix: string): string {
    return `${this.v.name}-${prefix}${++this.seq}`;
  }

  eventId(): EventId {
    return this.id("ev") as EventId;
  }

  replyId(): ReplyId {
    return this.id("re") as ReplyId;
  }

  claim(kind: "question" | "noCode" | "split" | "blocked", context: "member" | { unit: IssueRef } | "closure" = "member"): PendingClaim {
    const claim: Claim =
      kind === "question"
        ? {
            kind: "question",
            context: context === "member" ? { kind: "member", member: this.m } : context === "closure" ? { kind: "agendaClosure" } : { kind: "unitVerification", unit: context.unit },
            reproduction: "p",
            readings: ["a", "b"],
            earliestGap: "g",
            proposal: "x",
          }
        : kind === "noCode"
          ? { kind: "noCode", member: this.m, evidence: "e" }
          : kind === "split"
            ? { kind: "split", member: this.m, proposal: "p" }
            : { kind: "blocked", member: this.m, category: "c", attempts: "a" };
    const pending = { id: this.replyId(), claim };
    this.claims.push(pending);
    return pending;
  }

  /** An unapplied body replacement on M (keeps M's materialization or its unit pending). */
  replaceM(): void {
    const i = this.issues.find((x) => x.ref.number === this.m.number);
    this.replacements.push({ decision: this.replyId(), issue: this.m, baseHash: i?.bodyHash ?? ("" as Hash), body: "new", targetHash: bodyHash("new"), applied: false });
  }

  /** A draft that became issue `n`, anchored as a correction of M. */
  correction(n: number, over: Partial<IssueFact> = {}): IssueFact {
    const c = this.issue(n, over);
    this.issues.push(c);
    this.drafts.push({
      id: `${this.replyId()}#0` as DraftId,
      draft: { index: 0, repo: this.v.repo, title: "c", body: "b", anchor: { kind: "correctionOf", entry: this.m }, target: { repo: this.v.repo, base: "main" }, designOnly: false },
      proposedAt: this.now(),
      issue: c.ref,
    });
    return c;
  }

  state(parent: IssueRef | null = null): AgendaState {
    const noise = this.v.noise;
    const other: IssueRef = { repo: this.v.repo, number: this.v.member + 500 };
    return {
      version: noise ? 42 : 3,
      id: `agenda-${this.v.name}` as AgendaId,
      convenedAt: (this.v.t0 - 500) as Millis,
      parent,
      convened: [{ issue: this.m, target: { repo: this.v.repo, base: "main" }, designOnly: this.designOnly, adoptPr: this.adoptPr }],
      drafts: this.drafts,
      members: [this.member, ...this.members],
      units: this.units,
      closure: this.closure,
      claims: noise ? [{ id: "noise-claim" as ReplyId, claim: { kind: "noCode", member: other, evidence: "irrelevant" } }, ...this.claims] : this.claims,
      contracts: this.contracts,
      replacements: this.replacements,
      subjects: this.subjects,
      effectDecisions: [],
      seats: noise ? [{ requestName: "rt-elsewhere-owner", holder: "rt-elsewhere-owner" as AgentId, wokenFor: null }] : [],
      lastDecision: noise ? ("noise-decision" as ReplyId) : null,
      reported: this.reported,
    };
  }

  facts(): Facts {
    const noisePrs: PrFact[] = this.v.noise
      ? [
          {
            ref: { repo: this.v.repo, number: this.v.pr + 77 },
            state: { kind: "merged", mergeSha: `noise-merge-${this.v.name}` as Sha, mergedAt: (this.v.t0 + 3) as Millis },
            headBranch: "elsewhere",
            head: "noise-head" as Sha,
            target: { repo: this.v.repo, base: "main" },
            bodyHash: "noise-pr" as Hash,
            mergeable: "yes",
            checks: { state: "pass", failedRunId: null },
            closes: [{ repo: this.v.repo, number: this.v.member + 500 }],
          },
        ]
      : [];
    return {
      issues: this.issues,
      prs: [...this.prs, ...noisePrs],
      commits: { onDefault: this.onDefault.map((sha) => ({ repo: this.v.repo, sha })), contains: [], baseHead: [] },
    };
  }

  merged(ref: IssueRef, number: number): void {
    this.prs.push({
      ref: { repo: this.v.repo, number },
      state: { kind: "merged", mergeSha: `m-${this.v.name}-${ref.number}` as Sha, mergedAt: this.now() },
      headBranch: `b-${ref.number}`,
      head: `h-${ref.number}` as Sha,
      target: { repo: this.v.repo, base: "main" },
      bodyHash: "pr" as Hash,
      mergeable: "yes",
      checks: { state: "pass", failedRunId: null },
      closes: [ref],
    });
  }

  built(parent: IssueRef | null = null): Built {
    return { kind: "built", state: this.state(parent), facts: this.facts(), host: NO_HOST };
  }
}

const NO_HOST: Host = { agents: [], failures: [] };
const classifyOf = (a: Assembly, parent: IssueRef | null = null): Classified => classify(a.state(parent), a.facts(), NO_HOST);

function storedVerdict(id: ReplyId, ticket: ObligationId, attempt: number, manifest: Manifest, verdict: Verdict, adjudication: FindingVerdict | null = null): StoredVerdict {
  return { id, ticket, attempt, manifest, verdict, adjudication, failDecision: null };
}

// ------------------------------------------------------------------ member

export function memberGamma(t: MemberSituation, v: Variant): Built {
  const broken = violations(MEMBER_CONSTRAINTS, t);
  if (broken.length > 0) return infeasible(broken.join("; "));
  // Each adjudicated failing verdict carries one ruling: the last such gate takes upheld(main) when repairMain holds, the
  // other takes upheld(owner). An owner repair without a second such gate comes from checks fixNeeded or implDefect.
  const vfaGates = (["review", "accept"] as const).filter((g) => (g === "review" ? t.review : t.accept) === "validFailAdjudicated");
  const mainGate = t.repairMain ? (vfaGates.at(-1) ?? null) : null;
  const ownerViaVerdict = t.repairOwner && vfaGates.some((g) => g !== mainGate);
  const ownerSource: "verdict" | "implDefect" | "fixNeeded" | null = !t.repairOwner ? null : ownerViaVerdict ? "verdict" : t.checksDecided === "fixNeeded" ? "fixNeeded" : "implDefect";

  const a = new Assembly(v);
  a.designOnly = t.designOnly;
  const head = `h-${v.name}` as Sha;
  const prRef: PrRef = { repo: v.repo, number: v.pr };
  const run = `run-${v.name}`;
  if (t.ours === "maintainable") {
    // without a completed deliver the maintainable PR was adopted at convening (W15)
    if (!t.deliverDone) a.adoptPr = prRef;
    a.member = { ...a.member, prs: [prRef] };
    a.prs.push({
      ref: prRef,
      state: { kind: "open" },
      headBranch: "feat",
      head,
      target: { repo: v.repo, base: "main" },
      bodyHash: `prbody-${v.name}` as Hash,
      mergeable: t.mergeable,
      checks: { state: t.checks, failedRunId: t.checks === "fail" ? run : null },
      // γ2: GitHub resolves no closing reference (non-default base); registration in `prs` stands in for it
      closes: v.noise ? [] : [a.m],
    });
  }
  const setM = (f: (m: MemberState) => MemberState): void => {
    a.member = f(a.member);
  };
  const submitFor = (answered: ObligationId): void =>
    setM((m) => ({ ...m, submit: { branch: "feat", head, title: "t", body: "b", template: "fourLayer", retryNote: null, answered, applied: true, appliedDesign: [] } }));

  const base0 = classifyOf(a).member;
  if (base0 === null) return infeasible("γ: member not active in the base assembly");
  // 1. the submit, checks facts and checks decisions
  if (t.deliverDone) submitFor(base0.w.ids.deliver);
  if (t.checksRunFixed) setM((m) => ({ ...m, fixedRun: run }));
  if (t.checksDecided !== "none") setM((m) => ({ ...m, checks: { runId: run, verdict: t.checksDecided === "none" ? "rerun" : t.checksDecided, rerunDone: false } }));
  if (ownerSource === "fixNeeded") setM((m) => ({ ...m, fixNeeded: { id: a.replyId(), rationale: "r" } }));
  if (ownerSource === "implDefect") setM((m) => ({ ...m, implDefect: { id: a.replyId(), rationale: "r" } }));
  if (t.externalBlock && t.checksDecided !== "external") setM((m) => ({ ...m, external: true }));
  // 2. gate verdicts, each adjudicated failing verdict carrying the repair of the target
  for (const gate of ["review", "accept"] as const) {
    const state = gate === "review" ? t.review : t.accept;
    if (state === "none") continue;
    const c = classifyOf(a).member;
    if (c === null) return infeasible("γ: member vanished while adding verdicts");
    const current = gate === "review" ? c.w.reviewManifest : c.w.acceptManifest;
    const ticket = gate === "review" ? c.w.ids.review : c.w.ids.accept;
    if (current === null || !("head" in current) || ticket === null) return infeasible("γ: no manifest");
    const manifest: Manifest = state === "stale" ? (v.noise ? { ...current, memberBodyHash: "old-body" as Hash } : { ...current, head: "old-head" as Sha }) : current;
    const pass = state === "validPass" || state === "stale";
    const verdict: Verdict = { gate, ok: pass, note: pass ? "ok" : "a.ts:1 breaks" };
    const vid = a.replyId();
    const adjudication: FindingVerdict | null =
      state === "superseded"
        ? { kind: "rejected", basis: "b" }
        : state === "validFailAdjudicated"
          ? gate === mainGate || !t.repairOwner
            ? { kind: "upheld", responsible: "main" }
            : { kind: "upheld", responsible: "owner" }
          : null;
    // superseded: the verdict was rejected, which moved the slot to the next attempt
    const slot: GateSlot = { attempt: state === "superseded" ? 2 : 1, verdict: storedVerdict(vid, ticket, 1, manifest, verdict, adjudication) };
    const rejected = gate === "review" && adjudication?.kind === "rejected" ? [vid] : [];
    setM((m) => (gate === "review" ? { ...m, review: slot, rejectedFindings: [...m.rejectedFindings, ...rejected] } : { ...m, accept: slot }));
  }
  // 3. the fix completed on the current trigger
  if (t.fixDone) {
    const c = classifyOf(a).member;
    if (c === null || c.w.ids.fix === null) return infeasible("γ: no fix trigger");
    submitFor(c.w.ids.fix);
    if (c.w.fixTrigger?.kind === "checksFail") setM((m) => ({ ...m, fixedRun: c.w.fixTrigger?.kind === "checksFail" ? c.w.fixTrigger.runId : m.fixedRun }));
  }
  // 4. materialization: γ1 leaves the submit unapplied when it can, otherwise an unapplied body replacement on M is pending
  if (t.materialized === "pending") {
    const viaSubmit = t.ours === "maintainable" && a.member.submit !== null && !v.noise;
    if (viaSubmit) setM((m) => (m.submit === null ? m : { ...m, submit: { ...m.submit, applied: false } }));
    else if (!(t.ours === "none" && t.deliverDone)) a.replaceM();
  }
  // 5. the target's own pending claim
  if (t.claim !== "none") a.claim(t.claim);
  return a.built();
}

// ------------------------------------------------------------------ reconcile: history search
// A reconcile history is a timeline of facts and decisions on M; each token is one step, in time order. Decisions pin the
// latest event of their kind at the moment they are made (closed decisions also the body hash of that moment); the
// state keeps only the latest decision of each kind. γ searches histories up to a bounded length and keeps, per
// ReconcileSituation, the first one; γ2 replays it under the other Variant.

/**
 * C/O: human close/reopen. M: a PR closing M merges. N: Main's unsolicited noCode confirmation. Kn/Kr: closed decision
 * (confirmedNoCode/reopen) on the latest close. Rs/Rc/Ra: reopened decision (restore/correction/reopenAccepted) on the
 * latest reopen. B: M's body is edited.
 */
export type ReconcileToken = "C" | "O" | "M" | "N" | "Kn" | "Kr" | "Rs" | "Rc" | "Ra" | "B";
export const RECONCILE_TOKENS: readonly ReconcileToken[] = ["C", "O", "M", "N", "Kn", "Kr", "Rs", "Rc", "Ra", "B"];

export interface ReconcileHistory {
  readonly steps: readonly ReconcileToken[];
  /** The unit carries a passing postMerge verdict on the current manifest at the end. */
  readonly postMergePass: boolean;
}

/**
 * Whether `token` can follow `steps`: the issue alternates closed/reopened; a PR merges once; a closed decision is made
 * while the issue is closed and a reopened decision while it is open, once per event, on the current event (derive
 * offers decide(closed|reopened) only while that event is undecided).
 */
export function reconcileTokenApplies(steps: readonly ReconcileToken[], token: ReconcileToken): boolean {
  const events = steps.filter((s) => s === "C" || s === "O");
  const sinceEvent = steps.slice(Math.max(steps.lastIndexOf("C"), steps.lastIndexOf("O")) + 1);
  const decided = sinceEvent.some((s) => s === "Kn" || s === "Kr" || s === "Rs" || s === "Rc" || s === "Ra");
  const open = events.length === 0 || events.at(-1) === "O";
  switch (token) {
    case "C":
      return open;
    case "O":
      return !open;
    case "M":
      return !steps.includes("M");
    case "Kn":
    case "Kr":
      return !open && !decided;
    case "Rs":
    case "Rc":
    case "Ra":
      return open && events.includes("O") && !decided;
    case "N":
    case "B":
      return true;
  }
}

/**
 * Breadth-first search over histories up to `maxSteps`, keeping per ReconcileSituation the first history (γ1) that
 * classifies to it. Frontier histories are merged when they agree on the situation and on the facts later tokens read
 * (open, merged, which event kinds exist, the last token), which keeps the search small; completeness is not claimed
 * here: the abstraction test asserts that every consistent value was found.
 */
export function searchReconcile(maxSteps: number): Map<string, ReconcileHistory> {
  const found = new Map<string, ReconcileHistory>();
  let frontier: ReconcileToken[][] = [[]];
  for (let depth = 0; depth <= maxSteps && frontier.length > 0; depth++) {
    const next: ReconcileToken[][] = [];
    const seen = new Set<string>();
    for (const steps of frontier) {
      let key = "";
      for (const postMergePass of [false, true]) {
        const b = reconcileGamma({ steps, postMergePass }, VARIANTS[0]);
        if (b.kind !== "built") continue;
        const r = classify(b.state, b.facts, b.host).reconcile.find((x) => x.w.member.number === VARIANTS[0].member);
        if (r === undefined) continue;
        const s = canonical(r.s);
        if (!found.has(s)) found.set(s, { steps, postMergePass });
        if (!postMergePass) key = s;
      }
      if (depth === maxSteps) continue;
      for (const t of RECONCILE_TOKENS) {
        if (!reconcileTokenApplies(steps, t)) continue;
        const ext = [...steps, t];
        const events = ext.filter((x) => x === "C" || x === "O");
        const k = canonical({ key, t, open: events.at(-1) !== "C", merged: ext.includes("M"), c: events.includes("C"), o: events.includes("O"), last: steps.slice(-1) });
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(ext);
      }
    }
    frontier = next;
  }
  return found;
}

export function reconcileGamma(h: ReconcileHistory, v: Variant): Built {
  const a = new Assembly(v);
  const events: LifecycleEvent[] = [];
  let body = 0;
  const hashNow = (): Hash => `body-${v.name}-${v.member}-${body}` as Hash;
  let open = true;
  for (const t of h.steps) {
    switch (t) {
      case "C":
      case "O":
        events.push({ id: a.eventId(), kind: t === "C" ? "closed" : "reopened", at: a.now() });
        open = t === "O";
        break;
      case "M":
        a.merged(a.m, v.pr);
        break;
      case "N":
        a.member = { ...a.member, noCode: { bodyHash: hashNow(), at: a.now() } };
        break;
      case "Kn":
      case "Kr": {
        const e = [...events].reverse().find((x) => x.kind === "closed");
        if (e === undefined) return infeasible("no close event to pin");
        const at = a.now();
        a.member = {
          ...a.member,
          closed: { event: e.id, bodyHash: hashNow(), verdict: t === "Kn" ? "confirmedNoCode" : "reopen" },
          noCode: t === "Kn" ? { bodyHash: hashNow(), at } : a.member.noCode,
        };
        break;
      }
      case "Rs":
      case "Rc":
      case "Ra": {
        const e = [...events].reverse().find((x) => x.kind === "reopened");
        if (e === undefined) return infeasible("no reopen event to pin");
        a.now();
        a.member = { ...a.member, reopened: { event: e.id, verdict: t === "Rs" ? "restore" : t === "Rc" ? "correction" : "reopenAccepted" }, noCode: t === "Ra" ? null : a.member.noCode };
        break;
      }
      case "B":
        body++;
        a.now();
        break;
    }
  }
  a.issues = a.issues.map((i) => (i.ref.number === v.member ? { ...i, open, events, bodyHash: hashNow() } : i));
  // keep M's unit current: γ1 adds a pending correction member, γ2 an unapplied body replacement on M
  if (!v.noise) a.correction(v.member + 1);
  else a.replaceM();
  if (h.postMergePass) {
    const probe = a.state();
    const facts = a.facts();
    const unit = computeUnits(probe)[0];
    if (unit === undefined) return infeasible("γ: no unit");
    const { manifest } = unitManifest(probe, facts, unit);
    if (manifest.gate !== "postMerge") return infeasible("γ: manifest");
    const ticket = obligationId("postMerge", `verify:${v.repo.owner}/${v.repo.name}#${v.member}`, manifest, 1);
    a.units = [{ top: a.m, postMerge: { attempt: 1, verdict: storedVerdict(a.replyId(), ticket, 1, manifest, { gate: "postMerge", ok: true, note: "ok" }) } }];
  }
  return a.built();
}

export interface VerificationRecipe {
  readonly correction: "none" | "delivered" | "noCode";
  readonly mOutcome: "delivered" | "noCode";
  readonly mClosed: boolean;
  readonly claim: boolean;
  readonly verdict: "none" | "pass" | "fail" | "stale";
  readonly failDecision: "none" | "correction" | "reverify";
}

export function* verificationRecipes(): Generator<VerificationRecipe> {
  for (const correction of ["none", "delivered", "noCode"] as const)
    for (const mOutcome of ["delivered", "noCode"] as const)
      for (const mClosed of [true, false])
        for (const claim of [false, true])
          for (const verdict of ["none", "pass", "fail", "stale"] as const)
            for (const failDecision of ["none", "correction", "reverify"] as const) yield { correction, mOutcome, mClosed, claim, verdict, failDecision };
}

export function verificationGamma(r: VerificationRecipe, v: Variant): Built {
  const a = new Assembly(v);
  const settle = (ref: IssueRef, outcome: "delivered" | "noCode", prNumber: number): void => {
    if (outcome === "delivered") a.merged(ref, prNumber);
    else {
      const ms: MemberState = { ...(ref.number === a.m.number ? a.member : emptyMember(ref)), noCode: { bodyHash: `body-${v.name}-${ref.number}` as Hash, at: a.now() } };
      if (ref.number === a.m.number) a.member = ms;
      else a.members.push(ms);
    }
  };
  settle(a.m, r.mOutcome, v.pr);
  if (r.mClosed) a.issues = a.issues.map((i) => (i.ref.number === v.member ? { ...i, open: false, events: [{ id: a.eventId(), kind: "closed", at: a.now() }] } : i));
  if (r.correction !== "none") {
    const c = a.correction(v.member + 1, { open: false, events: [{ id: a.eventId(), kind: "closed", at: a.now() }] });
    settle(c.ref, r.correction, v.pr + 2);
  }
  if (r.failDecision !== "none" && r.verdict !== "fail") return infeasible("a fail decision answers a failing verdict");
  if (r.verdict !== "none") {
    const c = classifyOf(a).verification;
    if (c === null) return infeasible("unit not in its verification phase");
    const current = c.w.manifest;
    if (current.gate !== "postMerge") return infeasible("γ: manifest");
    const manifest: Manifest = r.verdict === "stale" ? { ...current, memberBodyHashes: current.memberBodyHashes.map(() => "old" as Hash) } : current;
    const pass = r.verdict !== "fail";
    const verdict = storedVerdict(a.replyId(), c.w.ids.postMerge, 1, manifest, { gate: "postMerge", ok: pass, note: pass ? "ok" : "row 1 fails" });
    if (r.failDecision === "correction") {
      a.drafts.push({
        id: `${verdict.id}#0` as DraftId,
        draft: { index: 0, repo: v.repo, title: "c2", body: "b", anchor: { kind: "correctionOf", entry: a.m }, target: { repo: v.repo, base: "main" }, designOnly: false },
        proposedAt: a.now(),
        issue: null,
      });
    }
    // reverify moves the slot to the next attempt (core.md §3 尝试身份)
    a.units = [{ top: a.m, postMerge: { attempt: r.failDecision === "reverify" ? 2 : 1, verdict: { ...verdict, failDecision: r.failDecision === "none" ? null : r.failDecision } } }];
  } else if (r.failDecision !== "none") return infeasible("no verdict to decide");
  if (r.claim) a.claim("question", { unit: a.m });
  return a.built();
}

// ------------------------------------------------------------------ closure: direct construction

export function closureGamma(t: ClosureSituation, v: Variant): Built {
  const broken = violations(CLOSURE_CONSTRAINTS, t);
  if (broken.length > 0) return infeasible(broken.join("; "));
  const a = new Assembly(v);
  const parentRef: IssueRef = { repo: v.repo, number: v.member + 1000 };
  // M is terminal as a closed noCode member (confirmed, then closed), or still pending
  if (t.allUnitsTerminal) {
    a.member = { ...a.member, noCode: { bodyHash: `body-${v.name}-${v.member}` as Hash, at: a.now() } };
    const at = a.now();
    a.issues = a.issues.map((i) => (i.ref.number === v.member ? { ...i, open: false, events: [{ id: a.eventId(), kind: "closed", at }] } : i));
  }
  if (t.strandedDesign) {
    // a withPr design commit that is neither on the default branch nor in any open PR
    a.contracts.push({ id: a.replyId(), affected: [], routes: [{ route: { kind: "withPr", commit: `d-${v.name}` as Sha, designBranch: "design" }, carrier: a.m }] });
  }
  const parent = t.parent === "none" ? null : parentRef;
  if (parent !== null) {
    const children = v.noise ? [a.m, { repo: v.repo, number: v.member + 500 }] : [a.m];
    a.issues.push(a.issue(parentRef.number, { open: t.parent === "open", children }));
    // γ2's second child is terminal (merged elsewhere), so it raises no agenda gap
  }
  if (t.closure !== "none") {
    const c = classifyOf(a, parent).closure;
    const current = c.w.manifest;
    if (current === null || current.gate !== "closure" || c.w.ids.closure === null) return infeasible("γ: no closure manifest");
    const manifest: Manifest = t.closure === "stale" ? { ...current, parentBodyHash: "old-parent" as Hash } : current;
    const pass = t.closure !== "validFailUnadjudicated" && t.closure !== "superseded";
    const verdict = storedVerdict(a.replyId(), c.w.ids.closure, 1, manifest, { gate: "closure", ok: pass, note: pass ? "ok" : "c1 fails" });
    a.closure =
      t.closure === "superseded"
        ? { attempt: 2, verdict: { ...verdict, failDecision: "reverify" } }
        : { attempt: 1, verdict: { ...verdict, failDecision: t.failDecision === "none" ? null : t.failDecision } };
  }
  if (t.claim !== "none") a.claim("question", "closure");
  a.reported = t.reported;
  return a.built(parent);
}
