// core.md §6.1 规则层穷举: every value of every Situation type goes through its rules function.

import { describe, expect, test } from "bun:test";
import {
  closureDone,
  closureRules,
  effectRules,
  effectWaiting,
  gateNeeded,
  memberGateGuard,
  memberRules,
  memberWaiting,
  reconcileRules,
  reconciled,
  seatRules,
  subjectRules,
  verificationPassed,
  verificationRules,
  type ClosureKind,
  type EffectKind,
  type MemberKind,
  type ReconcileKind,
  type SeatKind,
  type Spec,
  type SubjectKind,
  type VerificationKind,
} from "../src/core/index.ts";
import type { MemberSituation, VerificationSituation, ClosureSituation, ReconcileSituation } from "../src/core/index.ts";
import {
  closureDomain,
  effectDomain,
  memberDomain,
  reconcileDomain,
  seatDomain,
  subjectDomain,
  verificationDomain,
} from "./support/domains.ts";
import { domainSize, enumerate, type Domain } from "./support/product.ts";
import { CLOSURE_CONSTRAINTS, MEMBER_CONSTRAINTS, VERIFICATION_CONSTRAINTS, violations } from "./support/consistency.ts";
import { MEMBER_STALLS } from "./support/stalls.ts";

// Every output kind of every rules function (typed so a new kind is a compile error here).
const MEMBER_KINDS: Record<MemberKind, true> = {
  decideClaim: true, deliver: true, decideFindings: true, fix: true,
  designFix: true, decideChecks: true, review: true, accept: true, merge: true,
};
const RECONCILE_KINDS: Record<ReconcileKind, true> = { close: true, reopen: true, decideReopened: true, decideClosed: true };
const VERIFICATION_KINDS: Record<VerificationKind, true> = { decideClaim: true, postMerge: true, decidePostMergeFail: true };
const CLOSURE_KINDS: Record<ClosureKind, true> = {
  decideClaim: true, closure: true, decideClosureFail: true, closeParent: true, reopenParent: true, report: true,
};
const SUBJECT_KINDS: Record<SubjectKind, true> = { decideSubject: true };
const EFFECT_KINDS: Record<EffectKind, true> = { execute: true, decideEffectFailed: true, decideStall: true };
const SEAT_KINDS: Record<SeatKind, true> = { spawn: true, wake: true };

const key = <K extends string>(specs: readonly Spec<K>[]): string => specs.map((s) => `${s.kind}/${s.holder}`).join(",");

interface Tally<K extends string> {
  values: number;
  fired: Record<K, number>;
  stall: number;
  inconsistent: number;
}

/** Enumerate one domain; per value check determinism and the caller's properties; tally kinds. */
function sweep<T, K extends string>(
  name: string,
  domain: Domain<T>,
  kinds: Record<K, true>,
  rules: (s: T) => readonly Spec<K>[],
  check: (s: T, out: readonly Spec<K>[]) => "ok" | "stall" | "inconsistent" | string,
): Tally<K> {
  const fired = Object.fromEntries(Object.keys(kinds).map((k) => [k, 0])) as Record<K, number>;
  let values = 0;
  let stall = 0;
  let inconsistent = 0;
  const failures: string[] = [];
  for (const s of enumerate(domain)) {
    values++;
    const a = rules(s);
    const b = rules(s);
    if (key(a) !== key(b)) failures.push(`nondeterministic: ${JSON.stringify(s)}`);
    const seen: Record<string, true> = {};
    for (const sp of a) {
      if (seen[`${sp.kind}/${sp.holder}`]) failures.push(`duplicate ${sp.kind}: ${JSON.stringify(s)}`);
      seen[`${sp.kind}/${sp.holder}`] = true;
      fired[sp.kind]++;
    }
    const verdict = check(s, a);
    if (verdict === "stall") stall++;
    else if (verdict === "inconsistent") inconsistent++;
    else if (verdict !== "ok" && failures.length < 20) failures.push(`${verdict}: ${JSON.stringify(s)} -> [${key(a)}]`);
  }
  console.log(`[rules] ${name}: ${values} values (domain ${domainSize(domain)}; ${values - inconsistent} classify-consistent), enumerated stalls ${stall}; fired ${JSON.stringify(fired)}`);
  expect(failures).toEqual([]);
  const silent = (Object.keys(fired) as K[]).filter((k) => fired[k] === 0);
  expect(silent).toEqual([]);
  return { values, fired, stall, inconsistent };
}

