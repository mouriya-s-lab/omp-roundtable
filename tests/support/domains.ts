// The full value domain of every finite Situation type (src/core/situation.ts).

import type {
  ClosureSituation,
  EffectSituation,
  GateState,
  MemberSituation,
  ReconcileSituation,
  SeatSlotSituation,
  SubjectSituation,
  VerificationSituation,
} from "../../src/core/index.ts";
import type { Domain } from "./product.ts";

const bool = [false, true] as const;
export const gateStates: readonly GateState[] = ["none", "stale", "superseded", "validPass", "validFailUnadjudicated", "validFailAdjudicated"];
const claims = ["none", "question", "noCode", "split", "blocked"] as const;

export const memberDomain: Domain<MemberSituation> = {
  designOnly: bool,
  claim: claims,
  ours: ["none", "maintainable"],
  foreign: bool,
  foreignNoticed: bool,
  materialized: ["settled", "pending"],
  review: gateStates,
  accept: gateStates,
  repairOwner: bool,
  repairMain: bool,
  mergeable: ["yes", "no", "unknown"],
  checks: ["pass", "fail", "pending", "unknown"],
  checksRunFixed: bool,
  checksDecided: ["none", "rerun", "fixNeeded", "external"],
  deliverDone: bool,
  fixDone: bool,
  externalBlock: bool,
};

export const reconcileDomain: Domain<ReconcileSituation> = {
  outcome: ["delivered", "noCode", "pending"],
  open: bool,
  neverClosedSinceOutcome: bool,
  reopenUndecided: bool,
  reopenDecision: ["none", "restore", "correction", "reopenAccepted"],
  closedUndecided: bool,
  closedDecision: ["none", "reopen", "confirmedNoCode"],
  unitPostMergePass: bool,
};

export const verificationDomain: Domain<VerificationSituation> = {
  anyDelivered: bool,
  claim: claims,
  postMerge: gateStates,
  failDecision: ["none", "correction", "reverify"],
};

export const closureDomain: Domain<ClosureSituation> = {
  allUnitsTerminal: bool,
  strandedDesign: bool,
  parent: ["none", "open", "closed"],
  claim: claims,
  closure: gateStates,
  failDecision: ["none", "correction", "reverify"],
  reported: bool,
};

export const subjectDomain: Domain<SubjectSituation> = { decided: ["none", "resolved", "external"] };

export const effectDomain: Domain<EffectSituation> = {
  fulfilled: bool,
  failure: ["none", "unadjudicated", "retry", "external"],
  conflict: bool,
};

export const seatDomain: Domain<SeatSlotSituation> = {
  seat: ["live", "parked", "pendingAck", "absent"],
  needed: bool,
};
