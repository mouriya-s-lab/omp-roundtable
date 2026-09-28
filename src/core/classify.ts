// classify: Snapshot + host → finite situations + witnesses (core.md §4).
// This is the only place that looks at concrete facts; every choice among candidates happens here, by record order.

import { canonical, fnv64, issueKey, obligationId, requestName, sameIssue, stripSuffix, type SeatRole } from "./identity.ts";
import type {
  ClaimKind,
  ClosureSituation,
  EffectSituation,
  GateState,
  MemberSituation,
  ReconcileSituation,
  SeatState,
  SubjectSituation,
  VerificationSituation,
} from "./situation.ts";
import type {
  AgentId,
  Anchor,
  BodyReplacement,
  Claim,
  Context,
  Decision,
  DecisionRecordBody,
  DeliveryTarget,
  Draft,
  DraftId,
  EffectFailure,
  Hash,
  Host,
  IssueFact,
  IssueRef,
  Manifest,
  Millis,
  ObligationId,
  Observed,
  PrFact,
  PrRef,
  RecordId,
  RepoRef,
  Route,
  Sha,
  Snapshot,
  StoredRecord,
  Verdict,
} from "./types.ts";

// ---------------------------------------------------------------- agenda view

export interface Entry {
  readonly issue: IssueRef;
  readonly target: DeliveryTarget;
  readonly designOnly: boolean;
  readonly adoptPr: PrRef | null;
}

export interface Unit {
  readonly top: Entry;
  /** Top entry first, then corrections in order. */
  readonly members: readonly Entry[];
}

export type Outcome = { readonly kind: "delivered"; readonly merge: Observed; readonly mergedAt: Millis } | { readonly kind: "noCode" } | { readonly kind: "pending" };

// ---------------------------------------------------------------- witnesses

export type FixTrigger =
  | { readonly kind: "verdict"; readonly id: RecordId }
  | { readonly kind: "implDefect"; readonly id: RecordId }
  | { readonly kind: "fixNeeded"; readonly id: RecordId }
  | { readonly kind: "designFix"; readonly commit: Sha }
  | { readonly kind: "designMerge"; readonly commit: Sha }
  | { readonly kind: "headMoved"; readonly head: Sha }
  | { readonly kind: "conflict"; readonly head: Sha }
  | { readonly kind: "checksFail"; readonly runId: string };

export interface MemberWitness {
  readonly entry: Entry;
  readonly issue: IssueFact | null;
  readonly pr: PrFact | null;
  readonly foreign: readonly PrRef[];
  readonly claim: StoredRecord | null;
  readonly unadjudicated: StoredRecord | null;
  readonly fixTrigger: FixTrigger | null;
  readonly designFixVerdict: StoredRecord | null;
  readonly failedRun: string | null;
  readonly reviewManifest: Manifest | null;
  readonly acceptManifest: Manifest | null;
  readonly attempts: { readonly deliver: number; readonly review: number; readonly accept: number };
  readonly designCommits: readonly Sha[];
  /** Default-branch head of the delivery target (start point for a new branch). */
  readonly startSha: Sha | null;
  /** Contract-changing decisions that apply to this member (records the holder must read). */
  readonly contractDecisions: readonly RecordId[];
  readonly ids: {
    readonly deliver: ObligationId;
    readonly fix: ObligationId | null;
    readonly review: ObligationId | null;
    readonly accept: ObligationId | null;
    readonly merge: ObligationId | null;
    readonly noticeForeignPr: ObligationId | null;
    readonly decideClaim: ObligationId | null;
    readonly decideFindings: ObligationId | null;
    readonly designFix: ObligationId | null;
    readonly decideChecks: ObligationId | null;
  };
  readonly names: { readonly owner: string; readonly review: string | null; readonly accept: string | null };
}

export interface ReconcileWitness {
  readonly member: IssueRef;
  readonly latestReopen: RecordId | null;
  readonly ids: { readonly close: ObligationId; readonly reopen: ObligationId; readonly decideReopened: ObligationId | null; readonly decideClosed: ObligationId | null };
  readonly eventForDecision: string | null;
  readonly bodyHash: Hash | null;
}

export interface VerificationWitness {
  readonly unit: Unit;
  readonly manifest: Manifest;
  readonly attempt: number;
  readonly legacy: boolean;
  readonly claim: StoredRecord | null;
  readonly failing: StoredRecord | null;
  readonly ids: { readonly postMerge: ObligationId; readonly decideClaim: ObligationId | null; readonly decidePostMergeFail: ObligationId | null };
  readonly name: string;
}

export interface ClosureWitness {
  readonly parent: IssueRef | null;
  readonly manifest: Manifest | null;
  readonly attempt: number;
  readonly claim: StoredRecord | null;
  readonly failing: StoredRecord | null;
  readonly ids: {
    readonly closure: ObligationId | null;
    readonly decideClaim: ObligationId | null;
    readonly decideClosureFail: ObligationId | null;
    readonly closeParent: ObligationId;
    readonly reopenParent: ObligationId;
    readonly report: ObligationId;
  };
  readonly name: string | null;
}

export type SubjectWitness =
  | { readonly subject: "unrelated"; readonly verdict: StoredRecord; readonly id: ObligationId }
  | { readonly subject: "orphanDesign"; readonly commit: Sha; readonly key: Hash; readonly id: ObligationId }
  | { readonly subject: "migration"; readonly decision: StoredRecord; readonly migration: IssueRef; readonly key: Hash; readonly id: ObligationId }
  | { readonly subject: "agendaGap"; readonly child: IssueRef; readonly key: Hash; readonly id: ObligationId };

export type EffectTarget =
  | { readonly kind: "closeAgenda" }
  | { readonly kind: "attachAgenda"; readonly parent: IssueRef }
  | { readonly kind: "openPr" | "updatePr"; readonly submit: StoredRecord; readonly pr: PrRef | null }
  | { readonly kind: "applyBody"; readonly decision: RecordId; readonly replacement: BodyReplacement }
  | { readonly kind: "createIssue"; readonly draftId: DraftId; readonly draft: Draft }
  | { readonly kind: "noticeDecision"; readonly decision: RecordId; readonly issue: IssueRef }
  | { readonly kind: "rerunChecks"; readonly decision: RecordId; readonly pr: PrRef };

export interface EffectWitness {
  readonly id: ObligationId;
  readonly target: EffectTarget;
  readonly unit: IssueRef | null;
  /** Obligation pinned (effect id, failure time) for the latest failure (core.md §4 effect failures). */
  readonly failedId: ObligationId | null;
  readonly conflictId: ObligationId;
  /** Key a `Decision(stall)` on the effect-conflict ticket must name; the ticket is pinned to it. */
  readonly conflictKey: Hash;
}

export interface SeatWitness {
  readonly role: SeatRole;
  readonly issue: IssueRef;
  readonly requestName: string;
  readonly holder: AgentId | null;
  readonly pending: AgentId | null;
  readonly wokenCount: number;
  readonly spawnId: ObligationId;
  readonly wakeId: ObligationId | null;
}

export interface PendingAck {
  readonly requestName: string;
  readonly agentId: AgentId;
  readonly previous: AgentId | null;
  readonly issue: IssueRef | null;
  readonly id: ObligationId;
}

export interface Classified {
  readonly units: readonly Unit[];
  readonly currentUnit: Unit | null;
  readonly member: { readonly s: MemberSituation; readonly w: MemberWitness } | null;
  readonly reconcile: readonly { readonly s: ReconcileSituation; readonly w: ReconcileWitness }[];
  readonly verification: { readonly s: VerificationSituation; readonly w: VerificationWitness } | null;
  readonly closure: { readonly s: ClosureSituation; readonly w: ClosureWitness };
  readonly subjects: readonly { readonly s: SubjectSituation; readonly w: SubjectWitness }[];
  readonly effects: readonly { readonly s: EffectSituation; readonly w: EffectWitness }[];
  readonly seats: readonly { readonly state: SeatState; readonly w: SeatWitness }[];
  readonly pendingAcks: readonly PendingAck[];
  readonly stall: { readonly key: Hash; readonly external: boolean; readonly id: ObligationId };
  /** Pin hashed into each obligation id minted by this classification; realize shows it in the brief identity block. */
  readonly pins: ReadonlyMap<ObligationId, unknown>;
}

