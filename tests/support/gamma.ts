// γ: concrete Snapshots for a given abstract Situation (core.md §6.2 抽象层).
// Each constructor is parametrised by a Variant so γ₁ and γ₂ differ in numbers, ids, timestamps and irrelevant records.

import { canonical, classify, fnv64, obligationId } from "../../src/core/index.ts";
import type {
  AgentId,
  Author,
  BodyReplacement,
  Decision,
  Draft,
  DraftId,
  Observed,
  EventId,
  LifecycleEvent,
  FindingVerdict,
  Hash,
  Host,
  IssueFact,
  IssueRef,
  Manifest,
  ClosureSituation,
  MemberSituation,
  Millis,
  ObligationId,
  PrFact,
  PrRef,
  RecordBody,
  RecordId,
  RepoRef,
  Sha,
  Snapshot,
  StoredRecord,
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
  /** Add records and facts no rule may read (another issue's claim and PR, unrelated seats, stray markers and commits). */
  readonly noise: boolean;
}

export const VARIANTS: readonly [Variant, Variant] = [
  { name: "γ1", repo: { owner: "lab", name: "sandbox" }, member: 11, pr: 21, t0: 2_000, noise: false },
  { name: "γ2", repo: { owner: "Other-Org", name: "Big.Repo" }, member: 437, pr: 9_001, t0: 7_777_000, noise: true },
];

export type Built = { readonly kind: "built"; readonly snap: Snapshot; readonly host: Host } | { readonly kind: "infeasible"; readonly reason: string };

const infeasible = (reason: string): Built => ({ kind: "infeasible", reason });

// ------------------------------------------------------------------ assembly helpers

class Assembly {
  readonly v: Variant;
  readonly m: IssueRef;
  private clock: number;
  private seq = 0;
  records: StoredRecord[] = [];
  issues: IssueFact[];
  prs: PrFact[] = [];
  markers: ObligationId[] = [];
  entry: { designOnly: boolean; adoptPr: PrRef | null } = { designOnly: false, adoptPr: null };
  onDefault: Sha[] = [];

