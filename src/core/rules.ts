// Rules: the only place protocol decisions live (docs/design/core.md §3).
// Every function here reads a finite situation and returns obligation kinds; nothing else.

import type {
  ClosureSituation,
  EffectSituation,
  GateState,
  MemberSituation,
  ReconcileSituation,
  SeatSlotSituation,
  SubjectSituation,
  VerificationSituation,
} from "./situation.ts";

export type Holder = "main" | "owner" | "gate" | "program";

export type MemberKind =
  | "decideClaim"
  | "deliver"
  | "decideFindings"
  | "fix"
  | "designFix"
  | "decideChecks"
  | "review"
  | "accept"
  | "merge";

export type ReconcileKind = "close" | "reopen" | "decideReopened" | "decideClosed";
export type VerificationKind = "decideClaim" | "postMerge" | "decidePostMergeFail";
export type ClosureKind = "decideClaim" | "closure" | "decideClosureFail" | "closeParent" | "reopenParent" | "report";
export type SubjectKind = "decideSubject";
export type EffectKind = "execute" | "decideEffectFailed" | "decideStall";
export type SeatKind = "spawn" | "wake";

export interface Spec<K extends string> {
  readonly kind: K;
  readonly holder: Holder;
}

const spec = <K extends string>(kind: K, holder: Holder): Spec<K> => ({ kind, holder });

/** A gate verdict does not count for the current inputs and attempt. */
export const gateNeeded = (g: GateState): boolean => g === "none" || g === "stale" || g === "superseded";

/** Guard (core.md §3 守卫): no gate obligation and no merge while any of these holds. */
export const memberGateGuard = (s: MemberSituation): boolean =>
  s.claim !== "none" ||
  s.materialized === "pending" ||
  s.review === "validFailUnadjudicated" ||
  s.accept === "validFailUnadjudicated" ||
  s.repairOwner ||
  s.repairMain;

export function memberRules(s: MemberSituation): readonly Spec<MemberKind>[] {
  const out: Spec<MemberKind>[] = [];
  const ownerHolder: Holder = s.designOnly ? "main" : "owner";

  if (s.claim !== "none") out.push(spec("decideClaim", "main"));

  if (s.ours === "none") {
    if (!s.deliverDone) out.push(spec("deliver", ownerHolder));
    return out;
  }

  if (s.review === "validFailUnadjudicated" || s.accept === "validFailUnadjudicated") out.push(spec("decideFindings", "main"));

  const checksFixTrigger = s.checks === "fail" && !s.checksRunFixed;
  if ((s.repairOwner || s.mergeable === "no" || checksFixTrigger) && !s.fixDone) out.push(spec("fix", ownerHolder));
  if (s.repairMain) out.push(spec("designFix", "main"));
  if (s.checks === "fail" && s.checksRunFixed && s.checksDecided === "none") out.push(spec("decideChecks", "main"));

  if (!memberGateGuard(s)) {
    if (gateNeeded(s.review)) out.push(spec("review", "gate"));
    if (gateNeeded(s.accept)) out.push(spec("accept", "gate"));
    if (s.review === "validPass" && s.accept === "validPass" && s.mergeable === "yes" && s.checks === "pass") {
      out.push(spec("merge", "program"));
    }
  }
  return out;
}

/** Member states that legitimately produce nothing (core.md §3 等待集合). */
export const memberWaiting = (s: MemberSituation): boolean =>
  s.externalBlock ||
  s.materialized === "pending" ||
  (s.ours === "maintainable" &&
    (s.mergeable === "unknown" || s.checks === "pending" || s.checks === "unknown" || (s.checks === "fail" && s.checksDecided === "rerun")));

