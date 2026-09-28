// γ: concrete Snapshots for a given abstract Situation (core.md §6.2 抽象层).
// Each constructor is parametrised by a Variant so γ₁ and γ₂ differ in numbers, ids, timestamps and irrelevant records.

import { classify, fnv64, obligationId } from "../../src/core/index.ts";
import type {
  AgentId,
  Author,
  BodyReplacement,
  Decision,
  Draft,
  DraftId,
  Observed,
  EventId,
  FindingVerdict,
  Hash,
  Host,
  IssueFact,
  IssueRef,
  Manifest,
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
import { MEMBER_CONSTRAINTS, violations } from "./consistency.ts";

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


// ------------------------------------------------------------------ reconcile and verification: recipe search
// These situations are small products; γ enumerates a finite space of concrete recipes and keeps, per Situation,
// the first recipe whose γ1 classifies to it. γ2 replays the same recipe under the other Variant.

export interface ReconcileRecipe {
  readonly outcome: "delivered" | "noCode" | "pending";
  /** Human lifecycle events on M in order (C = closed, R = reopened). */
  readonly events: "" | "C" | "CR" | "CRC";
  /** Number of events that happen before the outcome is established. */
  readonly outcomeAfter: number;
  readonly reopenDecision: "none" | "restore" | "correction" | "reopenAccepted";
  readonly closedDecision: "none" | "reopen" | "confirmedNoCode";
  readonly postMergePass: boolean;
}

export function* reconcileRecipes(): Generator<ReconcileRecipe> {
  for (const outcome of ["delivered", "noCode", "pending"] as const)
    for (const events of ["", "C", "CR", "CRC"] as const)
      for (let outcomeAfter = 0; outcomeAfter <= events.length; outcomeAfter++)
        for (const reopenDecision of ["none", "restore", "correction", "reopenAccepted"] as const)
          for (const closedDecision of ["none", "reopen", "confirmedNoCode"] as const)
            for (const postMergePass of [false, true]) yield { outcome, events, outcomeAfter, reopenDecision, closedDecision, postMergePass };
}

export function reconcileGamma(r: ReconcileRecipe, v: Variant): Built {
  const a = new Assembly(v);
  const ctx = `${v.repo.owner}/${v.repo.name}#${v.member}`;
  const events: { id: EventId; kind: "closed" | "reopened"; at: Millis }[] = [];
  let outcomeAt: Millis | null = null;
  const establish = (): void => {
    outcomeAt = a.now();
    if (r.outcome === "delivered") {
      a.prs.push({
        ref: { repo: v.repo, number: v.pr },
        state: { kind: "merged", mergeSha: `m-${v.name}` as Sha, mergedAt: outcomeAt },
        head: `h-${v.name}` as Sha,
        target: { repo: v.repo, base: "main" },
        bodyHash: "pr" as Hash,
        appliedSubmit: null,
        mergeable: "yes",
        checks: { state: "pass", failedRunId: null, latestRunCreatedAt: null },
        closes: [a.m],
        agendaMarker: true,
      });
    }
    if (r.outcome === "noCode") a.decision({ subject: "noCode", member: a.m, bodyHash: `body-${v.name}-${v.member}` as Hash, reason: "satisfied" });
  };
  // each decision follows the event it pins (chronological, as Main answers a decide(...) ticket)
  const lastR = r.events.lastIndexOf("R");
  const lastC = r.events.lastIndexOf("C");
  if (r.reopenDecision !== "none" && lastR < 0) return infeasible("no reopen event to pin");
  if (r.closedDecision !== "none" && lastC < 0) return infeasible("no close event to pin");
  for (let i = 0; i <= r.events.length; i++) {
    if (i === r.outcomeAfter && r.outcome !== "pending") establish();
    const kind = r.events[i];
    if (kind === undefined) continue;
    const e = { id: a.eventId(), kind: kind === "C" ? ("closed" as const) : ("reopened" as const), at: a.now() };
    events.push(e);
    if (i === lastR && r.reopenDecision !== "none") a.decision({ subject: "reopened", member: a.m, event: e.id, verdict: r.reopenDecision });
    if (i === lastC && r.closedDecision !== "none")
      a.decision({ subject: "closed", member: a.m, event: e.id, bodyHash: `body-${v.name}-${v.member}` as Hash, verdict: r.closedDecision });
  }
  const open = events.length === 0 || events.at(-1)?.kind === "reopened";
  a.issues = a.issues.map((i) => (i.ref.number === v.member ? { ...i, open, events } : i));
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
  if (r.postMergePass) {
    const merges: Observed[] = r.outcome === "delivered" ? [{ repo: v.repo, commit: `m-${v.name}` as Sha }] : [];
    const manifest: Manifest = {
      gate: "postMerge",
      merges,
      memberBodyHashes: members.map((m) => a.issues.find((i) => i.ref.number === m.number)?.bodyHash ?? ("" as Hash)),
      contractDecisions: [],
      designCommits: [],
    };
    const vctx = `verify:${ctx}`;
    const obligation = obligationId("postMerge", vctx, manifest, 1);
    a.add({ kind: "verdict", obligation, verdict: { gate: "postMerge", observed: merges, rows: [{ rowId: "r1", command: "c", output: "o", pass: true }, { rowId: "r2", command: "c", output: "o", pass: true }], unrelated: [] } }, { obligation, manifest, key: `${vctx}|${obligation}` });
  }
  void outcomeAt;
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