const has = <K extends string>(out: readonly Spec<K>[], k: K): boolean => out.some((s) => s.kind === k);

// ------------------------------------------------------------------ member

function memberCheck(s: MemberSituation, out: readonly Spec<MemberKind>[]): "ok" | "stall" | string {
  // core.md §3 守卫, restated here independently of rules.ts
  const guard =
    s.claim !== "none" || s.materialized === "pending" || s.review === "validFailUnadjudicated" || s.accept === "validFailUnadjudicated" || s.repairOwner || s.repairMain;
  if (guard !== memberGateGuard(s)) return "memberGateGuard differs from core.md §3 守卫";
  if (guard && (has(out, "review") || has(out, "accept") || has(out, "merge"))) return "guard violated";
  if (has(out, "merge")) {
    const ok = s.review === "validPass" && s.accept === "validPass" && s.mergeable === "yes" && s.checks === "pass" && !guard && s.ours === "maintainable";
    if (!ok) return "merge without its preconditions";
  }
  if (s.ours === "none" && out.some((o) => o.kind !== "deliver" && o.kind !== "decideClaim")) return "PR obligation without a maintainable PR";
  if ((has(out, "review") && !gateNeeded(s.review)) || (has(out, "accept") && !gateNeeded(s.accept))) return "gate re-issued over a valid verdict";
  if (s.claim !== "none" && !has(out, "decideClaim")) return "pending claim without decide(claim)";
  for (const o of out) {
    const expected: Holder = o.kind === "deliver" || o.kind === "fix" ? (s.designOnly ? "main" : "owner") : HOLDER[o.kind];
    if (o.holder !== expected) return `holder of ${o.kind} is ${o.holder}`;
  }
  if (violations(MEMBER_CONSTRAINTS, s).length > 0) return "inconsistent"; // safety properties above hold for these too
  if (out.length > 0 || memberWaiting(s)) return "ok";
  return MEMBER_STALLS.some((c) => c.holds(s)) ? "stall" : "uncovered (no obligation, not waiting, not an enumerated stall)";
}

type Holder = Spec<string>["holder"];
const HOLDER: Record<MemberKind, Holder> = {
  decideClaim: "main", deliver: "owner", decideFindings: "main", fix: "owner",
  designFix: "main", decideChecks: "main", review: "gate", accept: "gate", merge: "program",
};

// ------------------------------------------------------------------ the rest

function reconcileCheck(s: ReconcileSituation, out: readonly Spec<ReconcileKind>[]): string {
  if (has(out, "close") && !s.open) return "close on a closed issue";
  if (has(out, "reopen") && s.open) return "reopen on an open issue";
  if (has(out, "decideClosed") && (s.open || s.outcome !== "pending")) return "decide(closed) outside a closed pending member";
  if (has(out, "decideReopened") && (!s.open || s.outcome === "pending")) return "decide(reopened) outside an open settled member";
  if (s.outcome === "pending" && !s.open && s.closedUndecided && !has(out, "decideClosed")) return "closed pending member without decide(closed)";
  // not reconciled => an obligation, or the pending-closed member waiting on nothing but its decision
  if (!reconciled(s) && out.length === 0 && !(s.outcome === "pending" && !s.open)) return "unreconciled without obligation";
  return "ok";
}

