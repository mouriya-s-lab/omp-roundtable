// Cross-dimension constraints on the Situations classify produces; a value violating one is "inconsistent".
// Each constraint follows from classify's definitions over well-formed snapshots (time-ordered records, alternating
// issue events, decisions written after what they pin), or — where stated — from admission: a record admit only
// accepts for an obligation that derive gives in that state.
// Uses: the rule layer asserts coverage over consistent values only; the abstraction layer builds every consistent
// value of the small types (and a sample of MemberSituation) and never excludes a value without naming the constraint
// it breaks; the model checker asserts every classified Situation it reaches is consistent.

import type { ClosureSituation, MemberSituation, ReconcileSituation, VerificationSituation } from "../../src/core/index.ts";

export interface Constraint<T> {
  readonly name: string;
  readonly violated: (s: T) => boolean;
}

const vfa = (s: MemberSituation): boolean => s.review === "validFailAdjudicated" || s.accept === "validFailAdjudicated";

export const MEMBER_CONSTRAINTS: readonly Constraint<MemberSituation>[] = [
  {
    name: "ours=none ⇒ no gate verdict, PR facts unknown, no fix/notice/checks state",
    violated: (s) =>
      s.ours === "none" &&
      (s.review !== "none" || s.accept !== "none" || s.mergeable !== "unknown" || s.checks !== "unknown" || s.foreignNoticed || s.fixDone || s.checksRunFixed || s.checksDecided !== "none"),
  },
  { name: "ours=none ∧ deliverDone ⇒ materialized=pending", violated: (s) => s.ours === "none" && s.deliverDone && s.materialized === "settled" },
  { name: "checksRunFixed or a checks decision ⇒ checks=fail", violated: (s) => s.checks !== "fail" && (s.checksRunFixed || s.checksDecided !== "none") },
  { name: "checksDecided=external ⇒ externalBlock", violated: (s) => s.checksDecided === "external" && !s.externalBlock },
  { name: "repairMain ⇒ an adjudicated failing gate verdict", violated: (s) => s.repairMain && !vfa(s) },
  {
    // upheld findings repair; designGap/acceptanceMethod change the contract (verdict stale); all-dismissed or answered ⇒ superseded
    name: "an adjudicated failing verdict that is still valid carries a repair",
    violated: (s) => vfa(s) && !s.repairOwner && !s.repairMain,
  },
  { name: "fixDone ⇒ a fix trigger (repair, mergeable=no or checks=fail)", violated: (s) => s.fixDone && !s.repairOwner && s.mergeable !== "no" && s.checks !== "fail" },
  { name: "repairOwner ⇒ ¬fixDone (every repair trigger is cleared by the PrSubmit that completes its fix)", violated: (s) => s.repairOwner && s.fixDone },
  {
    name: "fixDone on the checksFail trigger ⇒ checksRunFixed",
    violated: (s) => s.fixDone && !s.repairOwner && s.mergeable !== "no" && s.checks === "fail" && !s.checksRunFixed,
  },
  {
    name: "checksRunFixed with the checksFail run as the current trigger ⇒ fixDone",
    violated: (s) => s.checksRunFixed && !s.fixDone && !s.repairOwner && s.mergeable !== "no",
  },
];

const verificationLike = <T extends { readonly claim: string; readonly failDecision: string }>(gate: (s: T) => string): Constraint<T>[] => [
  { name: "claims in this context are questions", violated: (s) => s.claim !== "none" && s.claim !== "question" },
  { name: "gate state is never superseded/validFailAdjudicated (no findings)", violated: (s) => gate(s) === "superseded" || gate(s) === "validFailAdjudicated" },
  // admission: decide(postMergeFail|closureFail) is only derived for the current valid failing verdict
  { name: "a fail decision ⇒ the verdict is valid and failing", violated: (s) => s.failDecision !== "none" && gate(s) !== "validFailUnadjudicated" },
  { name: "reverify re-pins the attempt ⇒ the reverified verdict is no longer current", violated: (s) => s.failDecision === "reverify" },
];

export const VERIFICATION_CONSTRAINTS: readonly Constraint<VerificationSituation>[] = verificationLike<VerificationSituation>((s) => s.postMerge);
export const CLOSURE_CONSTRAINTS: readonly Constraint<ClosureSituation>[] = [
  ...verificationLike<ClosureSituation>((s) => s.closure),
  // classifyClosure returns the neutral closure dimensions when the agenda has no parent
  { name: "no parent ⇒ no closure claim, verdict or fail decision", violated: (s) => s.parent === "none" && (s.claim !== "none" || s.closure !== "none" || s.failDecision !== "none") },
];

// ReconcileSituation (classifyReconcile) over a timeline: the issue's events alternate closed/reopened starting with a
// close, `open` follows the last event; a decision is written after the event it pins. `afterOutcome` holds the events
// at or after the outcome time (all events for a pending member); the outcome time of noCode is the latest noCode-type
// decision (noCode, noCodeClaim, closed, reopened/reopenAccepted), and every closed decision is such a decision.
export const RECONCILE_CONSTRAINTS: readonly Constraint<ReconcileSituation>[] = [
  { name: "reopenUndecided ⇒ no decision on the latest reopen", violated: (s) => s.reopenUndecided && s.reopenDecision !== "none" },
  { name: "closedUndecided ⇒ no decision on the latest close", violated: (s) => s.closedUndecided && s.closedDecision !== "none" },
  { name: "closedUndecided ⇒ closed and not delivered", violated: (s) => s.closedUndecided && (s.open || s.outcome === "delivered") },
  { name: "closed and not delivered ⇒ the latest close is undecided or decided", violated: (s) => !s.open && s.outcome !== "delivered" && !s.closedUndecided && s.closedDecision === "none" },
  {
    // the last event is a reopen after that close, so it lies in afterOutcome
    name: "open after a close since the outcome ⇒ the latest reopen since the outcome is undecided or decided",
    violated: (s) => s.open && !s.neverClosedSinceOutcome && !s.reopenUndecided && s.reopenDecision === "none",
  },
  {
    // the last event is a close before the outcome, so no event lies in afterOutcome; a pending member has afterOutcome = all
    name: "closed with no close since the outcome ⇒ settled, and no reopen since the outcome",
    violated: (s) => !s.open && s.neverClosedSinceOutcome && (s.outcome === "pending" || s.reopenUndecided || s.reopenDecision !== "none"),
  },
  {
    // afterOutcome = all events; no close at all ⇒ no event at all
    name: "pending with no close ⇒ no lifecycle event and no pinned decision",
    violated: (s) => s.outcome === "pending" && s.neverClosedSinceOutcome && (!s.open || s.reopenUndecided || s.reopenDecision !== "none" || s.closedDecision !== "none"),
  },
  {
    // reopenAccepted is a noCode-type decision after the pinned reopen, so a later confirmation moves the outcome time past it
    name: "noCode ⇒ the latest reopen since the outcome is not decided reopenAccepted",
    violated: (s) => s.outcome === "noCode" && s.reopenDecision === "reopenAccepted",
  },
  {
    // a closed decision is a noCode-type decision after the latest close, so the outcome time is after every close
    name: "noCode with a decision on the latest close ⇒ no close since the outcome",
    violated: (s) => s.outcome === "noCode" && s.closedDecision !== "none" && !s.neverClosedSinceOutcome,
  },
];

export function violations<T>(constraints: readonly Constraint<T>[], s: T): string[] {
  return constraints.filter((c) => c.violated(s)).map((c) => c.name);
}
