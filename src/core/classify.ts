// classify: agenda state + GitHub facts + host → finite situations + witnesses (core.md §4).
// This is the only place that looks at concrete inputs; every choice among candidates happens here.

import { canonical, fnv64, issueKey, obligationId, requestName, sameIssue, samePr, sameRepo, stripSuffix, type SeatRole } from "./identity.ts";
import type {
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
  AgendaState,
  AgentId,
  Anchor,
  EffectFailure,
  Claim,
  Context,
  DeliveryTarget,
  DraftState,
  Facts,
  GateSlot,
  Hash,
  Host,
  IssueFact,
  IssueRef,
  Manifest,
  MemberState,
  Millis,
  ObligationId,
  Observed,
  PendingClaim,
  PrFact,
  PrLink,
  PrRef,
  ReplacementState,
  ReplyId,
  Route,
  Sha,
  StoredVerdict,
  SubmitState,
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
  | { readonly kind: "verdict"; readonly id: ReplyId }
  | { readonly kind: "implDefect"; readonly id: ReplyId }
  | { readonly kind: "fixNeeded"; readonly id: ReplyId }
  | { readonly kind: "designFix"; readonly commit: Sha }
  | { readonly kind: "designMerge"; readonly commit: Sha }
  | { readonly kind: "headMoved"; readonly head: Sha }
  | { readonly kind: "conflict"; readonly head: Sha }
  | { readonly kind: "checksFail"; readonly runId: string };

export interface MemberWitness {
  readonly entry: Entry;
  readonly issue: IssueFact | null;
  readonly pr: PrFact | null;
  readonly claim: PendingClaim | null;
  readonly unadjudicated: StoredVerdict | null;
  readonly fixTrigger: FixTrigger | null;
  readonly designFixVerdict: StoredVerdict | null;
  /** The verdict whose upheld owner findings the fix answers, and the rationale of an `implDefect` / `fixNeeded` decision. */
  readonly ownerVerdict: StoredVerdict | null;
  readonly repairRationale: string | null;
  readonly failedRun: string | null;
  readonly reviewManifest: Manifest | null;
  readonly acceptManifest: Manifest | null;
  readonly attempts: { readonly deliver: number; readonly review: number; readonly accept: number };
  readonly designCommits: readonly Sha[];
  /** Head of the delivery target's base branch (start point for a new branch). */
  readonly startSha: Sha | null;
  /** Contract-changing decisions that apply to this member (the holder must read them). */
  readonly contractDecisions: readonly ReplyId[];
  readonly ids: {
    readonly deliver: ObligationId;
    readonly fix: ObligationId | null;
    readonly review: ObligationId | null;
    readonly accept: ObligationId | null;
    readonly merge: ObligationId | null;
    readonly decideClaim: ObligationId | null;
    readonly decideFindings: ObligationId | null;
    readonly designFix: ObligationId | null;
    readonly decideChecks: ObligationId | null;
  };
  readonly names: { readonly owner: string; readonly review: string | null; readonly accept: string | null };
}

export interface ReconcileWitness {
  readonly member: IssueRef;
  readonly ids: { readonly close: ObligationId; readonly reopen: ObligationId; readonly decideReopened: ObligationId | null; readonly decideClosed: ObligationId | null };
  readonly eventForDecision: string | null;
  readonly bodyHash: Hash | null;
}

export interface VerificationWitness {
  readonly unit: Unit;
  readonly manifest: Manifest;
  readonly attempt: number;
  readonly legacy: boolean;
  readonly claim: PendingClaim | null;
  readonly failing: StoredVerdict | null;
  readonly ids: { readonly postMerge: ObligationId; readonly decideClaim: ObligationId | null; readonly decidePostMergeFail: ObligationId | null };
  readonly name: string;
}

export interface ClosureWitness {
  readonly parent: IssueRef | null;
  readonly manifest: Manifest | null;
  readonly attempt: number;
  readonly claim: PendingClaim | null;
  readonly failing: StoredVerdict | null;
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
  | { readonly subject: "orphanDesign"; readonly commit: Sha; readonly key: Hash; readonly id: ObligationId }
  | { readonly subject: "migration"; readonly decision: ReplyId; readonly migration: IssueRef; readonly key: Hash; readonly id: ObligationId }
  | { readonly subject: "agendaGap"; readonly child: IssueRef; readonly key: Hash; readonly id: ObligationId };

export type EffectTarget =
  | {
      readonly kind: "openPr" | "updatePr";
      readonly member: IssueRef;
      readonly target: DeliveryTarget;
      readonly submit: SubmitState;
      readonly pr: PrRef | null;
      /** Main-session design commits the rendered body must credit (core.md §3 效应). */
      readonly designCommits: readonly Sha[];
    }
  | { readonly kind: "applyBody"; readonly replacement: ReplacementState }
  | { readonly kind: "createIssue"; readonly draft: DraftState }
  | { readonly kind: "rerunChecks"; readonly member: IssueRef; readonly pr: PrRef; readonly runId: string };

export interface EffectWitness {
  readonly id: ObligationId;
  readonly target: EffectTarget;
  readonly unit: IssueRef | null;
  /** Obligation pinned (effect id, failure time) for the latest failure (core.md §3 效应). */
  readonly failedId: ObligationId | null;
  /** The latest execution failure; its error text is what the main session adjudicates. */
  readonly failure: EffectFailure | null;
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
  readonly parkedSince: Millis | null;
  readonly spawnId: ObligationId;
  readonly wakeId: ObligationId | null;
}

export interface PendingAck {
  readonly requestName: string;
  readonly agentId: AgentId;
  readonly previous: AgentId | null;
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
  readonly stall: { readonly key: Hash; readonly decided: "none" | "resolved" | "external"; readonly id: ObligationId };
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

// ---------------------------------------------------------------- state and fact access

const EMPTY_SLOT: GateSlot = { attempt: 1, verdict: null };

export function emptyMember(issue: IssueRef): MemberState {
  return {
    issue,
    submit: null,
    prs: [],
    replaced: [],
    review: EMPTY_SLOT,
    accept: EMPTY_SLOT,
    rejectedFindings: [],
    implDefect: null,
    fixNeeded: null,
    designFixes: [],
    checks: null,
    fixedRun: null,
    noCode: null,
    closed: null,
    reopened: null,
    external: false,
  };
}

export const memberOf = (state: AgendaState, ref: IssueRef): MemberState => state.members.find((m) => sameIssue(m.issue, ref)) ?? emptyMember(ref);

export const unitSlotOf = (state: AgendaState, top: IssueRef): GateSlot => state.units.find((u) => sameIssue(u.top, top))?.postMerge ?? EMPTY_SLOT;

export const issueOf = (facts: Facts, ref: IssueRef): IssueFact | null => facts.issues.find((i) => sameIssue(i.ref, ref)) ?? null;

const onDefault = (facts: Facts, repo: IssueRef["repo"], sha: Sha): boolean => facts.commits.onDefault.some((c) => sameRepo(c.repo, repo) && c.sha === sha);

export const contains = (facts: Facts, repo: IssueRef["repo"], descendant: Sha, ancestor: Sha): boolean =>
  descendant === ancestor || facts.commits.contains.some((c) => sameRepo(c.repo, repo) && c.ancestor === ancestor && c.descendant === descendant);

/** Members a PR closes: its closing references, or the members that registered it when GitHub resolves none (non-default base). */
function closesOf(state: AgendaState, pr: PrLink): IssueRef[] {
  if (pr.closes.length > 0) return [...pr.closes];
  return state.members.filter((m) => m.prs.some((p) => samePr(p, pr.ref))).map((m) => m.issue);
}

/** Every PR the round saw: registered and adopted PRs, then closing references not among them. */
function allPrs(facts: Facts): PrLink[] {
  return [...facts.prs, ...facts.links.filter((l) => !facts.prs.some((p) => samePr(p.ref, l.ref)))];
}

const registered = (member: MemberState, pr: PrRef): boolean => member.prs.some((p) => samePr(p, pr));
const replaced = (member: MemberState, pr: PrRef): boolean => member.replaced.some((p) => samePr(p, pr));

// ---------------------------------------------------------------- agenda

/** Agenda = immutable convened list + anchored insertions from drafts that became issues (core.md §1). */
export function computeUnits(state: AgendaState): Unit[] {
  const units: { top: Entry; members: Entry[] }[] = state.convened.map((c) => {
    const entry: Entry = { issue: c.issue, target: c.target, designOnly: c.designOnly, adoptPr: c.adoptPr };
    return { top: entry, members: [entry] };
  });
  const unitIndexOf = (ref: IssueRef): number => units.findIndex((u) => u.members.some((m) => sameIssue(m.issue, ref)));
  for (const d of state.drafts) {
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
export function rowOwners(state: AgendaState, context: Context): IssueRef[] {
  switch (context.kind) {
    case "member":
      return [context.member];
    case "unitVerification":
      return computeUnits(state).find((u) => sameIssue(u.top.issue, context.unit))?.members.map((m) => m.issue) ?? [];
    case "agendaClosure":
      return state.parent === null ? [] : [state.parent];
    default:
      return assertNever(context);
  }
}

// ---------------------------------------------------------------- outcomes and contracts

/** The member's delivering merge: the latest merged PR that closes it (ties: the lower PR ref, so the choice never depends on read order). */
function mergedPrFor(state: AgendaState, facts: Facts, member: IssueRef): PrLink | null {
  let best: PrLink | null = null;
  for (const p of allPrs(facts)) {
    if (p.state.kind !== "merged" || !closesOf(state, p).some((c) => sameIssue(c, member))) continue;
    const at = p.state.mergedAt;
    const bestAt = best !== null && best.state.kind === "merged" ? best.state.mergedAt : -1;
    if (best === null || at > bestAt || (at === bestAt && canonical(p.ref) < canonical(best.ref))) best = p;
  }
  return best;
}

const noCodeValid = (state: AgendaState, facts: Facts, ref: IssueRef): boolean => {
  const nc = memberOf(state, ref).noCode;
  const issue = issueOf(facts, ref);
  return nc !== null && issue !== null && nc.bodyHash === issue.bodyHash;
};

export function outcomeOf(state: AgendaState, facts: Facts, entry: Entry): Outcome {
  const merged = mergedPrFor(state, facts, entry.issue);
  if (merged !== null && merged.state.kind === "merged") {
    return { kind: "delivered", merge: { repo: merged.ref.repo, commit: merged.state.mergeSha }, mergedAt: merged.state.mergedAt };
  }
  return noCodeValid(state, facts, entry.issue) ? { kind: "noCode" } : { kind: "pending" };
}

/** Contract-changing decisions in force for a member, and the design commits they bring (core.md §3). */
function contractOf(state: AgendaState, member: IssueRef): { ids: ReplyId[]; commits: Sha[] } {
  const applying = state.contracts.filter((c) => c.affected.some((a) => sameIssue(a, member)));
  const commits = [...applying.flatMap((c) => c.routes.map((r) => r.route.commit)), ...state.members.flatMap((m) => m.designFixes.map((d) => d.commit))];
  return { ids: applying.map((c) => c.id), commits: [...new Set(commits)] };
}

interface DesignRoute {
  readonly decision: ReplyId;
  readonly route: Route;
  /** Member whose PR must carry the commit: the asking member for withPr, the named carrier for future. */
  readonly carrier: IssueRef | null;
}

const designRoutes = (state: AgendaState): DesignRoute[] => state.contracts.flatMap((c) => c.routes.map((r) => ({ decision: c.id, ...r })));

/**
 * Design commits a member's PR must contain and that are not yet on the default branch:
 * withPr / future routes it carries, and designFix commits for findings on its own verdicts.
 */
function requiredDesignCommits(state: AgendaState, facts: Facts, member: IssueRef): Sha[] {
  const routed = designRoutes(state)
    .filter((d) => d.carrier !== null && sameIssue(d.carrier, member))
    .map((d) => d.route.commit);
  const fixes = memberOf(state, member).designFixes.map((d) => d.commit);
  return [...new Set([...routed, ...fixes])].filter((c) => !onDefault(facts, member.repo, c));
}

function strandedDesignCommits(state: AgendaState, facts: Facts, units: readonly Unit[]): Sha[] {
  const out: Sha[] = [];
  for (const { route } of designRoutes(state)) {
    const repo = route.kind === "future" ? route.carrier.repo : units[0]?.top.target.repo;
    if (repo === undefined || onDefault(facts, repo, route.commit)) continue;
    const carried = allPrs(facts).some((p) => p.state.kind === "open" && contains(facts, p.target.repo, p.head, route.commit));
    if (!carried) out.push(route.commit);
  }
  return out;
}

// ---------------------------------------------------------------- gate slots

const manifestKey = (m: Manifest): string => canonical(m);

export const verdictFails = (v: Verdict): boolean => !v.ok;

/** Validity of a slot's verdict against the current pin and attempt (core.md §3 有效性、尝试身份). */
function evaluateSlot(slot: GateSlot, currentFor: (v: StoredVerdict) => Manifest | null): GateState {
  const v = slot.verdict;
  if (v === null) return "none";
  const current = currentFor(v);
  if (current === null || manifestKey(v.manifest) !== manifestKey(current)) return "stale";
  if (v.attempt < slot.attempt) return "superseded";
  if (!verdictFails(v.verdict)) return "validPass";
  return v.adjudication === null ? "validFailUnadjudicated" : "validFailAdjudicated";
}

const upheld = (v: StoredVerdict | null, who: "owner" | "main"): boolean => v !== null && v.adjudication !== null && v.adjudication.kind === "upheld" && v.adjudication.responsible === who;

// ---------------------------------------------------------------- seats

/**
 * The agent awaiting a `seated` receipt for request name `name`: only when the recorded holder is no longer usable
 * (none, gone from the registry, or aborted), the first usable agent of that name in registry order. While the holder
 * is usable, another agent of the same name is a stray duplicate: it holds nothing and is never asked to be
 * acknowledged, so two agents can never take turns as holder.
 */
function pendingAgent(host: Host, holderId: AgentId | null, name: string): AgentId | null {
  const holder = holderId === null ? undefined : host.agents.find((a) => a.id === holderId);
  if (holder !== undefined && holder.status !== "aborted") return null;
  return host.agents.find((a) => stripSuffix(a.id) === name && a.status !== "aborted" && a.id !== holderId)?.id ?? null;
}

function seatState(host: Host, state: AgendaState, name: string): { state: SeatState; holder: AgentId | null; pending: AgentId | null; parkedSince: Millis | null } {
  const holderId = state.seats.find((s) => s.requestName === name)?.holder ?? null;
  const holder = holderId === null ? undefined : host.agents.find((a) => a.id === holderId);
  if (holder !== undefined && holder.status === "live") return { state: "live", holder: holderId, pending: null, parkedSince: null };
  if (holder !== undefined && holder.status === "parked") return { state: "parked", holder: holderId, pending: null, parkedSince: holder.parkedSince };
  const pending = pendingAgent(host, holderId, name);
  if (pending !== null) return { state: "pendingAck", holder: holderId, pending, parkedSince: null };
  return { state: "absent", holder: holderId, pending: null, parkedSince: null };
}

function seatWitness(mint: Mint, host: Host, state: AgendaState, role: SeatRole, issue: IssueRef, name: string): { state: SeatState; w: SeatWitness } {
  const st = seatState(host, state, name);
  return {
    state: st.state,
    w: {
      role,
      issue,
      requestName: name,
      holder: st.holder,
      pending: st.pending,
      parkedSince: st.parkedSince,
      spawnId: mint("spawn", "seat", { requestName: name, previous: st.holder }, 1),
      wakeId: st.holder === null || st.parkedSince === null ? null : mint("wake", "seat", { agent: st.holder, parkedSince: st.parkedSince }, 1),
    },
  };
}

// ---------------------------------------------------------------- main entry

export function classify(state: AgendaState, facts: Facts, host: Host): Classified {
  const pins = new Map<ObligationId, unknown>();
  const mint = minter(pins);
  const units = computeUnits(state);
  const effects = classifyEffects(mint, state, facts, host, units);
  const currentUnit = units.find((u) => !terminal(mint, state, facts, u, effects)) ?? null;

  let member: Classified["member"] = null;
  let verification: Classified["verification"] = null;
  const reconcile: { s: ReconcileSituation; w: ReconcileWitness }[] = [];
  const seats: { state: SeatState; w: SeatWitness }[] = [];

  if (currentUnit !== null) {
    for (const m of currentUnit.members) reconcile.push(classifyReconcile(mint, state, facts, currentUnit, m));
    const pendingOpen = (m: Entry, open: boolean): boolean => outcomeOf(state, facts, m).kind === "pending" && issueOf(facts, m.issue)?.open === open;
    const active = currentUnit.members.find((m) => pendingOpen(m, true));
    const blockedClosed = currentUnit.members.some((m) => pendingOpen(m, false));
    if (active !== undefined && !blockedClosed) {
      member = classifyMember(mint, state, facts, active, effects);
      if (!active.designOnly) seats.push(seatWitness(mint, host, state, "owner", active.issue, member.w.names.owner));
      if (member.w.names.review !== null) seats.push(seatWitness(mint, host, state, "review", active.issue, member.w.names.review));
      if (member.w.names.accept !== null) seats.push(seatWitness(mint, host, state, "accept", active.issue, member.w.names.accept));
    } else if (active === undefined && !blockedClosed) {
      verification = classifyVerification(mint, state, facts, currentUnit);
      seats.push(seatWitness(mint, host, state, "postMerge", currentUnit.top.issue, verification.w.name));
    }
  }

  const closure = classifyClosure(mint, state, facts, units, currentUnit === null);
  if (closure.w.name !== null && state.parent !== null) seats.push(seatWitness(mint, host, state, "closure", state.parent, closure.w.name));

  const subjects = classifySubjects(mint, state, facts, units);

  // agents of request names no current obligation needs (a seat that finished before its receipt): one receipt per name
  const pendingAcks: PendingAck[] = [];
  const current = new Set(seats.map((s) => s.w.requestName));
  const names = new Set(host.agents.filter((a) => a.status !== "aborted" && a.requestName.startsWith("rt-")).map((a) => stripSuffix(a.id)));
  for (const name of names) {
    if (current.has(name)) continue;
    const previous = state.seats.find((s) => s.requestName === name)?.holder ?? null;
    const agentId = pendingAgent(host, previous, name);
    if (agentId !== null) pendingAcks.push({ requestName: name, agentId, previous, id: mint("spawn", "seat", { requestName: name, previous }, 1) });
  }

  const stallKey = fnv64(
    canonical({
      unit: currentUnit === null ? null : issueKey(currentUnit.top.issue),
      member: member === null ? null : member.s,
      verification: verification === null ? null : verification.s,
      closure: closure.s,
    }),
  );
  const stallDecision = state.subjects.find((d) => d.subject === "stall" && d.key === stallKey);

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
    stall: { key: stallKey, decided: stallDecision?.verdict ?? "none", id: mint("decideStall", "agenda", stallKey, 1) },
    pins,
  };
}

// ---------------------------------------------------------------- terminality

function terminal(mint: Mint, state: AgendaState, facts: Facts, unit: Unit, effects: readonly { s: EffectSituation; w: EffectWitness }[]): boolean {
  const outcomes = unit.members.map((m) => outcomeOf(state, facts, m));
  if (outcomes.some((o) => o.kind === "pending")) return false;
  for (const m of unit.members) {
    const r = classifyReconcile(mint, state, facts, unit, m).s;
    if (r.open && (r.neverClosedSinceOutcome || r.reopenUndecided || r.reopenDecision !== "none")) return false;
  }
  const unitEffectsPending = effects.some(
    (e) => !e.s.fulfilled && e.w.unit !== null && sameIssue(e.w.unit, unit.top.issue) && (e.w.target.kind === "applyBody" || e.w.target.kind === "createIssue"),
  );
  if (unitEffectsPending) return false;
  if (outcomes.every((o) => o.kind === "noCode")) return true;
  return classifyVerification(mint, state, facts, unit).s.postMerge === "validPass";
}

// ---------------------------------------------------------------- reconcile

function classifyReconcile(mint: Mint, state: AgendaState, facts: Facts, unit: Unit, entry: Entry): { s: ReconcileSituation; w: ReconcileWitness } {
  const issue = issueOf(facts, entry.issue);
  const ms = memberOf(state, entry.issue);
  const outcome = outcomeOf(state, facts, entry);
  const events = issue?.events ?? [];
  const outcomeAt: Millis | null = outcome.kind === "delivered" ? outcome.mergedAt : outcome.kind === "noCode" ? (ms.noCode?.at ?? null) : null;
  const afterOutcome = events.filter((e) => outcomeAt === null || e.at >= outcomeAt);
  const lastReopen = [...afterOutcome].reverse().find((e) => e.kind === "reopened") ?? null;
  const lastClose = [...events].reverse().find((e) => e.kind === "closed") ?? null;
  const reopenDecision = lastReopen !== null && ms.reopened !== null && ms.reopened.event === lastReopen.id ? ms.reopened.verdict : null;
  const closedDecision =
    lastClose !== null && issue !== null && ms.closed !== null && ms.closed.event === lastClose.id && ms.closed.bodyHash === issue.bodyHash ? ms.closed.verdict : null;
  const s: ReconcileSituation = {
    outcome: outcome.kind,
    open: issue?.open ?? false,
    neverClosedSinceOutcome: afterOutcome.every((e) => e.kind !== "closed"),
    reopenUndecided: lastReopen !== null && reopenDecision === null,
    reopenDecision: reopenDecision ?? "none",
    closedUndecided: issue !== null && !issue.open && outcome.kind !== "delivered" && closedDecision === null,
    closedDecision: closedDecision ?? "none",
    unitPostMergePass: classifyVerification(mint, state, facts, unit).s.postMerge === "validPass",
  };
  const ctx = issueKey(entry.issue);
  return {
    s,
    w: {
      member: entry.issue,
      eventForDecision: s.open ? (lastReopen?.id ?? null) : (lastClose?.id ?? null),
      bodyHash: issue?.bodyHash ?? null,
      ids: {
        close: mint("close", ctx, { reopen: lastReopen?.id ?? null, decision: reopenDecision }, 1),
        reopen: mint("reopen", ctx, { close: lastClose?.id ?? null, decision: closedDecision }, 1),
        decideReopened: lastReopen === null ? null : mint("decideReopened", ctx, lastReopen.id, 1),
        decideClosed: lastClose === null || issue === null ? null : mint("decideClosed", ctx, { event: lastClose.id, body: issue.bodyHash }, 1),
      },
    },
  };
}

// ---------------------------------------------------------------- member

export function claimTargetsMember(c: Claim, ref: IssueRef): boolean {
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

/** The open PR the program maintains for a member (core.md §3 `maintainable`). */
export function maintainablePr(state: AgendaState, facts: Facts, entry: Entry): PrFact | null {
  const ms = memberOf(state, entry.issue);
  return (
    facts.prs.find((p) => {
      const closes = closesOf(state, p);
      return (
        p.state.kind === "open" &&
        registered(ms, p.ref) &&
        !replaced(ms, p.ref) &&
        closes.length === 1 &&
        closes.some((c) => sameIssue(c, entry.issue)) &&
        p.target.base === entry.target.base &&
        sameRepo(p.target.repo, entry.target.repo)
      );
    }) ?? null
  );
}

function classifyMember(
  mint: Mint,
  state: AgendaState,
  facts: Facts,
  entry: Entry,
  effects: readonly { s: EffectSituation; w: EffectWitness }[],
): { s: MemberSituation; w: MemberWitness } {
  const ref = entry.issue;
  const ctx = issueKey(ref);
  const ms = memberOf(state, ref);
  const issue = issueOf(facts, ref);
  const bodyHash = issue?.bodyHash ?? ("" as Hash);
  const claim = state.claims.find((c) => claimTargetsMember(c.claim, ref)) ?? null;

  const pr = maintainablePr(state, facts, entry);
  const given = new Set<string>();
  for (const p of facts.prs) {
    if (registered(ms, p.ref) && (p.state.kind === "closedUnmerged" || replaced(ms, p.ref))) given.add(`${p.ref.repo.owner}/${p.ref.repo.name}#${p.ref.number}`);
  }
  for (const p of ms.replaced) given.add(`${p.repo.owner}/${p.repo.name}#${p.number}`);
  const deliverAttempt = 1 + given.size;
  const deliverId = mint("deliver", ctx, { body: null }, deliverAttempt);

  const submit = ms.submit;
  const contract = contractOf(state, ref);
  const requiredDesign = requiredDesignCommits(state, facts, ref);

  const memberEffectsPending = effects.some((e) => {
    if (e.s.fulfilled) return false;
    const t = e.w.target;
    switch (t.kind) {
      case "openPr":
      case "updatePr":
        return sameIssue(t.member, ref);
      case "applyBody":
        return sameIssue(t.replacement.issue, ref);
      case "createIssue":
        return e.w.unit !== null && sameIssue(e.w.unit, ref);
      case "rerunChecks":
        return false;
      default:
        return assertNever(t);
    }
  });

  let reviewManifest: Manifest | null = null;
  let acceptManifest: Manifest | null = null;
  let review: GateState = "none";
  let accept: GateState = "none";
  if (pr !== null) {
    const reviewFor = (own: ReplyId | null): Manifest => ({
      gate: "review",
      head: pr.head,
      target: pr.target,
      prBodyHash: pr.bodyHash,
      memberBodyHash: bodyHash,
      contractDecisions: contract.ids,
      designCommits: contract.commits,
      rejectedFindings: ms.rejectedFindings.filter((f) => own === null || f !== own),
    });
    acceptManifest = { gate: "accept", head: pr.head, target: pr.target, memberBodyHash: bodyHash, contractDecisions: contract.ids, designCommits: contract.commits };
    reviewManifest = reviewFor(null);
    const acceptNow = acceptManifest;
    review = evaluateSlot(ms.review, (v) => reviewFor(v.id));
    accept = evaluateSlot(ms.accept, () => acceptNow);
  }

  // repairs (only while the verdict that produced them is valid)
  const reviewValid = review === "validFailAdjudicated" ? ms.review.verdict : null;
  const acceptValid = accept === "validFailAdjudicated" ? ms.accept.verdict : null;
  const failedRun = pr !== null && pr.checks.state === "fail" ? pr.checks.failedRunId : null;
  const checksDecided = failedRun !== null && ms.checks !== null && ms.checks.runId === failedRun ? ms.checks.verdict : "none";
  const designFixFor = (v: StoredVerdict): Sha | null => ms.designFixes.find((d) => d.verdictId === v.id)?.commit ?? null;
  const designFixCommit = [reviewValid, acceptValid].filter((v): v is StoredVerdict => upheld(v, "main")).map(designFixFor).find((c) => c !== null) ?? null;
  const designFixUnmerged = designFixCommit !== null && pr !== null && !contains(facts, pr.target.repo, pr.head, designFixCommit) ? designFixCommit : null;
  const headMoved = pr !== null && submit !== null && submit.head !== pr.head;
  const designMissing = pr === null ? null : (requiredDesign.find((d) => !contains(facts, pr.target.repo, pr.head, d)) ?? null);
  const ownerVerdict = [reviewValid, acceptValid].find((v) => upheld(v, "owner")) ?? null;
  const mainVerdict = [reviewValid, acceptValid].find((v) => v !== null && upheld(v, "main") && designFixFor(v) === null) ?? null;

  const fixTrigger: FixTrigger | null =
    pr === null
      ? null
      : headMoved
        ? { kind: "headMoved", head: pr.head }
        : ownerVerdict !== null
          ? { kind: "verdict", id: ownerVerdict.id }
          : ms.implDefect !== null
            ? { kind: "implDefect", id: ms.implDefect.id }
            : ms.fixNeeded !== null
              ? { kind: "fixNeeded", id: ms.fixNeeded.id }
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
  const reviewPinHash = reviewManifest === null ? null : fnv64(manifestKey(reviewManifest));
  const acceptPinHash = acceptManifest === null ? null : fnv64(manifestKey(acceptManifest));
  const unapplied = submit !== null && (pr === null || !submit.applied || canonical([...submit.appliedDesign].sort()) !== canonical([...requiredDesign].sort()));

  const s: MemberSituation = {
    designOnly: entry.designOnly,
    claim: claim === null ? "none" : claim.claim.kind,
    ours: pr === null ? "none" : "maintainable",
    materialized: memberEffectsPending || headMoved || unapplied ? "pending" : "settled",
    review,
    accept,
    repairOwner: headMoved || ownerVerdict !== null || ms.implDefect !== null || ms.fixNeeded !== null || designFixUnmerged !== null || designMissing !== null,
    repairMain: mainVerdict !== null,
    mergeable: pr?.mergeable ?? "unknown",
    checks: pr?.checks.state ?? "unknown",
    checksRunFixed: failedRun !== null && ms.fixedRun === failedRun,
    checksDecided,
    deliverDone: submit !== null && submit.answered === deliverId,
    fixDone: fixId !== null && submit !== null && submit.answered === fixId,
    externalBlock: checksDecided === "external" || ms.external,
  };

  const unadjudicated = review === "validFailUnadjudicated" ? ms.review.verdict : accept === "validFailUnadjudicated" ? ms.accept.verdict : null;
  return {
    s,
    w: {
      entry,
      issue,
      pr,
      claim,
      unadjudicated,
      fixTrigger,
      designFixVerdict: mainVerdict,
      ownerVerdict,
      repairRationale: ms.implDefect?.rationale ?? ms.fixNeeded?.rationale ?? null,
      failedRun,
      reviewManifest,
      acceptManifest,
      attempts: { deliver: deliverAttempt, review: ms.review.attempt, accept: ms.accept.attempt },
      designCommits: requiredDesign,
      startSha: facts.commits.baseHead.find((h) => sameRepo(h.repo, entry.target.repo) && h.base === entry.target.base)?.sha ?? null,
      contractDecisions: contract.ids,
      ids: {
        deliver: deliverId,
        fix: fixId,
        review: reviewManifest === null ? null : mint("review", ctx, reviewManifest, ms.review.attempt),
        accept: acceptManifest === null ? null : mint("accept", ctx, acceptManifest, ms.accept.attempt),
        merge: pr === null ? null : mint("merge", ctx, { pr: `${pr.ref.repo.owner}/${pr.ref.repo.name}#${pr.ref.number}`, head: pr.head }, 1),
        decideClaim: claim === null ? null : mint("decideClaim", ctx, claim.id, 1),
        decideFindings: unadjudicated === null ? null : mint("decideFindings", ctx, unadjudicated.id, 1),
        designFix: mainVerdict === null ? null : mint("designFix", ctx, mainVerdict.id, 1),
        decideChecks: failedRun === null ? null : mint("decideChecks", ctx, failedRun, 1),
      },
      names: {
        owner: requestName("owner", ref, null, 1),
        review: reviewPinHash === null ? null : requestName("review", ref, reviewPinHash, ms.review.attempt),
        accept: acceptPinHash === null ? null : requestName("accept", ref, acceptPinHash, ms.accept.attempt),
      },
    },
  };
}

// ---------------------------------------------------------------- verification

function mergesOf(state: AgendaState, facts: Facts, entries: readonly Entry[]): { merges: Observed[]; latestAt: number } {
  const merges: Observed[] = [];
  let latestAt = -1;
  for (const m of entries) {
    const pr = mergedPrFor(state, facts, m.issue);
    if (pr !== null && pr.state.kind === "merged") {
      const commit = pr.state.mergeSha;
      if (!merges.some((o) => sameRepo(o.repo, pr.ref.repo) && o.commit === commit)) merges.push({ repo: pr.ref.repo, commit });
      latestAt = Math.max(latestAt, pr.state.mergedAt);
    }
  }
  return { merges, latestAt };
}

export function unitManifest(state: AgendaState, facts: Facts, unit: Unit): { manifest: Manifest; legacy: boolean } {
  const { merges, latestAt } = mergesOf(state, facts, unit.members);
  const ids: ReplyId[] = [];
  const commits: Sha[] = [];
  for (const m of unit.members) {
    const c = contractOf(state, m.issue);
    ids.push(...c.ids);
    commits.push(...c.commits);
  }
  return {
    manifest: {
      gate: "postMerge",
      merges,
      memberBodyHashes: unit.members.map((m) => issueOf(facts, m.issue)?.bodyHash ?? ("" as Hash)),
      contractDecisions: [...new Set(ids)],
      designCommits: [...new Set(commits)],
    },
    legacy: latestAt >= 0 && latestAt < state.convenedAt,
  };
}

function verificationClaim(state: AgendaState, context: Context): PendingClaim | null {
  return state.claims.find((c) => c.claim.kind === "question" && canonical(c.claim.context) === canonical(context)) ?? null;
}

function classifyVerification(mint: Mint, state: AgendaState, facts: Facts, unit: Unit): { s: VerificationSituation; w: VerificationWitness } {
  const ctx = `verify:${issueKey(unit.top.issue)}`;
  const { manifest, legacy } = unitManifest(state, facts, unit);
  const slot = unitSlotOf(state, unit.top.issue);
  const gate = evaluateSlot(slot, () => manifest);
  const valid = gate === "validPass" || gate === "validFailUnadjudicated" || gate === "validFailAdjudicated";
  const current = valid ? slot.verdict : null;
  const claim = verificationClaim(state, { kind: "unitVerification", unit: unit.top.issue });
  return {
    s: {
      anyDelivered: unit.members.some((m) => outcomeOf(state, facts, m).kind === "delivered"),
      claim: claim === null ? "none" : claim.claim.kind,
      postMerge: gate === "validFailAdjudicated" ? "validFailUnadjudicated" : gate,
      failDecision: current?.failDecision ?? "none",
    },
    w: {
      unit,
      manifest,
      attempt: slot.attempt,
      legacy,
      claim,
      failing: current !== null && verdictFails(current.verdict) ? current : null,
      ids: {
        postMerge: mint("postMerge", ctx, manifest, slot.attempt),
        decideClaim: claim === null ? null : mint("decideClaim", ctx, claim.id, 1),
        decidePostMergeFail: current === null ? null : mint("decidePostMergeFail", ctx, current.id, 1),
      },
      name: requestName("postMerge", unit.top.issue, fnv64(manifestKey(manifest)), slot.attempt),
    },
  };
}

// ---------------------------------------------------------------- closure

function childTerminal(state: AgendaState, facts: Facts, child: IssueRef): "merged" | "noCode" | null {
  if (mergedPrFor(state, facts, child) !== null) return "merged";
  return noCodeValid(state, facts, child) ? "noCode" : null;
}

function classifyClosure(mint: Mint, state: AgendaState, facts: Facts, units: readonly Unit[], allTerminal: boolean): { s: ClosureSituation; w: ClosureWitness } {
  const ctx = "closure";
  const parentRef = state.parent;
  const parent = parentRef === null ? null : issueOf(facts, parentRef);
  const stranded = strandedDesignCommits(state, facts, units);
  const reportId = mint("report", ctx, null, 1);
  const closeParent = mint("closeParent", ctx, null, 1);
  const reopenParent = mint("reopenParent", ctx, null, 1);
  if (parentRef === null || parent === null) {
    return {
      s: { allUnitsTerminal: allTerminal, strandedDesign: stranded.length > 0, parent: "none", claim: "none", closure: "none", failDecision: "none", reported: state.reported },
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
  const { merges } = mergesOf(state, facts, units.flatMap((u) => u.members));
  const children = parent.children
    .map((c) => ({ issue: c, terminal: childTerminal(state, facts, c) }))
    .filter((c): c is { issue: IssueRef; terminal: "merged" | "noCode" } => c.terminal !== null);
  const manifest: Manifest = { gate: "closure", merges, parentBodyHash: parent.bodyHash, children, strandedDesign: stranded };
  const slot = state.closure;
  const gate = evaluateSlot(slot, () => manifest);
  const valid = gate === "validPass" || gate === "validFailUnadjudicated" || gate === "validFailAdjudicated";
  const current = valid ? slot.verdict : null;
  const claim = verificationClaim(state, { kind: "agendaClosure" });
  return {
    s: {
      allUnitsTerminal: allTerminal,
      strandedDesign: stranded.length > 0,
      parent: parent.open ? "open" : "closed",
      claim: claim === null ? "none" : claim.claim.kind,
      closure: gate === "validFailAdjudicated" ? "validFailUnadjudicated" : gate,
      failDecision: current?.failDecision ?? "none",
      reported: state.reported,
    },
    w: {
      parent: parentRef,
      manifest,
      attempt: slot.attempt,
      claim,
      failing: current !== null && verdictFails(current.verdict) ? current : null,
      ids: {
        closure: mint("closure", ctx, manifest, slot.attempt),
        decideClaim: claim === null ? null : mint("decideClaim", ctx, claim.id, 1),
        decideClosureFail: current === null ? null : mint("decideClosureFail", ctx, current.id, 1),
        closeParent,
        reopenParent,
        report: reportId,
      },
      name: requestName("closure", parentRef, fnv64(manifestKey(manifest)), slot.attempt),
    },
  };
}

// ---------------------------------------------------------------- subjects

function classifySubjects(mint: Mint, state: AgendaState, facts: Facts, units: readonly Unit[]): { s: SubjectSituation; w: SubjectWitness }[] {
  const out: { s: SubjectSituation; w: SubjectWitness }[] = [];
  const keyed = (subject: "orphanDesign" | "migration" | "agendaGap", key: Hash): SubjectSituation => ({
    decided: state.subjects.find((d) => d.subject === subject && d.key === key)?.verdict ?? "none",
  });
  const entries = units.flatMap((u) => u.members);
  const carrierGone = (carrier: IssueRef | null): boolean => {
    if (carrier === null) return true;
    const entry = entries.find((m) => sameIssue(m.issue, carrier));
    return entry === undefined || outcomeOf(state, facts, entry).kind !== "pending";
  };
  const strandedSet = new Set(strandedDesignCommits(state, facts, units));
  for (const { route, carrier } of designRoutes(state)) {
    if (!strandedSet.has(route.commit) || !carrierGone(carrier)) continue;
    const key = fnv64(route.commit);
    out.push({ s: keyed("orphanDesign", key), w: { subject: "orphanDesign", commit: route.commit, key, id: mint("decideOrphanDesign", "agenda", key, 1) } });
  }
  for (const { decision, route } of designRoutes(state)) {
    if (route.kind !== "defaultFirst" || route.migration === null) continue;
    const migration = route.migration;
    const entry = entries.find((m) => sameIssue(m.issue, migration));
    const issue = issueOf(facts, migration);
    const failed = issue !== null && !issue.open && (entry === undefined || outcomeOf(state, facts, entry).kind !== "delivered");
    if (!failed) continue;
    const key = fnv64(decision);
    out.push({ s: keyed("migration", key), w: { subject: "migration", decision, migration, key, id: mint("decideMigration", "agenda", key, 1) } });
  }
  const parent = state.parent === null ? null : issueOf(facts, state.parent);
  if (parent !== null) {
    for (const child of parent.children) {
      if (entries.some((m) => sameIssue(m.issue, child)) || childTerminal(state, facts, child) !== null) continue;
      const key = fnv64(issueKey(child));
      out.push({ s: keyed("agendaGap", key), w: { subject: "agendaGap", child, key, id: mint("decideAgendaGap", "agenda", key, 1) } });
    }
  }
  return out;
}

// ---------------------------------------------------------------- effects (agenda-wide)

function classifyEffects(mint: Mint, state: AgendaState, facts: Facts, host: Host, units: readonly Unit[]): { s: EffectSituation; w: EffectWitness }[] {
  const out: { s: EffectSituation; w: EffectWitness }[] = [];
  const entries = units.flatMap((u) => u.members);
  const unitOf = (ref: IssueRef): IssueRef | null => units.find((u) => u.members.some((m) => sameIssue(m.issue, ref)))?.top.issue ?? null;
  const push = (id: ObligationId, target: EffectTarget, unit: IssueRef | null, fulfilled: boolean, conflict: boolean): void => {
    const latest = host.failures.filter((f) => f.effect === id).at(-1);
    const conflictKey = fnv64(id);
    const conflictDecision = state.subjects.find((d) => d.subject === "stall" && d.key === conflictKey)?.verdict ?? "undecided";
    out.push({
      s: { fulfilled, failure: failureState(state, id, latest?.at ?? null), conflict: conflict ? conflictDecision : "none" },
      w: {
        id,
        target,
        unit,
        failedId: latest === undefined ? null : mint("decideEffectFailed", "agenda", { effect: id, failedAt: latest.at }, 1),
        failure: latest ?? null,
        conflictKey,
        conflictId: mint("decideEffectConflict", "agenda", conflictKey, 1),
      },
    });
  };

  // PR materialization for each member's latest submit
  for (const ms of state.members) {
    const submit = ms.submit;
    if (submit === null) continue;
    const entry = entries.find((m) => sameIssue(m.issue, ms.issue));
    if (entry === undefined) continue;
    const ours = facts.prs.filter((p) => registered(ms, p.ref) && !replaced(ms, p.ref));
    if (ours.some((p) => p.state.kind === "merged")) continue;
    const pr = ours.find((p) => p.state.kind === "open") ?? null;
    const designCommits = requiredDesignCommits(state, facts, ms.issue);
    const fulfilled = pr !== null && submit.applied && canonical([...submit.appliedDesign].sort()) === canonical([...designCommits].sort());
    if (fulfilled || (submit.applied && pr === null)) continue;
    const kind = pr === null ? "openPr" : "updatePr";
    push(
      mint(kind, issueKey(ms.issue), { submit: submit.answered, head: submit.head, designCommits }, 1),
      { kind, member: ms.issue, target: entry.target, submit, pr: pr?.ref ?? null, designCommits },
      unitOf(ms.issue),
      false,
      false,
    );
  }

  for (const rep of state.replacements) {
    const issue = issueOf(facts, rep.issue);
    // fulfilled only once recorded: a body already equal to the target is recorded by executing the effect, which the
    // store's source check turns into a write-back without a GitHub write (so a later human edit does not revive it)
    const fulfilled = rep.applied;
    const conflict = !fulfilled && issue !== null && issue.bodyHash !== rep.baseHash && issue.bodyHash !== rep.targetHash;
    push(mint("applyBody", issueKey(rep.issue), rep.decision, 1), { kind: "applyBody", replacement: rep }, unitOf(rep.issue), fulfilled, conflict);
  }

  for (const ms of state.members) {
    const c = ms.checks;
    if (c === null || c.verdict !== "rerun") continue;
    const pr = facts.prs.find((p) => registered(ms, p.ref) && p.state.kind === "open");
    if (pr === undefined) continue;
    push(mint("rerunChecks", issueKey(ms.issue), c.runId, 1), { kind: "rerunChecks", member: ms.issue, pr: pr.ref, runId: c.runId }, null, c.rerunDone, false);
  }

  for (const d of state.drafts) {
    const anchorUnit = d.draft.anchor.kind === "outsideAgenda" ? null : unitOf(d.draft.anchor.entry);
    push(mint("createIssue", "agenda", d.id, 1), { kind: "createIssue", draft: d }, anchorUnit, d.issue !== null, false);
  }
  return out;
}

function failureState(state: AgendaState, id: ObligationId, latestAt: Millis | null): EffectSituation["failure"] {
  if (latestAt === null) return "none";
  return state.effectDecisions.find((d) => d.effect === id && d.failedAt === latestAt)?.verdict ?? "unadjudicated";
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
