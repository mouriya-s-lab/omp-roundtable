// core.md §6.2 抽象层: every Situation in a systematic subset gets two structurally different concrete Snapshots
// (γ1, γ2); both must classify to exactly that Situation, and derive must realize exactly the rules' obligations.

import { describe, expect, test } from "bun:test";
import { canonical, derive, memberRules, reconcileRules, verificationRules, type Derived, type Spec } from "../src/core/index.ts";
import type { MemberSituation, ReconcileSituation, VerificationSituation } from "../src/core/index.ts";
import type { Classified } from "../src/core/classify.ts";
import { memberDomain, reconcileDomain, verificationDomain } from "./support/domains.ts";
import { MEMBER_CONSTRAINTS, RECONCILE_CONSTRAINTS, VERIFICATION_CONSTRAINTS, violations } from "./support/consistency.ts";
import {
  memberGamma,
  reconcileGamma,
  reconcileRecipes,
  verificationGamma,
  verificationRecipes,
  VARIANTS,
  type Built,
  type ReconcileRecipe,
  type Variant,
  type VerificationRecipe,
} from "./support/gamma.ts";
import { enumerate, systematicSubset } from "./support/product.ts";
import { policy } from "./support/world.ts";

const MEMBER_KINDS = ["decideClaim", "deliver", "noticeForeignPr", "decideFindings", "fix", "designFix", "decideChecks", "review", "accept", "merge"];
const RECONCILE_KINDS = ["close", "reopen", "decideReopened", "decideClosed"];
const VERIFICATION_KINDS = ["decideClaim", "postMerge", "decidePostMergeFail"];

const specKey = (specs: readonly Spec<string>[]): string => specs.map((s) => `${s.kind}/${s.holder}`).sort().join(",");

interface Outcome {
  readonly cases: number;
  readonly built: number;
  readonly infeasible: Map<string, number>;
  readonly failures: string[];
}

/**
 * For each target: γ1 and γ2 must both be built (or both infeasible for the same reason), classify to the target,
 * and derive the rules' obligations (kind and holder) in the target's context.
 */
function check<T>(
  targets: Iterable<T>,
  gamma: (t: T, v: Variant) => Built,
  situationOf: (c: Classified) => T | null,
  realized: (d: Derived, v: Variant) => string,
  rules: (t: T) => string,
): Outcome {
  const infeasible = new Map<string, number>();
  const failures: string[] = [];
  let cases = 0;
  let built = 0;
  for (const t of targets) {
    cases++;
    const results = VARIANTS.map((v) => ({ v, b: gamma(t, v) }));
    const [first] = results;
    if (first !== undefined && first.b.kind === "infeasible") {
      infeasible.set(first.b.reason, (infeasible.get(first.b.reason) ?? 0) + 1);
      continue;
    }
    built++;
    for (const { v, b } of results) {
      if (b.kind === "infeasible") {
        failures.push(`${v.name} infeasible (${b.reason}) for ${canonical(t)}`);
        continue;
      }
      const d = derive(b.snap, b.host, policy);
      const got = situationOf(d.classified);
      if (canonical(got) !== canonical(t)) {
        failures.push(`${v.name} classified ${canonical(got)}\n   wanted ${canonical(t)}`);
        continue;
      }
      const want = rules(t);
      const have = realized(d, v);
      if (want !== have) failures.push(`${v.name} realized [${have}] but rules give [${want}] for ${canonical(t)}`);
    }
  }
  return { cases, built, infeasible, failures };
}

function reportOutcome(name: string, o: Outcome): void {
  console.log(`[abstraction] ${name}: ${o.cases} cases, ${o.built} constructed ×2 (γ1, γ2), ${o.cases - o.built} not constructible, ${o.failures.length} failures`);
  for (const [reason, n] of o.infeasible) console.log(`  not constructible ×${n}: ${reason}`);
  for (const f of o.failures.slice(0, 15)) console.log(`  FAIL ${f}`);
}

const ctxOf = (v: Variant): string => `${v.repo.owner}/${v.repo.name}#${v.member}`;
const realizedIn = (kinds: readonly string[], context: (v: Variant) => string) => (d: Derived, v: Variant): string =>
  d.obligations
    .filter((o) => o.context === context(v) && kinds.includes(o.kind))
    .map((o) => `${o.kind}/${o.holder}`)
    .sort()
    .join(",");