/** Mints an obligation id and records the pin it hashed (one per classify call). */
type Mint = (kind: string, context: unknown, pin: unknown, attempt: number) => ObligationId;

function minter(pins: Map<ObligationId, unknown>): Mint {
  return (kind, context, pin, attempt) => {
    const id = obligationId(kind, context, pin, attempt);
    pins.set(id, pin);
    return id;
  };
}

// ---------------------------------------------------------------- record access

type DecisionRecord = StoredRecord & { readonly body: DecisionRecordBody };

const isDecision = (r: StoredRecord): r is DecisionRecord => r.body.kind === "decision";

function decisions(snap: Snapshot): DecisionRecord[] {
  return snap.records.filter(isDecision);
}

/** Decision variants whose `subject` union admits `S` (some variants share one subject union). */
type VariantFor<D, S> = D extends { readonly subject: infer X } ? (S extends X ? D : never) : never;
type DecisionFor<S extends Decision["subject"]> = VariantFor<Decision, S>;

function decisionsOf<S extends Decision["subject"]>(snap: Snapshot, subject: S): (DecisionRecord & { body: { decision: DecisionFor<S> } })[] {
  return decisions(snap).filter((r) => r.body.decision.subject === subject) as (DecisionRecord & { body: { decision: DecisionFor<S> } })[];
}

function claimsOf(snap: Snapshot): (StoredRecord & { body: { kind: "claim"; claim: Claim } })[] {
  return snap.records.filter((r) => r.body.kind === "claim") as (StoredRecord & { body: { kind: "claim"; claim: Claim } })[];
}

function verdictsOf(snap: Snapshot): (StoredRecord & { body: { kind: "verdict"; verdict: Verdict } })[] {
  return snap.records.filter((r) => r.body.kind === "verdict") as (StoredRecord & { body: { kind: "verdict"; verdict: Verdict } })[];
}

const issueOf = (snap: Snapshot, ref: IssueRef): IssueFact | null => snap.issues.find((i) => sameIssue(i.ref, ref)) ?? null;

const sameRepo = (a: RepoRef, b: RepoRef): boolean => a.owner === b.owner && a.name === b.name;

const prKey = (p: PrRef): string => `${p.repo.owner}/${p.repo.name}#${p.number}`;

/** PRs given up by a `replacePr` decision (stamped `abandon`). */
function abandonedPrs(snap: Snapshot): Set<string> {
  const out = new Set<string>();
  for (const r of decisionsOf(snap, "blockedClaim")) {
    const d = r.body.decision;
    if (d.subject === "blockedClaim" && d.verdict === "replacePr" && d.abandon !== null) out.add(prKey(d.abandon));
  }
  return out;
}

const onDefault = (snap: Snapshot, repo: RepoRef, sha: Sha): boolean => snap.commits.onDefault.some((c) => sameRepo(c.repo, repo) && c.sha === sha);

const contains = (snap: Snapshot, repo: RepoRef, descendant: Sha, ancestor: Sha): boolean =>
  descendant === ancestor || snap.commits.contains.some((c) => sameRepo(c.repo, repo) && c.ancestor === ancestor && c.descendant === descendant);

// ---------------------------------------------------------------- agenda

function draftEntries(snap: Snapshot): { draftId: DraftId; draft: Draft; decision: RecordId; issue: IssueRef | null }[] {
  const out: { draftId: DraftId; draft: Draft; decision: RecordId; issue: IssueRef | null }[] = [];
  for (const r of decisions(snap)) {
    const fromBody = r.body.drafts;
    const fromFindings =
      r.body.decision.subject === "findings"
        ? r.body.decision.perFinding.flatMap((f) => (f.verdict.kind === "outOfScope" ? [f.verdict.draft] : []))
        : [];
    for (const draft of [...fromBody, ...fromFindings]) {
      const draftId = `${r.id}#${draft.index}` as DraftId;
      const created = snap.issues.find((i) => i.draftMarker === draftId);
      out.push({ draftId, draft, decision: r.id, issue: created?.ref ?? null });
    }
  }
  return out;
}

/** Agenda = immutable convened list + anchored insertions from created drafts (core.md §3). */
export function computeUnits(snap: Snapshot): Unit[] {
  const units: { top: Entry; members: Entry[] }[] = snap.agenda.convened.map((c) => ({
    top: { issue: c.issue, target: c.target, designOnly: c.designOnly, adoptPr: c.adoptPr },
    members: [{ issue: c.issue, target: c.target, designOnly: c.designOnly, adoptPr: c.adoptPr }],
  }));
  const unitIndexOf = (ref: IssueRef): number => units.findIndex((u) => u.members.some((m) => sameIssue(m.issue, ref)));
  for (const d of draftEntries(snap)) {
    if (d.issue === null) continue;
    const entry: Entry = { issue: d.issue, target: d.draft.target, designOnly: d.draft.designOnly, adoptPr: null };
    const anchor: Anchor = d.draft.anchor;
    switch (anchor.kind) {
      case "outsideAgenda":
        break;
      case "correctionOf": {
        const i = unitIndexOf(anchor.entry);
        if (i >= 0) units[i]?.members.push(entry);
        break;
      }
      case "before":
      case "after": {
        const i = unitIndexOf(anchor.entry);
        const at = i < 0 ? units.length : anchor.kind === "before" ? i : i + 1;
        units.splice(at, 0, { top: entry, members: [entry] });
        break;
      }
      default:
        assertNever(anchor);
    }
  }
  return units;
}

/** Issues whose acceptance rows a question in `context` is about: the targets an `acceptanceMethod` body replacement may rewrite. */
export function rowOwners(snap: Snapshot, context: Context): IssueRef[] {
  switch (context.kind) {
    case "member":
      return [context.member];
    case "unitVerification":
      return computeUnits(snap).find((u) => sameIssue(u.top.issue, context.unit))?.members.map((m) => m.issue) ?? [];
    case "agendaClosure":
      return snap.agenda.parent === null ? [] : [snap.agenda.parent];
    default:
      return assertNever(context);
  }
}

// ---------------------------------------------------------------- outcomes and contracts

function mergedPrFor(snap: Snapshot, member: IssueRef): PrFact | null {
  const merged = snap.prs.filter((p) => p.state.kind === "merged" && p.closes.some((c) => sameIssue(c, member)));
  return merged.at(-1) ?? null;
}

function latestNoCode(snap: Snapshot, member: IssueRef): { confirmed: boolean; bodyHash: Hash | null; at: Millis } | null {
  let latest: { confirmed: boolean; bodyHash: Hash | null; at: Millis } | null = null;
  for (const r of decisions(snap)) {
    const d = r.body.decision;
    if (d.subject === "noCodeClaim" && sameIssue(d.member, member)) latest = { confirmed: d.verdict === "confirmed", bodyHash: d.bodyHash, at: r.at };
    if (d.subject === "closed" && sameIssue(d.member, member)) latest = { confirmed: d.verdict === "confirmedNoCode", bodyHash: d.bodyHash, at: r.at };
    if (d.subject === "noCode" && sameIssue(d.member, member)) latest = { confirmed: true, bodyHash: d.bodyHash, at: r.at };
    if (d.subject === "reopened" && sameIssue(d.member, member) && d.verdict === "reopenAccepted") latest = { confirmed: false, bodyHash: null, at: r.at };
  }
  return latest;
}

export function outcomeOf(snap: Snapshot, entry: Entry): Outcome {
  const merged = mergedPrFor(snap, entry.issue);
  if (merged !== null && merged.state.kind === "merged") {
    return { kind: "delivered", merge: { repo: merged.ref.repo, commit: merged.state.mergeSha }, mergedAt: merged.state.mergedAt };
  }
  const issue = issueOf(snap, entry.issue);
  const nc = latestNoCode(snap, entry.issue);
  if (issue !== null && nc !== null && nc.confirmed && nc.bodyHash === issue.bodyHash) return { kind: "noCode" };
  return { kind: "pending" };
}

