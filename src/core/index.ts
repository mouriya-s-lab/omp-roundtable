// Public API of the round-table core (docs/design/core.md §4).
export { admit, type AdmitFacts, type Admission, type Caller, type NewRecord, type Reply } from "./admit.ts";
export { classify, computeUnits, outcomeOf, verdictFails, type Classified, type EffectTarget, type Unit } from "./classify.ts";
export { derive, type Derived, type Obligation, type ProgramAction, type ReplyKind, type SeatBinding } from "./derive.ts";
export { canonical, fnv64, obligationId, requestName, stripSuffix, workDir } from "./identity.ts";
export * from "./rules.ts";
export type * from "./situation.ts";
export type * from "./types.ts";