function verificationCheck(s: VerificationSituation, out: readonly Spec<VerificationKind>[]): "ok" | "stall" | string {
  if (s.claim !== "none" && has(out, "postMerge")) return "guard violated: postMerge with a pending claim";
  if (has(out, "postMerge") && !gateNeeded(s.postMerge)) return "postMerge over a valid verdict";
  if (violations(VERIFICATION_CONSTRAINTS, s).length > 0) return "inconsistent";
  if (verificationPassed(s) || out.length > 0) return "ok";
  // a `correction` decision waits for its draft's createIssue effect (derived agenda-wide), then a member is pending
  if (s.failDecision === "correction") return "ok";
  return "uncovered";
}

function closureCheck(s: ClosureSituation, out: readonly Spec<ClosureKind>[]): "ok" | "stall" | string {
  if (s.claim !== "none" && has(out, "closure")) return "guard violated: closure with a pending claim";
  if (has(out, "closeParent") && s.closure !== "validPass") return "closeParent without a valid pass";
  if (violations(CLOSURE_CONSTRAINTS, s).length > 0) return "inconsistent";
  if (closureDone(s) || out.length > 0 || !s.allUnitsTerminal || s.strandedDesign) return "ok";
  // a `correction` (补项) decision waits for its draft's createIssue effect, which re-opens the agenda
  if (s.failDecision === "correction") return "ok";
  return "uncovered";
}

describe("rule layer: exhaustive enumeration (core.md §6.1)", () => {
  test("MemberSituation", () => {
    sweep("MemberSituation", memberDomain, MEMBER_KINDS, memberRules, memberCheck);
  }, 600_000);
  test("ReconcileSituation", () => {
    sweep("ReconcileSituation", reconcileDomain, RECONCILE_KINDS, reconcileRules, reconcileCheck);
  });
  test("VerificationSituation", () => {
    sweep("VerificationSituation", verificationDomain, VERIFICATION_KINDS, verificationRules, verificationCheck);
  });
  test("ClosureSituation", () => {
    sweep("ClosureSituation", closureDomain, CLOSURE_KINDS, closureRules, closureCheck);
  });
  test("SubjectSituation", () => {
    sweep("SubjectSituation", subjectDomain, SUBJECT_KINDS, subjectRules, (s, out) => (s.decided === "none" && out.length === 0 ? "undecided subject without obligation" : "ok"));
  });
  test("EffectSituation", () => {
    sweep("EffectSituation", effectDomain, EFFECT_KINDS, effectRules, (s, out) => {
      if (s.fulfilled && out.length > 0) return "fulfilled effect still derived";
      // a conflict the main session resolved without a new replacement leaves nothing to do; derive's stall covers it
      if (!s.fulfilled && out.length === 0 && !effectWaiting(s) && s.conflict !== "resolved") return "unfulfilled effect neither derived nor waiting";
      if (s.conflict !== "none" && has(out, "execute")) return "execution over a body-replacement conflict";
      if (s.failure === "unadjudicated" && has(out, "execute")) return "execution not paused after an unadjudicated failure";
      if (s.failure === "external" && has(out, "execute")) return "execution during an external decision";
      return "ok";
    });
  });
  test("SeatSlotSituation", () => {
    sweep("SeatSlotSituation", seatDomain, SEAT_KINDS, seatRules, (s, out) => {
      if (s.needed && (s.seat === "absent" || s.seat === "pendingAck") && !has(out, "spawn")) return "needed seat not spawned";
      if (s.seat === "pendingAck" && !has(out, "spawn")) return "pending agent without a receipt obligation";
      if (s.needed && s.seat === "parked" && !has(out, "wake")) return "needed parked seat not woken";
      if ((s.seat === "live" || s.seat === "parkedWoken") && out.length > 0) return "live or already-woken seat given a seat obligation";
      if (!s.needed && s.seat !== "pendingAck" && out.length > 0) return "unneeded seat acted on";
      return "ok";
    });
  });
});