  constructor(v: Variant) {
    this.v = v;
    this.m = { repo: v.repo, number: v.member };
    this.clock = v.t0;
    this.issues = [this.issue(1, { isAgendaRecord: true, acceptanceRows: [] }), this.issue(v.member)];
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
      appliedDecisions: [],
      acceptanceRows: [`${this.v.repo.owner}/${this.v.repo.name}#${n}/r1`, `${this.v.repo.owner}/${this.v.repo.name}#${n}/r2`],
      children: [],
      draftMarker: null,
      isAgendaRecord: false,
      ...over,
    };
  }

  now(): Millis {
    this.clock += 7;
    return this.clock as Millis;
  }

  eventId(): EventId {
    return `${this.v.name}-ev-${++this.seq}` as EventId;
  }

  add(body: RecordBody, over: { obligation?: ObligationId | null; manifest?: Manifest | null; key?: string; author?: Author } = {}): StoredRecord {
    const id = `${this.v.name}-r${++this.seq}` as RecordId;
    const rec: StoredRecord = {
      id,
      at: this.now(),
      author: over.author ?? { kind: "main" },
      obligation: over.obligation ?? null,
      idempotencyKey: over.key ?? `${id}-key`,
      manifest: over.manifest ?? null,
      payloadHash: fnv64(id),
      body,
    };
    this.records.push(rec);
    return rec;
  }

  decision(decision: Decision, drafts: readonly Draft[] = [], bodyReplacements: readonly BodyReplacement[] = []): StoredRecord {
    return this.add({ kind: "decision", decision, rationale: "r", drafts, bodyReplacements });
  }

  submit(obligation: ObligationId | null, head: Sha): StoredRecord {
    return this.add({ kind: "prSubmit", member: this.m, branch: "feat", head, title: "t", body: "b", template: "fourLayer", retryNote: null }, { obligation: obligation ?? (`${this.v.name}-ob-filler` as ObligationId) });
  }

  claim(kind: "question" | "noCode" | "split" | "blocked", context: "member" | { unit: IssueRef } | "closure" = "member"): StoredRecord {
    const author: Author = { kind: "seat", agentId: `rt-seat-${this.v.name}` as AgentId, requestName: `rt-seat-${this.v.name}` };
    switch (kind) {
      case "question":
        return this.add(
          {
            kind: "claim",
            claim: {
              kind: "question",
              context: context === "member" ? { kind: "member", member: this.m } : context === "closure" ? { kind: "agendaClosure" } : { kind: "unitVerification", unit: context.unit },
              reproduction: "p",
              readings: ["a", "b"],
              earliestGap: "g",
              proposal: "x",
            },
          },
          { author },
        );
      case "noCode":
        return this.add({ kind: "claim", claim: { kind: "noCode", member: this.m, evidence: "e" } }, { author });
      case "split":
        return this.add({ kind: "claim", claim: { kind: "split", member: this.m, proposal: "p" } }, { author });
      case "blocked":
        return this.add({ kind: "claim", claim: { kind: "blocked", member: this.m, category: "c", attempts: "a" } }, { author });
    }
  }

  replaceM(): BodyReplacement {
    const i = this.issues.find((x) => x.ref.number === this.m.number);
    return { issue: this.m, baseHash: i?.bodyHash ?? ("" as Hash), body: "new" };
  }

  snapshot(parent: IssueRef | null = null): Snapshot {
    const noiseRecords: StoredRecord[] = [];
    const noiseMarkers: ObligationId[] = [];
    const noisePrs: PrFact[] = [];
    if (this.v.noise) {
      const other: IssueRef = { repo: this.v.repo, number: this.v.member + 500 };
      noiseRecords.push({
        id: `${this.v.name}-noise-claim` as RecordId,
        at: (this.v.t0 + 1) as Millis,
        author: { kind: "seat", agentId: "rt-elsewhere-owner" as AgentId, requestName: "rt-elsewhere-owner" },
        obligation: null,
        idempotencyKey: "noise-claim",
        manifest: null,
        payloadHash: "n" as Hash,
        body: { kind: "claim", claim: { kind: "noCode", member: other, evidence: "irrelevant" } },
      });
      noiseRecords.push({
        id: `${this.v.name}-noise-seat` as RecordId,
        at: (this.v.t0 + 2) as Millis,
        author: { kind: "main" },
        obligation: null,
        idempotencyKey: "noise-seat",
        manifest: null,
        payloadHash: "n" as Hash,
        body: { kind: "decision", decision: { subject: "seated", requestName: "rt-elsewhere-owner", previous: null, agentId: "rt-elsewhere-owner" as AgentId }, rationale: "", drafts: [], bodyReplacements: [] },
      });
      noiseMarkers.push("ob-stray-marker" as ObligationId);
      noisePrs.push({
        ref: { repo: this.v.repo, number: this.v.pr + 77 },
        state: { kind: "merged", mergeSha: `noise-merge-${this.v.name}` as Sha, mergedAt: (this.v.t0 + 3) as Millis },
        head: "noise-head" as Sha,
        target: { repo: this.v.repo, base: "main" },
        bodyHash: "noise-pr" as Hash,
        appliedSubmit: null,
        mergeable: "yes",
        checks: { state: "pass", failedRunId: null, latestRunCreatedAt: null },
        closes: [other],
        agendaMarker: false,
      });
    }
    return {
      agenda: {
        record: { repo: this.v.repo, number: 1 },
        createdAt: (this.v.t0 - 500) as Millis,
        parent,
        convened: [{ issue: this.m, target: { repo: this.v.repo, base: "main" }, designOnly: this.entry.designOnly, adoptPr: this.entry.adoptPr }],
      },
      issues: this.issues,
      prs: [...this.prs, ...noisePrs],
      commits: { onDefault: this.onDefault.map((sha) => ({ repo: this.v.repo, sha })), contains: [], defaultHead: [] },
      records: [...noiseRecords, ...this.records],
      effectMarkers: [...noiseMarkers, ...this.markers],
    };
  }
}

const NO_HOST: Host = { agents: [], failures: [] };
const classifyOf = (a: Assembly): Classified => classify(a.snapshot(), NO_HOST);

// ------------------------------------------------------------------ member

