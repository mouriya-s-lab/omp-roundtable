// Cross-dimension constraints classify guarantees on the Situations it produces.
// The rule layer enumerates the full product; values violating one of these are not producible, so rule coverage
// is asserted only over consistent values. The abstraction layer and the model checker assert that every classified
// Situation satisfies them — a constraint here is a checked claim about classify, not an assumption.

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
  { name: "a fail decision ⇒ the verdict is valid and failing", violated: (s) => s.failDecision !== "none" && gate(s) !== "validFailUnadjudicated" },
  { name: "reverify re-pins the attempt ⇒ the reverified verdict is no longer current", violated: (s) => s.failDecision === "reverify" },
];

export const VERIFICATION_CONSTRAINTS: readonly Constraint<VerificationSituation>[] = verificationLike<VerificationSituation>((s) => s.postMerge);
export const CLOSURE_CONSTRAINTS: readonly Constraint<ClosureSituation>[] = verificationLike<ClosureSituation>((s) => s.closure);

// Event-log reasoning: `open` follows the last lifecycle event; decisions are pinned to the latest event of their kind.
export const RECONCILE_CONSTRAINTS: readonly Constraint<ReconcileSituation>[] = [
  { name: "reopenUndecided ⇒ no decision on the latest reopen", violated: (s) => s.reopenUndecided && s.reopenDecision !== "none" },
  { name: "open after a close since the outcome ⇒ a later reopen exists (undecided or decided)", violated: (s) => s.open && !s.neverClosedSinceOutcome && !s.reopenUndecided && s.reopenDecision === "none" },
  { name: "closed and pending ⇒ a close event exists since the outcome", violated: (s) => !s.open && s.outcome === "pending" && s.neverClosedSinceOutcome },
  { name: "closedUndecided ⇒ closed and not delivered", violated: (s) => s.closedUndecided && (s.open || s.outcome === "delivered") },
  { name: "closed and not delivered ⇒ the latest close is undecided or decided", violated: (s) => !s.open && s.outcome !== "delivered" && !s.closedUndecided && s.closedDecision === "none" },
  { name: "noCode established after every reopenAccepted", violated: (s) => s.outcome === "noCode" && s.reopenDecision === "reopenAccepted" },
  {
    name: "confirmedNoCode on the latest close establishes noCode after it (or a later reopenAccepted revokes it while open)",
    violated: (s) => s.closedDecision === "confirmedNoCode" && ((s.outcome === "noCode" && !s.neverClosedSinceOutcome) || (s.outcome === "pending" && !(s.open && s.reopenDecision === "reopenAccepted"))),
  },
  { name: "a closed-decision `reopen` revokes noCode", violated: (s) => s.outcome === "noCode" && s.closedDecision === "reopen" },
];

export function violations<T>(constraints: readonly Constraint<T>[], s: T): string[] {
  return constraints.filter((c) => c.violated(s)).map((c) => c.name);
}