/** Decisions that change a member's contract: designGap and acceptanceMethod (core.md §3). */
function contractDecisions(snap: Snapshot, member: IssueRef): { ids: RecordId[]; commits: Sha[] } {
  const ids: RecordId[] = [];
  const commits: Sha[] = [];
  for (const r of decisions(snap)) {
    const d = r.body.decision;
    const affectsMember = r.body.bodyReplacements.some((b) => sameIssue(b.issue, member));
    if (d.subject === "question") {
      const relevant = d.affected.some((a) => sameIssue(a, member)) || affectsMember;
      if (relevant && (d.verdict.kind === "designGap" || d.verdict.kind === "acceptanceMethod")) {
        ids.push(r.id);
        if (d.verdict.kind === "designGap") commits.push(d.verdict.route.commit);
      }
    }
    const verdictOwner = d.subject === "findings" ? parseIssueKey(snap.records.find((x) => x.id === d.verdictRecord)?.idempotencyKey ?? "") : null;
    if (d.subject === "findings" && (affectsMember || (verdictOwner !== null && sameIssue(verdictOwner, member)))) {
      for (const f of d.perFinding) {
        if (f.verdict.kind === "designGap" || f.verdict.kind === "acceptanceMethod") {
          ids.push(r.id);
          if (f.verdict.kind === "designGap") commits.push(f.verdict.route.commit);
        }
      }
    }
    if (d.subject === "designFix") commits.push(d.commit);
  }
  return { ids: [...new Set(ids)], commits: [...new Set(commits)] };
}

// ---------------------------------------------------------------- gate verdict evaluation

type VerdictRecord = StoredRecord & { body: { kind: "verdict"; verdict: Verdict } };

function findingsDecision(snap: Snapshot, verdict: RecordId): DecisionRecord | null {
  return decisionsOf(snap, "findings").find((r) => r.body.decision.verdictRecord === verdict) ?? null;
}

/** Findings of a verdict rejected by adjudication (enters later review manifests). */
function rejectedFindings(snap: Snapshot, verdictIds: readonly RecordId[]): string[] {
  const out: string[] = [];
  for (const v of verdictIds) {
    const d = findingsDecision(snap, v);
    if (d === null || d.body.decision.subject !== "findings") continue;
    for (const f of d.body.decision.perFinding) if (f.verdict.kind === "rejected") out.push(`${v}/${f.findingId}`);
  }
  return out;
}

const manifestKey = (m: Manifest): string => canonical(m);

interface GateEval {
  readonly state: GateState;
  readonly latestValid: VerdictRecord | null;
  readonly attempt: number;
}

/**
 * A failing verdict is superseded (a fresh gate attempt is due) when its findings are all rejected/outOfScope,
 * or when the owner has answered its upheld findings with a later PrSubmit on the same pin (evidence-only fix).
 */
function evaluateGate(
  snap: Snapshot,
  candidates: readonly VerdictRecord[],
  currentFor: (v: VerdictRecord | null) => Manifest,
  answeredAfter: (at: Millis) => boolean,
): GateEval {
  const current = currentFor(null);
  const supersededBy = (v: VerdictRecord): boolean => {
    if (!verdictFails(v.body.verdict)) return false;
    const adj = findingsDecision(snap, v.id);
    if (adj === null || adj.body.decision.subject !== "findings") return false;
    const dismissed = adj.body.decision.perFinding.every((f) => f.verdict.kind === "rejected" || f.verdict.kind === "outOfScope");
    return dismissed || answeredAfter(adj.at);
  };
  let superseded = 0;
  let latestValid: VerdictRecord | null = null;
  let anyStale = false;
  for (const v of candidates) {
    if (v.manifest === null) continue;
    if (manifestKey(v.manifest) !== manifestKey(currentFor(v))) {
      anyStale = true;
      continue;
    }
    if (supersededBy(v) && manifestKey(v.manifest) === manifestKey(current)) superseded++;
    latestValid = v;
  }
  const attempt = 1 + superseded;
  if (latestValid === null) return { state: anyStale ? "stale" : "none", latestValid: null, attempt };
  if (!verdictFails(latestValid.body.verdict)) return { state: "validPass", latestValid, attempt };
  const adj = findingsDecision(snap, latestValid.id);
  if (adj === null || adj.body.decision.subject !== "findings") return { state: "validFailUnadjudicated", latestValid, attempt };
  return { state: supersededBy(latestValid) ? "superseded" : "validFailAdjudicated", latestValid, attempt };
}

export function verdictFails(v: Verdict): boolean {
  switch (v.gate) {
    case "review":
      return v.gates.some((g) => g !== "pass");
    case "accept":
    case "postMerge":
    case "closure":
      return v.rows.some((r) => !r.pass) || v.rows.length === 0;
    default:
      return assertNever(v);
  }
}

// ---------------------------------------------------------------- seats

function seatState(host: Host, snap: Snapshot, name: string): { state: SeatState; holder: AgentId | null; pending: AgentId | null; woken: number } {
  const seated = decisionsOf(snap, "seated").filter((r) => r.body.decision.subject === "seated" && r.body.decision.requestName === name);
  const last = seated.at(-1);
  const holderId = last !== undefined && last.body.decision.subject === "seated" ? last.body.decision.agentId : null;
  const acknowledged = new Set(seated.map((r) => (r.body.decision.subject === "seated" ? r.body.decision.agentId : "")));
  const holder = holderId === null ? undefined : host.agents.find((a) => a.id === holderId);
  const pending = host.agents.find((a) => stripSuffix(a.id) === name && a.status !== "aborted" && !acknowledged.has(a.id));
  const woken = holderId === null ? 0 : decisionsOf(snap, "woken").filter((r) => r.body.decision.subject === "woken" && r.body.decision.agentId === holderId).length;
  if (pending !== undefined) return { state: "pendingAck", holder: holderId, pending: pending.id, woken };
  if (holder !== undefined && holder.status === "live") return { state: "live", holder: holderId, pending: null, woken };
  if (holder !== undefined && holder.status === "parked") return { state: "parked", holder: holderId, pending: null, woken };
  return { state: "absent", holder: holderId, pending: null, woken };
}

function seatWitness(mint: Mint, host: Host, snap: Snapshot, role: SeatRole, issue: IssueRef, name: string): { state: SeatState; w: SeatWitness } {
  const st = seatState(host, snap, name);
  return {
    state: st.state,
    w: {
      role,
      issue,
      requestName: name,
      holder: st.holder,
      pending: st.pending,
      wokenCount: st.woken,
      spawnId: mint("spawn", "seat", { requestName: name, previous: st.holder }, 1),
      wakeId: st.holder === null ? null : mint("wake", "seat", { agent: st.holder, count: st.woken }, 1),
    },
  };
}

// ---------------------------------------------------------------- main entry

