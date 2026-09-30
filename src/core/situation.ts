// Finite abstract situations read by `rules`. Semantics: docs/design/core.md §3.
// Every type here is a finite product/sum so tests can enumerate it (core.md §6).

import type { ChecksState, Mergeable } from "./types.ts";

/** Validity of the latest gate verdict relative to the current pin and attempt. */
export type GateState =
  | "none" // no verdict in the slot
  | "stale" // the slot's verdict pin no longer matches the current inputs
  | "superseded" // the slot's verdict belongs to an earlier attempt (core.md §3 尝试身份)
  | "validPass"
  | "validFailUnadjudicated"
  | "validFailAdjudicated";

/** Seat observation for one required request name (core.md §1 host.seats, §3 spawn/wake). */
export type SeatState =
  | "live" // recorded holder is live
  | "parked" // recorded holder is parked
  | "pendingAck" // a usable agent with this name exists and is not the recorded holder
  | "absent"; // no usable recorded holder and no pending agent

export type ClaimKind = "question" | "noCode" | "split" | "blocked";

export interface MemberSituation {
  readonly designOnly: boolean;
  /** Earliest undecided claim raised in this member context. */
  readonly claim: ClaimKind | "none";
  readonly ours: "none" | "maintainable";
  /** Gate-input effects (openPr/updatePr/applyBody/createIssue for contract changes) not yet fulfilled. */
  readonly materialized: "settled" | "pending";
  readonly review: GateState;
  readonly accept: GateState;
  readonly repairOwner: boolean;
  readonly repairMain: boolean;
  readonly mergeable: Mergeable;
  readonly checks: ChecksState;
  /** The currently failing check run already produced a completed `fix`. */
  readonly checksRunFixed: boolean;
  /** A `checks` decision exists for the currently failing run. */
  readonly checksDecided: "none" | "rerun" | "fixNeeded" | "external";
  /** A completing reply exists for the current deliver / fix obligation. */
  readonly deliverDone: boolean;
  readonly fixDone: boolean;
  /** An `external` decision currently applies to this member (blocked claim, checks). */
  readonly externalBlock: boolean;
}

export interface ReconcileSituation {
  readonly outcome: "delivered" | "noCode" | "pending";
  readonly open: boolean;
  /** Issue was never closed after its outcome was established. */
  readonly neverClosedSinceOutcome: boolean;
  /** Latest reopen event (after the outcome) has no decision pinned to it. */
  readonly reopenUndecided: boolean;
  /** Decision pinned to the latest reopen event. */
  readonly reopenDecision: "none" | "restore" | "correction" | "reopenAccepted";
  /** Closed and not by merge, with no decision pinned to (current close event, current body hash). */
  readonly closedUndecided: boolean;
  /** Decision pinned to the current close event. */
  readonly closedDecision: "none" | "reopen" | "confirmedNoCode";
  readonly unitPostMergePass: boolean;
}

export interface VerificationSituation {
  readonly anyDelivered: boolean;
  readonly claim: ClaimKind | "none";
  readonly postMerge: GateState;
  /** Decision for the current valid failing postMerge verdict. */
  readonly failDecision: "none" | "correction" | "reverify";
}

export interface ClosureSituation {
  readonly allUnitsTerminal: boolean;
  readonly strandedDesign: boolean;
  readonly parent: "none" | "open" | "closed";
  readonly claim: ClaimKind | "none";
  readonly closure: GateState;
  readonly failDecision: "none" | "correction" | "reverify";
  readonly reported: boolean;
}

/** Per Main subject that is not tied to the active member (orphan design, migration, agenda gap, unrelated). */
export interface SubjectSituation {
  readonly decided: "none" | "resolved" | "external";
}

export interface EffectSituation {
  readonly fulfilled: boolean;
  /** Latest execution failure and its adjudication. */
  readonly failure: "none" | "unadjudicated" | "retry" | "external";
  /** Body-replacement base hash no longer matches the current body, which is not the target either; and the main session's answer to it. */
  readonly conflict: "none" | "undecided" | "resolved" | "external";
}

export interface SeatSlotSituation {
  readonly seat: SeatState;
  /** Some current obligation needs this seat. */
  readonly needed: boolean;
}

export type Phase =
  | { readonly kind: "member" } // current unit has an active member
  | { readonly kind: "verification" } // current unit has no pending member
  | { readonly kind: "closure" } // all units terminal
  | { readonly kind: "done" }; // delivery complete and reported