describe("abstraction layer (core.md §6.2)", () => {
  test("MemberSituation: baseline, every single dimension, claim × ours × review × accept × materialized", () => {
    const baseline: MemberSituation = {
      designOnly: false,
      claim: "none",
      ours: "maintainable",
      foreign: false,
      foreignNoticed: false,
      materialized: "settled",
      review: "none",
      accept: "none",
      repairOwner: false,
      repairMain: false,
      mergeable: "yes",
      checks: "pass",
      checksRunFixed: false,
      checksDecided: "none",
      deliverDone: true,
      fixDone: false,
      externalBlock: false,
    };
    // the combination axes of the assignment, plus those that make each claimed-infeasible value constructible elsewhere
    const subset = systematicSubset(memberDomain, baseline, ["claim", "ours", "review", "accept", "materialized"]);
    const o = check(subset, memberGamma, (c) => c.member?.s ?? null, realizedIn(MEMBER_KINDS, ctxOf), (t) => specKey(memberRules(t)));
    reportOutcome("MemberSituation", o);
    expect(o.failures).toEqual([]);
    // every non-constructible value is one the consistency constraints rule out (checked against classify by the model checker)
    for (const reason of o.infeasible.keys()) expect(MEMBER_CONSTRAINTS.some((c) => reason.includes(c.name))).toBe(true);
  });

  test("ReconcileSituation: baseline, every single dimension, outcome × open × reopenDecision × closedDecision", () => {
    const recipes = new Map<string, ReconcileRecipe>();
    for (const r of reconcileRecipes()) {
      const b = reconcileGamma(r, VARIANTS[0]);
      if (b.kind === "infeasible") continue;
      const c = derive(b.snap, b.host, policy).classified.reconcile.find((x) => x.w.member.number === VARIANTS[0].member);
      if (c !== undefined && !recipes.has(canonical(c.s))) recipes.set(canonical(c.s), r);
    }
    const baseline: ReconcileSituation = {
      outcome: "delivered",
      open: false,
      neverClosedSinceOutcome: false,
      reopenUndecided: false,
      reopenDecision: "none",
      closedUndecided: false,
      closedDecision: "none",
      unitPostMergePass: false,
    };
    const subset = systematicSubset(reconcileDomain, baseline, ["outcome", "open", "reopenDecision", "closedDecision"]);
    const o = check(
      subset,
      (t, v) => {
        const r = recipes.get(canonical(t));
        if (r !== undefined) return reconcileGamma(r, v);
        const broken = violations(RECONCILE_CONSTRAINTS, t);
        return { kind: "infeasible", reason: broken.length > 0 ? broken.join("; ") : "no recipe produces it" };
      },
      (c) => c.reconcile.find((x) => x.w.member.number === VARIANTS[0].member || x.w.member.number === VARIANTS[1].member)?.s ?? null,
      realizedIn(RECONCILE_KINDS, ctxOf),
      (t: ReconcileSituation) => specKey(reconcileRules(t)),
    );
    reportOutcome("ReconcileSituation", o);
    console.log(`  recipe search reached ${recipes.size} of ${[...enumerate(reconcileDomain)].length} ReconcileSituation values`);
    expect(o.failures).toEqual([]);
    expect(o.infeasible.get("no recipe produces it") ?? 0).toBe(0);
  });

  test("VerificationSituation: every value", () => {
    const recipes = new Map<string, VerificationRecipe>();
    for (const r of verificationRecipes()) {
      const b = verificationGamma(r, VARIANTS[0]);
      if (b.kind === "infeasible") continue;
      const v = derive(b.snap, b.host, policy).classified.verification;
      if (v !== null && !recipes.has(canonical(v.s))) recipes.set(canonical(v.s), r);
    }
    const o = check(
      enumerate(verificationDomain),
      (t: VerificationSituation, v) => {
        const r = recipes.get(canonical(t));
        if (r !== undefined) return verificationGamma(r, v);
        const broken = violations(VERIFICATION_CONSTRAINTS, t);
        return { kind: "infeasible", reason: broken.length > 0 ? broken.join("; ") : "no recipe produces it" };
      },
      (c) => c.verification?.s ?? null,
      realizedIn(VERIFICATION_KINDS, (v) => `verify:${ctxOf(v)}`),
      (t) => specKey(verificationRules(t)),
    );
    reportOutcome("VerificationSituation", o);
    expect(o.failures).toEqual([]);
    // every consistent value is constructed
    expect(o.infeasible.get("no recipe produces it") ?? 0).toBe(0);
  });
});