export function classify(snap: Snapshot, host: Host): Classified {
  const pins = new Map<ObligationId, unknown>();
  const mint = minter(pins);
  const units = computeUnits(snap);
  const effects = classifyEffects(mint, snap, host, units);
  const unitTerminal = (u: Unit): boolean => terminal(mint, snap, u, effects);
  const currentUnit = units.find((u) => !unitTerminal(u)) ?? null;

  let member: Classified["member"] = null;
  let verification: Classified["verification"] = null;
  const reconcile: { s: ReconcileSituation; w: ReconcileWitness }[] = [];
  const seats: { state: SeatState; w: SeatWitness }[] = [];

  if (currentUnit !== null) {
    for (const m of currentUnit.members) reconcile.push(classifyReconcile(mint, snap, currentUnit, m));
    const active = currentUnit.members.find((m) => outcomeOf(snap, m).kind === "pending" && issueOf(snap, m.issue)?.open === true);
    const blockedClosed = currentUnit.members.some((m) => outcomeOf(snap, m).kind === "pending" && issueOf(snap, m.issue)?.open === false);
    if (active !== undefined && !blockedClosed) {
      member = classifyMember(mint, snap, host, active, effects);
      if (!active.designOnly) seats.push(seatWitness(mint, host, snap, "owner", active.issue, member.w.names.owner));
      if (member.w.names.review !== null) seats.push(seatWitness(mint, host, snap, "review", active.issue, member.w.names.review));
      if (member.w.names.accept !== null) seats.push(seatWitness(mint, host, snap, "accept", active.issue, member.w.names.accept));
    } else if (active === undefined && !blockedClosed) {
      verification = classifyVerification(mint, snap, currentUnit);
      seats.push(seatWitness(mint, host, snap, "postMerge", currentUnit.top.issue, verification.w.name));
    }
  }

  const closure = classifyClosure(mint, snap, units, currentUnit === null);
  if (closure.w.name !== null && snap.agenda.parent !== null) seats.push(seatWitness(mint, host, snap, "closure", snap.agenda.parent, closure.w.name));

  const subjects = classifySubjects(mint, snap, units);

  const pendingAcks: PendingAck[] = [];
  const allNames = new Set(seats.map((s) => s.w.requestName));
  for (const a of host.agents) {
    if (a.status === "aborted" || !a.requestName.startsWith("rt-")) continue;
    const name = stripSuffix(a.id);
    const acked = decisionsOf(snap, "seated").some((r) => r.body.decision.subject === "seated" && r.body.decision.agentId === a.id);
    if (acked || allNames.has(name)) continue;
    const prev = decisionsOf(snap, "seated").filter((r) => r.body.decision.subject === "seated" && r.body.decision.requestName === name).at(-1);
    const previous = prev !== undefined && prev.body.decision.subject === "seated" ? prev.body.decision.agentId : null;
    pendingAcks.push({ requestName: name, agentId: a.id, previous, issue: null, id: mint("spawn", "seat", { requestName: name, previous }, 1) });
  }

  const stallKey = fnv64(
    canonical({
      unit: currentUnit === null ? null : issueKey(currentUnit.top.issue),
      member: member === null ? null : (member.s),
      verification: verification === null ? null : (verification.s),
      closure: closure.s,
    }),
  );
  const stallDecided = decisionsOf(snap, "stall").some(
    (r) => r.body.decision.subject === "stall" && r.body.decision.key === stallKey && r.body.decision.verdict === "external",
  );

  return {
    units,
    currentUnit,
    member,
    reconcile,
    verification,
    closure,
    subjects,
    effects,
    seats,
    pendingAcks,
    stall: { key: stallKey, external: stallDecided, id: mint("decideStall", "agenda", stallKey, 1) },
    pins,
  };
}

// ---------------------------------------------------------------- terminality

function terminal(mint: Mint, snap: Snapshot, unit: Unit, effects: readonly { s: EffectSituation; w: EffectWitness }[]): boolean {
  const outcomes = unit.members.map((m) => outcomeOf(snap, m));
  if (outcomes.some((o) => o.kind === "pending")) return false;
  for (const m of unit.members) {
    const r = classifyReconcile(mint, snap, unit, m).s;
    if (r.open && (r.neverClosedSinceOutcome || r.reopenUndecided || r.reopenDecision !== "none")) return false;
  }
  const unitEffectsPending = effects.some(
    (e) => !e.s.fulfilled && e.w.unit !== null && sameIssue(e.w.unit, unit.top.issue) && (e.w.target.kind === "applyBody" || e.w.target.kind === "createIssue"),
  );
  if (unitEffectsPending) return false;
  if (outcomes.every((o) => o.kind === "noCode")) return true;
  const v = classifyVerification(mint, snap, unit);
  return v.s.postMerge === "validPass";
}

// ---------------------------------------------------------------- reconcile

function classifyReconcile(mint: Mint, snap: Snapshot, unit: Unit, entry: Entry): { s: ReconcileSituation; w: ReconcileWitness } {
  const issue = issueOf(snap, entry.issue);
  const outcome = outcomeOf(snap, entry);
  const events = issue?.events ?? [];
  const outcomeAt: Millis | null = outcome.kind === "delivered" ? outcome.mergedAt : outcome.kind === "noCode" ? (latestNoCode(snap, entry.issue)?.at ?? null) : null;
  const afterOutcome = events.filter((e) => outcomeAt === null || e.at >= outcomeAt);
  const lastReopen = [...afterOutcome].reverse().find((e) => e.kind === "reopened") ?? null;
  const lastClose = [...events].reverse().find((e) => e.kind === "closed") ?? null;
  const reopenDecisionRec =
    lastReopen === null
      ? undefined
      : decisionsOf(snap, "reopened").filter((r) => r.body.decision.subject === "reopened" && r.body.decision.event === lastReopen.id).at(-1);
  const closedDecisionRec =
    lastClose === null || issue === null
      ? undefined
      : decisionsOf(snap, "closed")
          .filter((r) => r.body.decision.subject === "closed" && r.body.decision.event === lastClose.id && r.body.decision.bodyHash === issue.bodyHash)
          .at(-1);
  const closedByMerge = outcome.kind === "delivered";
  const unitPostMergePass = classifyVerification(mint, snap, unit).s.postMerge === "validPass";
  const s: ReconcileSituation = {
    outcome: outcome.kind,
    open: issue?.open ?? false,
    neverClosedSinceOutcome: afterOutcome.every((e) => e.kind !== "closed"),
    reopenUndecided: lastReopen !== null && reopenDecisionRec === undefined,
    reopenDecision:
      reopenDecisionRec !== undefined && reopenDecisionRec.body.decision.subject === "reopened" ? reopenDecisionRec.body.decision.verdict : "none",
    closedUndecided: issue !== null && !issue.open && !closedByMerge && closedDecisionRec === undefined,
    closedDecision:
      closedDecisionRec !== undefined && closedDecisionRec.body.decision.subject === "closed" ? closedDecisionRec.body.decision.verdict : "none",
    unitPostMergePass,
  };
  const ctx = issueKey(entry.issue);
  return {
    s,
    w: {
      member: entry.issue,
      latestReopen: reopenDecisionRec?.id ?? null,
      eventForDecision: s.open ? (lastReopen?.id ?? null) : (lastClose?.id ?? null),
      bodyHash: issue?.bodyHash ?? null,
      ids: {
        close: mint("close", ctx, { reopen: lastReopen?.id ?? null, decision: reopenDecisionRec?.id ?? null }, 1),
        reopen: mint("reopen", ctx, { close: lastClose?.id ?? null, decision: closedDecisionRec?.id ?? null }, 1),
        decideReopened: lastReopen === null ? null : mint("decideReopened", ctx, lastReopen.id, 1),
        decideClosed: lastClose === null || issue === null ? null : mint("decideClosed", ctx, { event: lastClose.id, body: issue.bodyHash }, 1),
      },
    },
  };
}

// ---------------------------------------------------------------- member