export function memberGamma(t: MemberSituation, v: Variant): Built {
  const broken = violations(MEMBER_CONSTRAINTS, t);
  if (broken.length > 0) return infeasible(broken.join("; "));
  const vfa = t.review === "validFailAdjudicated" || t.accept === "validFailAdjudicated";
  // where the owner repair comes from: an upheld finding, else a checks fixNeeded decision, else an implDefect answer
  const ownerSource: "verdict" | "implDefect" | "fixNeeded" | null = !t.repairOwner ? null : vfa ? "verdict" : t.checksDecided === "fixNeeded" ? "fixNeeded" : "implDefect";
  const ctx = `${v.repo.owner}/${v.repo.name}#${v.member}`;

  const a = new Assembly(v);
  a.entry = { designOnly: t.designOnly, adoptPr: null };
  const head = `h-${v.name}` as Sha;
  const prRef: PrRef = { repo: v.repo, number: v.pr };
  const run = `run-${v.name}`;
  if (t.ours === "maintainable") {
    // deliverDone=false with a maintainable PR: the PR was adopted at convening (W15)
    if (!t.deliverDone) a.entry = { designOnly: t.designOnly, adoptPr: prRef };
    a.prs.push({
      ref: prRef,
      state: { kind: "open" },
      head,
      target: { repo: v.repo, base: "main" },
      bodyHash: `prbody-${v.name}` as Hash,
      appliedSubmit: null,
      mergeable: t.mergeable,
      checks: { state: t.checks, failedRunId: t.checks === "fail" ? run : null, latestRunCreatedAt: (v.t0 + 1) as Millis },
      closes: [a.m],
      agendaMarker: t.deliverDone || v.noise,
    });
  }
  if (t.foreign) {
    a.prs.push({
      ref: { repo: v.repo, number: v.pr + 1 },
      state: { kind: "open" },
      head: `foreign-${v.name}` as Sha,
      target: { repo: v.repo, base: v.noise ? "dev" : "main" },
      bodyHash: "foreign" as Hash,
      appliedSubmit: null,
      mergeable: "yes",
      checks: { state: "pass", failedRunId: null, latestRunCreatedAt: null },
      closes: v.noise ? [a.m, { repo: v.repo, number: v.member + 500 }] : [a.m],
      agendaMarker: v.noise,
    });
  }

  const base0 = classifyOf(a).member;
  if (base0 === null) return infeasible("γ: member not active in the base assembly");
  // 1. submits and checks facts (all before any findings decision: a later PrSubmit supersedes an adjudicated verdict)
  if (t.deliverDone) a.submit(base0.w.ids.deliver, head);
  if (t.checksRunFixed) a.submit(obligationId("fix", ctx, { kind: "checksFail", runId: run }, 1), head);
  if (t.checksDecided !== "none") {
    a.decision({ subject: "checks", pr: prRef, runId: run, verdict: t.checksDecided });
    // a later PrSubmit clears the fixNeeded repair
    if (t.checksDecided === "fixNeeded" && ownerSource !== "fixNeeded") a.submit(null, head);
  }
  if (t.fixDone && t.mergeable === "no" && !t.repairOwner) {
    const c = classifyOf(a).member;
    if (c === null || c.w.ids.fix === null) return infeasible("γ: no conflict fix trigger");
    a.submit(c.w.ids.fix, head);
  }
  // 2. gate verdicts, each adjudicated failing verdict carrying the repair of the target
  for (const gate of ["review", "accept"] as const) {
    const state = gate === "review" ? t.review : t.accept;
    if (state === "none") continue;
    const c = classifyOf(a).member;
    if (c === null) return infeasible("γ: member vanished while adding verdicts");
    const current = gate === "review" ? c.w.reviewManifest : c.w.acceptManifest;
    if (current === null || !("head" in current)) return infeasible("γ: no manifest");
    const manifest: Manifest = state === "stale" ? (v.noise ? { ...current, memberBodyHash: "old-body" as Hash } : { ...current, head: "old-head" as Sha }) : current;
    const pass = state === "validPass" || state === "stale";
    const verdict: Verdict =
      gate === "review"
        ? { gate: "review", observedHead: head, gates: pass ? ["pass", "pass", "pass", "pass", "pass"] : ["fail", "notRun", "notRun", "notRun", "notRun"], findings: pass ? [] : [finding("f1"), finding("f2")] }
        : { gate: "accept", observedHead: head, rows: [{ rowId: "r1", command: "c", output: "o", pass }, { rowId: "r2", command: "c", output: "o", pass: true }], findings: pass ? [] : [finding("f1"), finding("f2")], unrelated: [] };
    // a verdict answers the obligation of its own pin: for a stale verdict that is the old pin's id
    const obligation = state === "stale" ? obligationId(gate, ctx, manifest, 1) : ((gate === "review" ? c.w.ids.review : c.w.ids.accept) ?? ("ob-x" as ObligationId));
    const rec = a.add({ kind: "verdict", obligation, verdict }, { obligation, manifest, key: `${ctx}|${obligation}` });
    if (state === "superseded" || state === "validFailAdjudicated") {
      const draft: Draft = { index: 0, repo: v.repo, title: "t", body: "b", anchor: { kind: "outsideAgenda" }, target: { repo: v.repo, base: "main" }, designOnly: false };
      const f1: FindingVerdict = state === "validFailAdjudicated" && ownerSource === "verdict" ? { kind: "upheld", responsible: "owner" } : { kind: "rejected", basis: "b" };
      const f2: FindingVerdict = state === "validFailAdjudicated" && t.repairMain ? { kind: "upheld", responsible: "main" } : v.noise ? { kind: "outOfScope", draft } : { kind: "rejected", basis: "b" };
      a.decision({ subject: "findings", verdictRecord: rec.id, perFinding: [{ findingId: "f1", verdict: f1 }, { findingId: "f2", verdict: f2 }] });
    }
  }
  // 3. other repairs and blocks
  if (ownerSource === "implDefect") {
    const q = a.claim("question");
    a.decision({ subject: "question", claim: q.id, verdict: { kind: "implDefect" }, affected: [a.m] });
  }
  if (t.externalBlock && t.checksDecided !== "external") {
    const b = a.claim("blocked");
    a.decision({ subject: "blockedClaim", claim: b.id, verdict: "external", abandon: null });
  }
  if (t.foreignNoticed) {
    const c = classifyOf(a).member;
    if (c === null || c.w.ids.noticeForeignPr === null) return infeasible("γ: no noticeForeignPr id");
    a.markers.push(c.w.ids.noticeForeignPr);
  }
  // 4. materialization: the PR carries the latest PrSubmit unless the target is pending
  const submits = a.records.filter((r) => r.body.kind === "prSubmit");
  const latest = submits.at(-1) ?? null;
  const viaSubmit = t.materialized === "pending" && t.ours === "maintainable" && latest !== null && !v.noise;
  a.prs = a.prs.map((p) => (p.ref.number !== v.pr ? p : { ...p, appliedSubmit: viaSubmit ? (submits.at(-2)?.id ?? null) : (latest?.id ?? null) }));
  if (t.materialized === "pending" && !viaSubmit && !(t.ours === "none" && t.deliverDone)) {
    // an unapplied body replacement on M from an `answered` question (no contract change)
    const q = a.claim("question");
    a.decision({ subject: "question", claim: q.id, verdict: { kind: "answered" }, affected: [] }, [], [a.replaceM()]);
  }
  // 5. the target's own pending claim, last so it is the earliest undecided one
  if (t.claim !== "none") a.claim(t.claim);
  return { kind: "built", snap: a.snapshot(), host: NO_HOST };
}