export function reconcileRules(s: ReconcileSituation): readonly Spec<ReconcileKind>[] {
  const out: Spec<ReconcileKind>[] = [];
  const settled = s.outcome === "delivered" || s.outcome === "noCode";
  if (s.open) {
    if (settled && s.neverClosedSinceOutcome) out.push(spec("close", "program"));
    if (settled && s.reopenUndecided) out.push(spec("decideReopened", "main"));
    if (s.reopenDecision === "restore" || (s.reopenDecision === "correction" && s.unitPostMergePass)) {
      out.push(spec("close", "program"));
    }
  } else {
    if (s.outcome === "pending" && s.closedUndecided) out.push(spec("decideClosed", "main"));
    if (s.closedDecision === "reopen") out.push(spec("reopen", "program"));
  }
  return dedupe(out);
}

/** A member whose issue state already matches its outcome. */
export const reconciled = (s: ReconcileSituation): boolean => reconcileRules(s).length === 0 && !(s.outcome === "pending" && !s.open);

export function verificationRules(s: VerificationSituation): readonly Spec<VerificationKind>[] {
  if (s.claim !== "none") return [spec("decideClaim", "main")];
  if (!s.anyDelivered) return [];
  if (gateNeeded(s.postMerge)) return [spec("postMerge", "gate")];
  if (s.postMerge === "validFailUnadjudicated" && s.failDecision === "none") return [spec("decidePostMergeFail", "main")];
  return [];
}

export const verificationPassed = (s: VerificationSituation): boolean => !s.anyDelivered || s.postMerge === "validPass";

export function closureRules(s: ClosureSituation): readonly Spec<ClosureKind>[] {
  if (!s.allUnitsTerminal || s.strandedDesign) return [];
  const out: Spec<ClosureKind>[] = [];
  if (s.parent === "none") {
    if (!s.reported) out.push(spec("report", "main"));
    return out;
  }
  if (s.claim !== "none") out.push(spec("decideClaim", "main"));
  else if (gateNeeded(s.closure)) out.push(spec("closure", "gate"));
  if (s.closure === "validFailUnadjudicated" && s.failDecision === "none") out.push(spec("decideClosureFail", "main"));
  if (s.closure === "validPass" && s.parent === "open") out.push(spec("closeParent", "program"));
  if (s.closure !== "validPass" && s.parent === "closed") out.push(spec("reopenParent", "program"));
  if (s.closure === "validPass" && s.parent === "closed" && !s.reported) out.push(spec("report", "main"));
  return out;
}

export const closureDone = (s: ClosureSituation): boolean =>
  s.allUnitsTerminal &&
  !s.strandedDesign &&
  s.reported &&
  (s.parent === "none" || (s.parent === "closed" && s.closure === "validPass"));

export function subjectRules(s: SubjectSituation): readonly Spec<SubjectKind>[] {
  return s.decided === "none" ? [spec("decideSubject", "main")] : [];
}

export function effectRules(s: EffectSituation): readonly Spec<EffectKind>[] {
  if (s.fulfilled) return [];
  switch (s.conflict) {
    case "undecided":
      return [spec("decideStall", "main")];
    case "resolved":
    case "external":
      return [];
    case "none":
      break;
    default:
      return assertNever(s.conflict);
  }
  switch (s.failure) {
    case "unadjudicated":
      return [spec("decideEffectFailed", "main")];
    case "external":
      return [];
    case "none":
    case "retry":
      return [spec("execute", "program")];
    default:
      return assertNever(s.failure);
  }
}

export const effectWaiting = (s: EffectSituation): boolean => !s.fulfilled && (s.failure === "external" || s.conflict === "external");

export function seatRules(s: SeatSlotSituation): readonly Spec<SeatKind>[] {
  switch (s.seat) {
    case "pendingAck":
      return [spec("spawn", "main")];
    case "absent":
      return s.needed ? [spec("spawn", "main")] : [];
    case "parked":
      return s.needed ? [spec("wake", "main")] : [];
    case "live":
    case "parkedWoken":
      return [];
    default:
      return assertNever(s.seat);
  }
}

function dedupe<K extends string>(specs: readonly Spec<K>[]): Spec<K>[] {
  const seen = new Set<string>();
  const out: Spec<K>[] = [];
  for (const s of specs) {
    const key = `${s.kind}/${s.holder}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