function classifyMember(
  mint: Mint,
  snap: Snapshot,
  host: Host,
  entry: Entry,
  effects: readonly { s: EffectSituation; w: EffectWitness }[],
): { s: MemberSituation; w: MemberWitness } {
  void host;
  const ref = entry.issue;
  const ctx = issueKey(ref);
  const issue = issueOf(snap, ref);
  const bodyHash = issue?.bodyHash ?? ("" as Hash);

  // claims raised in this member context, earliest undecided first
  const decidedClaims = new Set<RecordId>();
  for (const r of decisions(snap)) {
    const d = r.body.decision;
    if (d.subject === "question" || d.subject === "noCodeClaim" || d.subject === "splitClaim" || d.subject === "blockedClaim") decidedClaims.add(d.claim);
  }
  const memberClaims = claimsOf(snap).filter((r) => claimTargetsMember(r.body.claim, ref));
  const claim = memberClaims.find((r) => !decidedClaims.has(r.id)) ?? null;

  // PRs
  const abandoned = abandonedPrs(snap);
  const closingOnlyM = snap.prs.filter((p) => p.closes.length === 1 && p.closes.some((c) => sameIssue(c, ref)));
  const maintainable = closingOnlyM.find(
    (p) =>
      p.state.kind === "open" &&
      p.target.base === entry.target.base &&
      sameRepo(p.target.repo, entry.target.repo) &&
      (p.agendaMarker || (entry.adoptPr !== null && prKey(entry.adoptPr) === prKey(p.ref))) &&
      !abandoned.has(prKey(p.ref)),
  );
  const foreign = snap.prs.filter((p) => p.state.kind === "open" && p.closes.some((c) => sameIssue(c, ref)) && p !== maintainable).map((p) => p.ref);
  const ourAbandoned = snap.prs.filter(
    (p) => p.agendaMarker && p.closes.some((c) => sameIssue(c, ref)) && (p.state.kind === "closedUnmerged" || abandoned.has(prKey(p.ref))),
  ).length;

  const submits = snap.records.filter((r) => r.body.kind === "prSubmit" && sameIssue(r.body.member, ref));
  const latestSubmit = submits.at(-1) ?? null;
  const contract = contractDecisions(snap, ref);
  const designCommits = contract.commits;

  const deliverAttempt = 1 + ourAbandoned;
  const deliverId = mint("deliver", ctx, { body: null }, deliverAttempt);

  // materialization: PR carries the latest submit; contract effects for this member applied
  const memberEffectsPending = effects.some(
    (e) =>
      !e.s.fulfilled &&
      ((e.w.target.kind === "openPr" || e.w.target.kind === "updatePr") && sameIssue(e.w.target.submit.body.kind === "prSubmit" ? e.w.target.submit.body.member : ref, ref)
        ? true
        : e.w.target.kind === "applyBody"
          ? sameIssue(e.w.target.replacement.issue, ref)
          : e.w.target.kind === "createIssue"
            ? e.w.unit !== null && sameIssue(e.w.unit, ref)
            : false),
  );

  const pr = maintainable ?? null;
  let reviewManifest: Manifest | null = null;
  let acceptManifest: Manifest | null = null;
  let review: GateEval = { state: "none", latestValid: null, attempt: 1 };
  let accept: GateEval = { state: "none", latestValid: null, attempt: 1 };
  if (pr !== null) {
    const verdicts = verdictsOf(snap).filter((v) => v.manifest !== null && ("head" in v.manifest) && v.body.verdict.gate !== "postMerge" && v.body.verdict.gate !== "closure" && verdictForMember(v, ref, snap));
    const reviewVerdicts = verdicts.filter((v) => v.body.verdict.gate === "review");
    const acceptVerdicts = verdicts.filter((v) => v.body.verdict.gate === "accept");
    const reviewFor = (exclude: VerdictRecord | null): Manifest => ({
      gate: "review",
      head: pr.head,
      target: pr.target,
      prBodyHash: pr.bodyHash,
      memberBodyHash: bodyHash,
      contractDecisions: contract.ids,
      designCommits,
      rejectedFindings: rejectedFindings(
        snap,
        reviewVerdicts.filter((v) => v !== exclude).map((v) => v.id),
      ),
    });
    const acceptFor = (): Manifest => ({
      gate: "accept",
      head: pr.head,
      target: pr.target,
      memberBodyHash: bodyHash,
      contractDecisions: contract.ids,
      designCommits,
    });
    reviewManifest = reviewFor(null);
    acceptManifest = acceptFor();
    const answeredAfter = (at: Millis): boolean => submits.some((s) => s.at > at);
    review = evaluateGate(snap, reviewVerdicts, reviewFor, answeredAfter);
    accept = evaluateGate(snap, acceptVerdicts, () => acceptFor(), answeredAfter);
  }

  // repairs (only while the verdict that produced them is valid)
  const upheld = (v: VerdictRecord | null, who: "owner" | "main"): boolean => {
    if (v === null) return false;
    const d = findingsDecision(snap, v.id);
    return d !== null && d.body.decision.subject === "findings" && d.body.decision.perFinding.some((f) => f.verdict.kind === "upheld" && f.verdict.responsible === who);
  };
  const reviewValid = review.state === "validFailAdjudicated" ? review.latestValid : null;
  const acceptValid = accept.state === "validFailAdjudicated" ? accept.latestValid : null;
  const submitAfter = (at: Millis): boolean => submits.some((s) => s.at > at);
  const implDefect = decisionsOf(snap, "question")
    .filter((r) => r.body.decision.subject === "question" && r.body.decision.verdict.kind === "implDefect" && claimIsForMember(snap, r.body.decision.claim, ref))
    .find((r) => !submitAfter(r.at));
  const failedRun = pr !== null && pr.checks.state === "fail" ? pr.checks.failedRunId : null;
  const checksDecisionRec =
    failedRun === null
      ? undefined
      : decisionsOf(snap, "checks").filter((r) => r.body.decision.subject === "checks" && r.body.decision.runId === failedRun).at(-1);
  const checksDecided = checksDecisionRec !== undefined && checksDecisionRec.body.decision.subject === "checks" ? checksDecisionRec.body.decision.verdict : "none";
  const fixNeeded = checksDecided === "fixNeeded" && checksDecisionRec !== undefined && !submitAfter(checksDecisionRec.at) ? checksDecisionRec : undefined;
  const designFixRec = [reviewValid, acceptValid]
    .filter((v): v is VerdictRecord => v !== null && upheld(v, "main"))
    .map((v) => decisionsOf(snap, "designFix").find((d) => d.body.decision.subject === "designFix" && d.body.decision.verdictRecord === v.id))
    .find((d) => d !== undefined);
  const designFixUnmerged =
    designFixRec !== undefined && designFixRec.body.decision.subject === "designFix" && pr !== null && !contains(snap, pr.target.repo, pr.head, designFixRec.body.decision.commit)
      ? designFixRec.body.decision.commit
      : null;
  const latestHead = latestSubmit !== null && latestSubmit.body.kind === "prSubmit" ? latestSubmit.body.head : null;
  const headMoved = pr !== null && latestHead !== null && latestHead !== pr.head;
  const requiredDesign = requiredDesignCommits(snap, ref);
  const designMissing = pr === null ? null : (requiredDesign.find((d) => !contains(snap, pr.target.repo, pr.head, d)) ?? null);

  const ownerVerdict = [reviewValid, acceptValid].find((v) => v !== null && upheld(v, "owner")) ?? null;
  const mainVerdict = [reviewValid, acceptValid].find((v) => v !== null && upheld(v, "main") && designFixRec === undefined) ?? null;

  const fixTrigger: FixTrigger | null =
    pr === null
      ? null
      : headMoved
        ? { kind: "headMoved", head: pr.head }
        : ownerVerdict !== null
          ? { kind: "verdict", id: ownerVerdict.id }
          : implDefect !== undefined
            ? { kind: "implDefect", id: implDefect.id }
            : fixNeeded !== undefined
              ? { kind: "fixNeeded", id: fixNeeded.id }
              : designFixUnmerged !== null
                ? { kind: "designFix", commit: designFixUnmerged }
                : designMissing !== null
                  ? { kind: "designMerge", commit: designMissing }
                  : pr.mergeable === "no"
                    ? { kind: "conflict", head: pr.head }
                    : failedRun !== null
                      ? { kind: "checksFail", runId: failedRun }
                      : null;
  const fixId = fixTrigger === null ? null : mint("fix", ctx, fixTrigger, 1);
  const completed = (id: ObligationId | null): boolean => id !== null && snap.records.some((r) => r.obligation === id);
  const checksRunFixed = failedRun !== null && completed(mint("fix", ctx, { kind: "checksFail", runId: failedRun }, 1));

  const externalBlock =
    checksDecided === "external" ||
    decisionsOf(snap, "blockedClaim").some((r) => r.body.decision.subject === "blockedClaim" && r.body.decision.verdict === "external" && claimIsForMember(snap, r.body.decision.claim, ref));

  const reviewPinHash = reviewManifest === null ? null : fnv64(manifestKey(reviewManifest));
  const acceptPinHash = acceptManifest === null ? null : fnv64(manifestKey(acceptManifest));
  const reviewId = reviewManifest === null ? null : mint("review", ctx, reviewManifest, review.attempt);
  const acceptId = acceptManifest === null ? null : mint("accept", ctx, acceptManifest, accept.attempt);

  const s: MemberSituation = {
    designOnly: entry.designOnly,
    claim: claim === null ? "none" : claim.body.claim.kind,
    ours: pr === null ? "none" : "maintainable",
    foreign: foreign.length > 0,
    foreignNoticed: pr !== null && snap.effectMarkers.includes(mint("noticeForeignPr", ctx, prKey(pr.ref), 1)),
    materialized: memberEffectsPending || headMoved || (latestSubmit !== null && (pr === null ? true : pr.appliedSubmit !== latestSubmit.id)) ? "pending" : "settled",
    review: review.state,
    accept: accept.state,
    repairOwner: headMoved || ownerVerdict !== null || implDefect !== undefined || fixNeeded !== undefined || designFixUnmerged !== null || designMissing !== null,
    repairMain: mainVerdict !== null,
    mergeable: pr?.mergeable ?? "unknown",
    checks: pr?.checks.state ?? "unknown",
    checksRunFixed,
    checksDecided,
    deliverDone: completed(deliverId),
    fixDone: completed(fixId),
    externalBlock,
  };

  return {
    s,
    w: {
      entry,
      issue,
      pr,
      foreign,
      claim,
      unadjudicated: review.state === "validFailUnadjudicated" ? review.latestValid : accept.state === "validFailUnadjudicated" ? accept.latestValid : null,
      fixTrigger,
      designFixVerdict: mainVerdict,
      failedRun,
      reviewManifest,
      acceptManifest,
      attempts: { deliver: deliverAttempt, review: review.attempt, accept: accept.attempt },
      designCommits: requiredDesign,
      startSha: snap.commits.defaultHead.find((h) => sameRepo(h.repo, entry.target.repo))?.sha ?? null,
      contractDecisions: contract.ids,
      ids: {
        deliver: deliverId,
        fix: fixId,
        review: reviewId,
        accept: acceptId,
        merge: pr === null ? null : mint("merge", ctx, { pr: prKey(pr.ref), head: pr.head }, 1),
        noticeForeignPr: pr === null ? null : mint("noticeForeignPr", ctx, prKey(pr.ref), 1),
        decideClaim: claim === null ? null : mint("decideClaim", ctx, claim.id, 1),
        decideFindings:
          review.state === "validFailUnadjudicated" && review.latestValid !== null
            ? mint("decideFindings", ctx, review.latestValid.id, 1)
            : accept.state === "validFailUnadjudicated" && accept.latestValid !== null
              ? mint("decideFindings", ctx, accept.latestValid.id, 1)
              : null,
        designFix: mainVerdict === null ? null : mint("designFix", ctx, mainVerdict.id, 1),
        decideChecks: failedRun === null ? null : mint("decideChecks", ctx, failedRun, 1),
      },
      names: {
        owner: requestName("owner", ref, null, 1),
        review: reviewPinHash === null ? null : requestName("review", ref, reviewPinHash, review.attempt),
        accept: acceptPinHash === null ? null : requestName("accept", ref, acceptPinHash, accept.attempt),
      },
    },
  };
}

