// Enumerated stalls (core.md §6.1 "stall 只出现在列举过的情形中"): member values where the rules give nothing,
// the waiting set does not hold, and derive hands Main `decide(stall)`. Each entry is an operator-approved case,
// with the fact change that lifts it (used by the model checker as the fairness edge "external block lifted").
// Never widen this list to make a test pass (core.md §7).

import type { MemberSituation } from "../../src/core/index.ts";

export type StallLift = "pushNewHead";

export interface EnumeratedStall {
  readonly name: string;
  readonly holds: (s: MemberSituation) => boolean;
  readonly lift: StallLift;
}

export const MEMBER_STALLS: readonly EnumeratedStall[] = [
  {
    // A conflict needs a new head; a same-head fix completes `fix` without changing the conflict.
    name: "conflict persists after a same-head fix",
    holds: (s) => s.ours === "maintainable" && s.mergeable === "no" && s.fixDone && !s.repairOwner,
    lift: "pushNewHead",
  },
  {
    // A failing check run after a `fixNeeded` decision needs a new head; a same-head fix clears the repair but not the run.
    name: "failing check run persists after the fixNeeded fix",
    holds: (s) => s.ours === "maintainable" && s.checks === "fail" && s.checksRunFixed && s.checksDecided === "fixNeeded" && !s.repairOwner,
    lift: "pushNewHead",
  },
];