function finding(id: string): { id: string; location: string; consequence: string; reproduction: string; responsible: "owner" } {
  return { id, location: "a.ts:1", consequence: "c", reproduction: "r", responsible: "owner" };
}


// ------------------------------------------------------------------ reconcile: history search
// A reconcile history is a timeline of facts and records on M; each token is one step, in time order. Decisions pin the
// latest event of their kind at the moment they are written (closed decisions also the body hash of that moment).
// γ searches histories up to a bounded length and keeps, per ReconcileSituation, the first one; γ2 replays it under the
// other Variant. Histories are only timeline-consistent: they need not be admissible step by step, since classify reads
// any verified record set.

/**
 * C/O: human close/reopen. M: a PR closing M merges. N: Main's unsolicited noCode confirmation. X: a noCode claim and
 * its refutation. Kn/Kr: closed decision (confirmedNoCode/reopen) on the latest close. Rs/Rc/Ra: reopened decision
 * (restore/correction/reopenAccepted) on the latest reopen. B: M's body is edited.
 */
export type ReconcileToken = "C" | "O" | "M" | "N" | "X" | "Kn" | "Kr" | "Rs" | "Rc" | "Ra" | "B";
export const RECONCILE_TOKENS: readonly ReconcileToken[] = ["C", "O", "M", "N", "X", "Kn", "Kr", "Rs", "Rc", "Ra", "B"];