function claimTargetsMember(c: Claim, ref: IssueRef): boolean {
  switch (c.kind) {
    case "question":
      return c.context.kind === "member" && sameIssue(c.context.member, ref);
    case "noCode":
    case "split":
    case "blocked":
      return sameIssue(c.member, ref);
    default:
      return assertNever(c);
  }
}

function claimIsForMember(snap: Snapshot, claimId: RecordId, ref: IssueRef): boolean {
  const r = snap.records.find((x) => x.id === claimId);
  return r !== undefined && r.body.kind === "claim" && claimTargetsMember(r.body.claim, ref);
}

function verdictForMember(v: VerdictRecord, ref: IssueRef, snap: Snapshot): boolean {
  const ctx = issueKey(ref);
  void snap;
  return v.obligation !== null && v.idempotencyKey.startsWith(`${ctx}|`);
}

// ---------------------------------------------------------------- verification

function unitManifest(snap: Snapshot, unit: Unit): { manifest: Manifest; legacy: boolean } {
  const merges: Observed[] = [];
  let latestAt = -1;
  let latestMarker = false;
  for (const m of unit.members) {
    const pr = mergedPrFor(snap, m.issue);
    if (pr !== null && pr.state.kind === "merged") {
      merges.push({ repo: pr.ref.repo, commit: pr.state.mergeSha });
      if (pr.state.mergedAt > latestAt) {
        latestAt = pr.state.mergedAt;
        latestMarker = pr.agendaMarker;
      }
    }
  }
  void latestMarker;
  const ids: RecordId[] = [];
  const commits: Sha[] = [];
  for (const m of unit.members) {
    const c = contractDecisions(snap, m.issue);
    ids.push(...c.ids);
    commits.push(...c.commits);
  }
  return {
    manifest: {
      gate: "postMerge",
      merges,
      memberBodyHashes: unit.members.map((m) => issueOf(snap, m.issue)?.bodyHash ?? ("" as Hash)),
      contractDecisions: [...new Set(ids)],
      designCommits: [...new Set(commits)],
    },
    legacy: latestAt >= 0 && latestAt < snap.agenda.createdAt,
  };
}

function reverifyCount(snap: Snapshot, verdicts: readonly VerdictRecord[], subject: "postMergeFail" | "closureFail", manifest: Manifest): number {
  let n = 0;
  for (const v of verdicts) {
    if (v.manifest === null || manifestKey(v.manifest) !== manifestKey(manifest)) continue;
    const d = decisionsOf(snap, subject).find((r) => (r.body.decision.subject === subject ? r.body.decision.verdictRecord === v.id : false));
    if (d !== undefined && (d.body.decision.subject === "postMergeFail" || d.body.decision.subject === "closureFail") && d.body.decision.verdict === "reverify") n++;
  }
  return n;
}

function classifyVerification(mint: Mint, snap: Snapshot, unit: Unit): { s: VerificationSituation; w: VerificationWitness } {
  const ctx = `verify:${issueKey(unit.top.issue)}`;
  const { manifest, legacy } = unitManifest(snap, unit);
  const verdicts = verdictsOf(snap).filter((v) => v.body.verdict.gate === "postMerge" && v.idempotencyKey.startsWith(`${ctx}|`));
  const attempt = 1 + reverifyCount(snap, verdicts, "postMergeFail", manifest);
  const valid = verdicts.filter((v) => v.manifest !== null && manifestKey(v.manifest) === manifestKey(manifest));
  const id = mint("postMerge", ctx, manifest, attempt);
  const current = valid.filter((v) => v.obligation === id).at(-1) ?? null;
  const failDecisionRec =
    current === null ? undefined : decisionsOf(snap, "postMergeFail").find((r) => r.body.decision.subject === "postMergeFail" && r.body.decision.verdictRecord === current.id);
  const state: GateState =
    current === null
      ? verdicts.length > 0 && valid.length === 0
        ? "stale"
        : "none"
      : verdictFails(current.body.verdict)
        ? "validFailUnadjudicated"
        : "validPass";
  const claim =
    claimsOf(snap).find(
      (r) =>
        r.body.claim.kind === "question" &&
        r.body.claim.context.kind === "unitVerification" &&
        sameIssue(r.body.claim.context.unit, unit.top.issue) &&
        !decisions(snap).some((d) => d.body.decision.subject === "question" && d.body.decision.claim === r.id),
    ) ?? null;
  const anyDelivered = unit.members.some((m) => outcomeOf(snap, m).kind === "delivered");
  return {
    s: {
      anyDelivered,
      claim: claim === null ? "none" : claim.body.claim.kind,
      postMerge: state,
      failDecision:
        failDecisionRec !== undefined && failDecisionRec.body.decision.subject === "postMergeFail" ? failDecisionRec.body.decision.verdict : "none",
    },
    w: {
      unit,
      manifest,
      attempt,
      legacy,
      claim,
      failing: state === "validFailUnadjudicated" ? current : null,
      ids: {
        postMerge: id,
        decideClaim: claim === null ? null : mint("decideClaim", ctx, claim.id, 1),
        decidePostMergeFail: current === null ? null : mint("decidePostMergeFail", ctx, current.id, 1),
      },
      name: requestName("postMerge", unit.top.issue, fnv64(manifestKey(manifest)), attempt),
    },
  };
}

// ---------------------------------------------------------------- closure

function classifyClosure(mint: Mint, snap: Snapshot, units: readonly Unit[], allTerminal: boolean): { s: ClosureSituation; w: ClosureWitness } {
  const ctx = "closure";
  const parentRef = snap.agenda.parent;
  const parent = parentRef === null ? null : issueOf(snap, parentRef);
  const stranded = strandedDesignCommits(snap, units);
  const reported = decisionsOf(snap, "report").length > 0;
  const reportId = mint("report", ctx, null, 1);
  const closeParent = mint("closeParent", ctx, null, 1);
  const reopenParent = mint("reopenParent", ctx, null, 1);
  if (parentRef === null || parent === null) {
    return {
      s: { allUnitsTerminal: allTerminal, strandedDesign: stranded.length > 0, parent: "none", claim: "none", closure: "none", failDecision: "none", reported },
      w: {
        parent: null,
        manifest: null,
        attempt: 1,
        claim: null,
        failing: null,
        ids: { closure: null, decideClaim: null, decideClosureFail: null, closeParent, reopenParent, report: reportId },
        name: null,
      },
    };
  }
  const merges: Observed[] = [];
  for (const u of units)
    for (const m of u.members) {
      const pr = mergedPrFor(snap, m.issue);
      if (pr !== null && pr.state.kind === "merged") merges.push({ repo: pr.ref.repo, commit: pr.state.mergeSha });
    }
  const children = parent.children
    .filter((c) => issueOf(snap, c)?.isAgendaRecord !== true)
    .map((c) => ({ issue: c, terminal: childTerminal(snap, c) }))
    .filter((c): c is { issue: IssueRef; terminal: "merged" | "noCode" } => c.terminal !== null);
  const manifest: Manifest = { gate: "closure", merges, parentBodyHash: parent.bodyHash, children, strandedDesign: stranded };
  const verdicts = verdictsOf(snap).filter((v) => v.body.verdict.gate === "closure");
  const attempt = 1 + reverifyCount(snap, verdicts, "closureFail", manifest);
  const id = mint("closure", ctx, manifest, attempt);
  const current = verdicts.filter((v) => v.obligation === id).at(-1) ?? null;
  const failDecisionRec =
    current === null ? undefined : decisionsOf(snap, "closureFail").find((r) => r.body.decision.subject === "closureFail" && r.body.decision.verdictRecord === current.id);
  const state: GateState = current === null ? (verdicts.length > 0 ? "stale" : "none") : verdictFails(current.body.verdict) ? "validFailUnadjudicated" : "validPass";
  const claim =
    claimsOf(snap).find(
      (r) =>
        r.body.claim.kind === "question" &&
        r.body.claim.context.kind === "agendaClosure" &&
        !decisions(snap).some((d) => d.body.decision.subject === "question" && d.body.decision.claim === r.id),
    ) ?? null;
  return {
    s: {
      allUnitsTerminal: allTerminal,
      strandedDesign: stranded.length > 0,
      parent: parent.open ? "open" : "closed",
      claim: claim === null ? "none" : claim.body.claim.kind,
      closure: state,
      failDecision: failDecisionRec !== undefined && failDecisionRec.body.decision.subject === "closureFail" ? failDecisionRec.body.decision.verdict : "none",
      reported,
    },
    w: {
      parent: parentRef,
      manifest,
      attempt,
      claim,
      failing: state === "validFailUnadjudicated" ? current : null,
      ids: {
        closure: id,
        decideClaim: claim === null ? null : mint("decideClaim", ctx, claim.id, 1),
        decideClosureFail: current === null ? null : mint("decideClosureFail", ctx, current.id, 1),
        closeParent,
        reopenParent,
        report: reportId,
      },
      name: requestName("closure", parentRef, fnv64(manifestKey(manifest)), attempt),
    },
  };
}

function childTerminal(snap: Snapshot, child: IssueRef): "merged" | "noCode" | null {
  if (mergedPrFor(snap, child) !== null) return "merged";
  const issue = issueOf(snap, child);
  const nc = latestNoCode(snap, child);
  if (issue !== null && nc !== null && nc.confirmed && nc.bodyHash === issue.bodyHash) return "noCode";
  return null;
}

// ---------------------------------------------------------------- design commits and subjects

interface DesignRoute {
  readonly decision: DecisionRecord;
  readonly route: Route;
  /** Member whose PR must carry the commit: the asking member for withPr, the named carrier for future. */
  readonly carrier: IssueRef | null;
}