export interface ReconcileHistory {
  readonly steps: readonly ReconcileToken[];
  /** The unit carries a passing postMerge verdict on the current manifest at the end. */
  readonly postMergePass: boolean;
}

/** Whether `token` can follow `steps` (the issue alternates closed/reopened; a PR merges once; pins need an event). */
export function reconcileTokenApplies(steps: readonly ReconcileToken[], token: ReconcileToken): boolean {
  const events = steps.filter((s) => s === "C" || s === "O");
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
      return events.includes("C");
    case "Rs":
    case "Rc":
    case "Ra":
      return events.includes("O");
    case "N":
    case "X":
    case "B":
      return true;
  }
}

/**
 * Breadth-first search over histories up to `maxSteps`, keeping per ReconcileSituation the first history (γ1) that
 * classifies to it. Frontier histories are merged when they agree on the situation and on the facts later tokens read
 * (open, merged, which event kinds exist, the last two tokens), which keeps the search small; completeness is not
 * claimed here: the abstraction test asserts that every consistent value was found.
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
        const r = classify(b.snap, b.host).reconcile.find((x) => x.w.member.number === VARIANTS[0].member);
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
  const ctx = `${v.repo.owner}/${v.repo.name}#${v.member}`;
  const events: LifecycleEvent[] = [];
  let body = 0;
  const bodyHash = (): Hash => `body-${v.name}-${v.member}-${body}` as Hash;
  let open = true;
  for (const t of h.steps) {
    switch (t) {
      case "C":
      case "O":
        events.push({ id: a.eventId(), kind: t === "C" ? "closed" : "reopened", at: a.now() });
        open = t === "O";
        break;
      case "M":
        a.prs.push({
          ref: { repo: v.repo, number: v.pr },
          state: { kind: "merged", mergeSha: `m-${v.name}` as Sha, mergedAt: a.now() },
          head: `h-${v.name}` as Sha,
          target: { repo: v.repo, base: "main" },
          bodyHash: "pr" as Hash,
          appliedSubmit: null,
          mergeable: "yes",
          checks: { state: "pass", failedRunId: null, latestRunCreatedAt: null },
          closes: [a.m],
          agendaMarker: true,
        });
        break;
      case "N":
        a.decision({ subject: "noCode", member: a.m, bodyHash: bodyHash(), reason: "satisfied" });
        break;
      case "X": {
        const claim = a.claim("noCode");
        a.decision({ subject: "noCodeClaim", claim: claim.id, member: a.m, bodyHash: bodyHash(), verdict: "refuted" });
        break;
      }
      case "Kn":
      case "Kr": {
        const e = [...events].reverse().find((x) => x.kind === "closed");
        if (e === undefined) return infeasible("no close event to pin");
        a.decision({ subject: "closed", member: a.m, event: e.id, bodyHash: bodyHash(), verdict: t === "Kn" ? "confirmedNoCode" : "reopen" });
        break;
      }
      case "Rs":
      case "Rc":
      case "Ra": {
        const e = [...events].reverse().find((x) => x.kind === "reopened");
        if (e === undefined) return infeasible("no reopen event to pin");
        a.decision({ subject: "reopened", member: a.m, event: e.id, verdict: t === "Rs" ? "restore" : t === "Rc" ? "correction" : "reopenAccepted" });
        break;
      }
      case "B":
        body++;
        a.now();
        break;
    }
  }
  a.issues = a.issues.map((i) => (i.ref.number === v.member ? { ...i, open, events, bodyHash: bodyHash() } : i));
  // keep M's unit current: γ1 adds a pending correction member, γ2 an unapplied body replacement on M
  const members: IssueRef[] = [a.m];
  if (!v.noise) {
    const carrier = a.decision({ subject: "stall", key: "k" as Hash, verdict: "resolved" }, [
      { index: 0, repo: v.repo, title: "c", body: "b", anchor: { kind: "correctionOf", entry: a.m }, target: { repo: v.repo, base: "main" }, designOnly: false },
    ]);
    const c = a.issue(v.member + 1, { draftMarker: `${carrier.id}#0` as DraftId });
    a.issues.push(c);
    members.push(c.ref);
  } else {
    const q = a.claim("question");
    a.decision({ subject: "question", claim: q.id, verdict: { kind: "answered" }, affected: [] }, [], [a.replaceM()]);
  }
  if (h.postMergePass) {
    const merges: Observed[] = h.steps.includes("M") ? [{ repo: v.repo, commit: `m-${v.name}` as Sha }] : [];
    const manifest: Manifest = {
      gate: "postMerge",
      merges,
      memberBodyHashes: members.map((m) => a.issues.find((i) => i.ref.number === m.number)?.bodyHash ?? ("" as Hash)),
      contractDecisions: [],
      designCommits: [],
    };
    const vctx = `verify:${ctx}`;
    const obligation = obligationId("postMerge", vctx, manifest, 1);
    const rows = members.flatMap((m) => a.issues.find((i) => i.ref.number === m.number)?.acceptanceRows ?? []).map((rowId) => ({ rowId, command: "c", output: "o", pass: true }));
    a.add({ kind: "verdict", obligation, verdict: { gate: "postMerge", observed: merges, rows, unrelated: [] } }, { obligation, manifest, key: `${vctx}|${obligation}` });
  }
  return { kind: "built", snap: a.snapshot(), host: NO_HOST };
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
    if (outcome === "delivered")
      a.prs.push({
        ref: { repo: v.repo, number: prNumber },
        state: { kind: "merged", mergeSha: `m-${v.name}-${ref.number}` as Sha, mergedAt: a.now() },
        head: `h-${ref.number}` as Sha,
        target: { repo: v.repo, base: "main" },
        bodyHash: "pr" as Hash,
        appliedSubmit: null,
        mergeable: "yes",
        checks: { state: "pass", failedRunId: null, latestRunCreatedAt: null },
        closes: [ref],
        agendaMarker: true,
      });
    else a.decision({ subject: "noCode", member: ref, bodyHash: `body-${v.name}-${ref.number}` as Hash, reason: "satisfied" });
  };
  settle(a.m, r.mOutcome, v.pr);
  if (r.mClosed) a.issues = a.issues.map((i) => (i.ref.number === v.member ? { ...i, open: false, events: [{ id: a.eventId(), kind: "closed", at: a.now() }] } : i));
  if (r.correction !== "none") {
    const carrier = a.decision({ subject: "stall", key: "k" as Hash, verdict: "resolved" }, [
      { index: 0, repo: v.repo, title: "c", body: "b", anchor: { kind: "correctionOf", entry: a.m }, target: { repo: v.repo, base: "main" }, designOnly: false },
    ]);
    const c = a.issue(v.member + 1, { draftMarker: `${carrier.id}#0` as DraftId, open: false, events: [{ id: a.eventId(), kind: "closed", at: a.now() }] });
    a.issues.push(c);
    settle(c.ref, r.correction, v.pr + 2);
  }
  if (r.failDecision !== "none" && r.verdict !== "fail") return infeasible("a fail decision answers a failing verdict");
  if (r.verdict !== "none") {
    const c = classifyOf(a).verification;
    if (c === null) return infeasible("unit not in its verification phase");
    const vctx = `verify:${v.repo.owner}/${v.repo.name}#${v.member}`;
    const current = c.w.manifest;
    if (current.gate !== "postMerge") return infeasible("γ: manifest");
    const manifest: Manifest = r.verdict === "stale" ? { ...current, memberBodyHashes: current.memberBodyHashes.map(() => "old" as Hash) } : current;
    const pass = r.verdict !== "fail";
    const obligation = r.verdict === "stale" ? obligationId("postMerge", vctx, manifest, 1) : c.w.ids.postMerge;
    const rec = a.add(
      { kind: "verdict", obligation, verdict: { gate: "postMerge", observed: current.merges, rows: [{ rowId: "r1", command: "c", output: "o", pass }], unrelated: [] } },
      { obligation, manifest, key: `${vctx}|${obligation}` },
    );
    if (r.failDecision !== "none") {
      const drafts: Draft[] =
        r.failDecision === "correction"
          ? [{ index: 0, repo: v.repo, title: "c2", body: "b", anchor: { kind: "correctionOf", entry: a.m }, target: { repo: v.repo, base: "main" }, designOnly: false }]
          : [];
      a.decision({ subject: "postMergeFail", verdictRecord: rec.id, verdict: r.failDecision }, drafts);
    }
  } else if (r.failDecision !== "none") return infeasible("no verdict to decide");
  if (r.claim) a.claim("question", { unit: a.m });
  return { kind: "built", snap: a.snapshot(), host: NO_HOST };
}

// ------------------------------------------------------------------ closure: direct construction

export function closureGamma(t: ClosureSituation, v: Variant): Built {
  const broken = violations(CLOSURE_CONSTRAINTS, t);
  if (broken.length > 0) return infeasible(broken.join("; "));
  const a = new Assembly(v);
  const parentRef: IssueRef = { repo: v.repo, number: v.member + 1000 };
  // M is terminal as a closed noCode member (confirmed, then closed), or still pending
  if (t.allUnitsTerminal) {
    a.decision({ subject: "noCode", member: a.m, bodyHash: `body-${v.name}-${v.member}` as Hash, reason: "satisfied" });
    const at = a.now();
    a.issues = a.issues.map((i) => (i.ref.number === v.member ? { ...i, open: false, events: [{ id: a.eventId(), kind: "closed", at }] } : i));
  }
  if (t.strandedDesign) {
    // a withPr design commit that is neither on the default branch nor in any open PR
    const q = a.claim("question");
    a.decision({ subject: "question", claim: q.id, verdict: { kind: "designGap", route: { kind: "withPr", commit: `d-${v.name}` as Sha, designBranch: "design" } }, affected: [] });
  }
  if (t.parent !== "none") {
    const children = v.noise ? [a.m, { repo: v.repo, number: 1 }] : [a.m];
    a.issues.push(a.issue(parentRef.number, { open: t.parent === "open", children, acceptanceRows: [`${v.repo.owner}/${v.repo.name}#${parentRef.number}/c1`] }));
  }
  const snap0 = (): Snapshot => a.snapshot(t.parent === "none" ? null : parentRef);
  if (t.closure !== "none") {
    const c = classify(snap0(), NO_HOST).closure;
    const current = c.w.manifest;
    if (current === null || current.gate !== "closure" || c.w.ids.closure === null) return infeasible("γ: no closure manifest");
    const manifest: Manifest = t.closure === "stale" ? { ...current, parentBodyHash: "old-parent" as Hash } : current;
    const obligation = t.closure === "stale" ? obligationId("closure", "closure", manifest, 1) : c.w.ids.closure;
    const pass = t.closure !== "validFailUnadjudicated";
    const rows = [{ rowId: `${v.repo.owner}/${v.repo.name}#${parentRef.number}/c1`, command: "c", output: "o", pass }];
    const rec = a.add({ kind: "verdict", obligation, verdict: { gate: "closure", observed: current.merges, rows } }, { obligation, manifest, key: `closure|${obligation}` });
    if (t.failDecision !== "none") a.decision({ subject: "closureFail", verdictRecord: rec.id, verdict: t.failDecision });
  }
  if (t.claim !== "none") a.claim("question", "closure");
  if (t.reported) a.decision({ subject: "report", summary: "s" });
  return { kind: "built", snap: snap0(), host: NO_HOST };
}