function parseIssueKey(key: string): IssueRef | null {
  const m = /^([^/|]+)\/([^#|]+)#(\d+)\|/.exec(key);
  return m === null ? null : { repo: { owner: m[1] ?? "", name: m[2] ?? "" }, number: Number(m[3]) };
}

function designRoutes(snap: Snapshot): DesignRoute[] {
  const out: DesignRoute[] = [];
  const claimMember = (claimId: RecordId): IssueRef | null => {
    const r = snap.records.find((x) => x.id === claimId);
    if (r === undefined || r.body.kind !== "claim") return null;
    const c = r.body.claim;
    return c.kind === "question" ? (c.context.kind === "member" ? c.context.member : null) : c.member;
  };
  for (const r of decisions(snap)) {
    const d = r.body.decision;
    if (d.subject === "question" && d.verdict.kind === "designGap") {
      const route = d.verdict.route;
      const carrier = route.kind === "future" ? route.carrier : route.kind === "withPr" ? (claimMember(d.claim) ?? d.affected[0] ?? null) : null;
      out.push({ decision: r, route, carrier });
    }
    if (d.subject === "findings") {
      const verdict = snap.records.find((x) => x.id === d.verdictRecord);
      const verdictMember = verdict === undefined ? null : parseIssueKey(verdict.idempotencyKey);
      for (const f of d.perFinding) {
        if (f.verdict.kind !== "designGap") continue;
        const route = f.verdict.route;
        out.push({ decision: r, route, carrier: route.kind === "future" ? route.carrier : route.kind === "withPr" ? verdictMember : null });
      }
    }
  }
  return out;
}

/**
 * Design commits a member's PR must contain and that are not yet on the default branch:
 * withPr / future routes it carries, and designFix commits for findings on its own verdicts.
 */
function requiredDesignCommits(snap: Snapshot, member: IssueRef): Sha[] {
  const routed = designRoutes(snap)
    .filter((d) => d.carrier !== null && sameIssue(d.carrier, member))
    .map((d) => d.route.commit);
  const fixes = decisionsOf(snap, "designFix").flatMap((r) => {
    const d = r.body.decision;
    if (d.subject !== "designFix") return [];
    const owner = parseIssueKey(snap.records.find((x) => x.id === d.verdictRecord)?.idempotencyKey ?? "");
    return owner !== null && sameIssue(owner, member) ? [d.commit] : [];
  });
  return [...new Set([...routed, ...fixes])].filter((c) => !onDefault(snap, member.repo, c));
}

function strandedDesignCommits(snap: Snapshot, units: readonly Unit[]): Sha[] {
  const out: Sha[] = [];
  for (const { route } of designRoutes(snap)) {
    const repo = route.kind === "future" ? route.carrier.repo : units[0]?.top.target.repo;
    if (repo === undefined || onDefault(snap, repo, route.commit)) continue;
    const carried = snap.prs.some((p) => p.state.kind === "open" && contains(snap, p.target.repo, p.head, route.commit));
    if (!carried) out.push(route.commit);
  }
  return out;
}

function classifySubjects(mint: Mint, snap: Snapshot, units: readonly Unit[]): { s: SubjectSituation; w: SubjectWitness }[] {
  const out: { s: SubjectSituation; w: SubjectWitness }[] = [];
  const keyed = (subject: "orphanDesign" | "migration" | "agendaGap", key: Hash): SubjectSituation => {
    const d = decisionsOf(snap, subject).filter((r) => (r.body.decision.subject === subject ? r.body.decision.key === key : false)).at(-1);
    return { decided: d === undefined || d.body.decision.subject !== subject ? "none" : d.body.decision.verdict };
  };
  for (const v of verdictsOf(snap)) {
    const unrelated = v.body.verdict.gate === "accept" || v.body.verdict.gate === "postMerge" ? v.body.verdict.unrelated : [];
    if (unrelated.length === 0) continue;
    const decided = decisionsOf(snap, "unrelated").some((r) => r.body.decision.subject === "unrelated" && r.body.decision.verdictRecord === v.id);
    out.push({ s: { decided: decided ? "resolved" : "none" }, w: { subject: "unrelated", verdict: v, id: mint("decideUnrelated", "agenda", v.id, 1) } });
  }
  const carrierGone = (carrier: IssueRef | null): boolean => {
    if (carrier === null) return true;
    const entry = units.flatMap((u) => u.members).find((m) => sameIssue(m.issue, carrier));
    return entry === undefined || outcomeOf(snap, entry).kind !== "pending";
  };
  const strandedSet = new Set(strandedDesignCommits(snap, units));
  for (const { route, carrier } of designRoutes(snap)) {
    if (!strandedSet.has(route.commit) || !carrierGone(carrier)) continue;
    const key = fnv64(route.commit);
    out.push({ s: keyed("orphanDesign", key), w: { subject: "orphanDesign", commit: route.commit, key, id: mint("decideOrphanDesign", "agenda", key, 1) } });
  }
  for (const { decision, route } of designRoutes(snap)) {
    if (route.kind !== "defaultFirst" || route.migration === null) continue;
    const entry = units.flatMap((u) => u.members).find((m) => route.migration !== null && sameIssue(m.issue, route.migration));
    const issue = issueOf(snap, route.migration);
    const failed = issue !== null && !issue.open && (entry === undefined || outcomeOf(snap, entry).kind !== "delivered");
    if (!failed) continue;
    const key = fnv64(`${decision.id}`);
    out.push({ s: keyed("migration", key), w: { subject: "migration", decision, migration: route.migration, key, id: mint("decideMigration", "agenda", key, 1) } });
  }
  const parent = snap.agenda.parent === null ? null : issueOf(snap, snap.agenda.parent);
  if (parent !== null) {
    const inAgenda = (c: IssueRef): boolean => units.some((u) => u.members.some((m) => sameIssue(m.issue, c)));
    for (const child of parent.children) {
      if (issueOf(snap, child)?.isAgendaRecord === true || inAgenda(child) || childTerminal(snap, child) !== null) continue;
      const key = fnv64(issueKey(child));
      out.push({ s: keyed("agendaGap", key), w: { subject: "agendaGap", child, key, id: mint("decideAgendaGap", "agenda", key, 1) } });
    }
  }
  return out;
}

// ---------------------------------------------------------------- effects (agenda-wide)

function classifyEffects(mint: Mint, snap: Snapshot, host: Host, units: readonly Unit[]): { s: EffectSituation; w: EffectWitness }[] {
  const out: { s: EffectSituation; w: EffectWitness }[] = [];
  const unitOf = (ref: IssueRef): IssueRef | null => units.find((u) => u.members.some((m) => sameIssue(m.issue, ref)))?.top.issue ?? null;
  const push = (id: ObligationId, target: EffectTarget, unit: IssueRef | null, fulfilled: boolean, conflict = false): void => {
    const latest = host.failures.filter((f) => f.effect === id).at(-1);
    out.push({
      s: { fulfilled, failure: failureState(snap, id, latest?.at ?? null), conflict },
      w: {
        id,
        target,
        unit,
        failedId: latest === undefined ? null : mint("decideEffectFailed", "agenda", { effect: id, failedAt: latest.at }, 1),
        conflictKey: fnv64(id),
        conflictId: mint("decideEffectConflict", "agenda", fnv64(id), 1),
      },
    });
  };

  const agendaIssue = issueOf(snap, snap.agenda.record);
  push(mint("closeAgenda", "agenda", null, 1), { kind: "closeAgenda" }, null, agendaIssue !== null && !agendaIssue.open);
  if (snap.agenda.parent !== null) {
    const parent = issueOf(snap, snap.agenda.parent);
    const attached = parent !== null && parent.children.some((c) => sameIssue(c, snap.agenda.record));
    push(mint("attachAgenda", "agenda", null, 1), { kind: "attachAgenda", parent: snap.agenda.parent }, null, attached);
  }

  // PR materialization: only the latest PrSubmit per member applies
  const latestSubmit = new Map<string, StoredRecord>();
  for (const r of snap.records) if (r.body.kind === "prSubmit") latestSubmit.set(issueKey(r.body.member), r);
  for (const r of latestSubmit.values()) {
    if (r.body.kind !== "prSubmit") continue;
    const member = r.body.member;
    const abandonedSet = abandonedPrs(snap);
    const adopted = units.flatMap((u) => u.members).find((m) => sameIssue(m.issue, member))?.adoptPr ?? null;
    const ours = snap.prs.filter(
      (p) =>
        (p.agendaMarker || (adopted !== null && prKey(adopted) === prKey(p.ref))) &&
        p.closes.some((c) => sameIssue(c, member)) &&
        !abandonedSet.has(prKey(p.ref)),
    );
    if (ours.some((p) => p.state.kind === "merged")) continue;
    const pr = ours.find((p) => p.state.kind === "open") ?? null;
    const kind = pr === null ? "openPr" : "updatePr";
    push(mint(kind, issueKey(member), r.id, 1), { kind, submit: r, pr: pr?.ref ?? null }, unitOf(member), pr !== null && pr.appliedSubmit === r.id);
  }

  // body replacements, drafts, notices
  const all = decisions(snap);
  for (const [idx, r] of all.entries()) {
    for (const rep of r.body.bodyReplacements) {
      const issue = issueOf(snap, rep.issue);
      const applied = issue !== null && issue.appliedDecisions.includes(r.id);
      const supersededByLater = all
        .slice(idx + 1)
        .some((later) => later.body.bodyReplacements.some((b) => sameIssue(b.issue, rep.issue)) && issue !== null && issue.appliedDecisions.includes(later.id));
      const conflict = !applied && !supersededByLater && issue !== null && issue.bodyHash !== rep.baseHash;
      push(
        mint("applyBody", issueKey(rep.issue), r.id, 1),
        { kind: "applyBody", decision: r.id, replacement: rep },
        unitOf(rep.issue),
        applied || supersededByLater,
        conflict,
      );
    }
    const d = r.body.decision;
    if ((d.subject === "question" && (d.verdict.kind === "designGap" || d.verdict.kind === "acceptanceMethod")) || d.subject === "findings") {
      const affected = d.subject === "question" ? d.affected : r.body.bodyReplacements.map((b) => b.issue);
      for (const issue of affected) {
        const id = mint("noticeDecision", issueKey(issue), r.id, 1);
        push(id, { kind: "noticeDecision", decision: r.id, issue }, unitOf(issue), snap.effectMarkers.includes(id));
      }
    }
    if (d.subject === "checks" && d.verdict === "rerun") {
      const pr = snap.prs.find((p) => p.ref.number === d.pr.number && sameRepo(p.ref.repo, d.pr.repo));
      const rerun = pr !== undefined && pr.checks.latestRunCreatedAt !== null && pr.checks.latestRunCreatedAt > r.at;
      push(mint("rerunChecks", "agenda", r.id, 1), { kind: "rerunChecks", decision: r.id, pr: d.pr }, null, rerun);
    }
  }
  for (const d of draftEntries(snap)) {
    const anchorUnit = d.draft.anchor.kind === "outsideAgenda" ? null : unitOf(d.draft.anchor.entry);
    push(mint("createIssue", "agenda", d.draftId, 1), { kind: "createIssue", draftId: d.draftId, draft: d.draft }, anchorUnit, d.issue !== null);
  }
  return out;
}

function failureState(snap: Snapshot, id: ObligationId, latestAt: Millis | null): EffectSituation["failure"] {
  if (latestAt === null) return "none";
  const decision = decisionsOf(snap, "effectFailed")
    .filter((r) => r.body.decision.subject === "effectFailed" && r.body.decision.effect === id && r.body.decision.failedAt === latestAt)
    .at(-1);
  if (decision === undefined || decision.body.decision.subject !== "effectFailed") return "unadjudicated";
  return decision.body.decision.verdict;
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
