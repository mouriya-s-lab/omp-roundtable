// core.md §6.2 抽象层. Every consistent value of ReconcileSituation, VerificationSituation and ClosureSituation, and
// for MemberSituation a systematic cover plus a fixed-seed random sample of consistent values, gets two structurally
// different concrete inputs (γ1, γ2: agenda state and GitHub facts). Both must classify to exactly that value, and derive must realize exactly
// the rules' obligations for it. A value is only left out when it breaks a named constraint (support/consistency.ts).

import { describe, expect, test } from "bun:test";
import {
  canonical,
  closureRules,
  derive,
  memberRules,
  reconcileRules,
  verificationRules,
  type Derived,
  type Spec,
} from "../src/core/index.ts";
import type { ClosureSituation, MemberSituation, ReconcileSituation, VerificationSituation } from "../src/core/index.ts";
import type { Classified } from "../src/core/classify.ts";
import { closureDomain, memberDomain, reconcileDomain, verificationDomain } from "./support/domains.ts";
import {
  CLOSURE_CONSTRAINTS,
  MEMBER_CONSTRAINTS,
  RECONCILE_CONSTRAINTS,
  VERIFICATION_CONSTRAINTS,
  violations,
  type Constraint,
} from "./support/consistency.ts";
import {
  closureGamma,
  memberGamma,
  reconcileGamma,
  searchReconcile,
  verificationGamma,
  verificationRecipes,
  VARIANTS,
  type Built,
  type Variant,
  type VerificationRecipe,
} from "./support/gamma.ts";
import { domainSize, enumerate, systematicSubset, valueAt, type Domain } from "./support/product.ts";
import { policy } from "./support/world.ts";

const specKey = (specs: readonly Spec<string>[]): string => specs.map((s) => `${s.kind}/${s.holder}`).sort().join(",");

interface Layer<T> {
  readonly gamma: (t: T, v: Variant) => Built;
  readonly situationOf: (c: Classified, v: Variant) => T | null;
  /** Obligations derive realized in the target's context, as `kind/holder`, sorted. */
  readonly realized: (d: Derived, v: Variant) => string;
  readonly rules: (t: T) => string;
}

interface Tally {
  checked: number;
  constructed: number;
  failures: string[];
}

/** γ1 and γ2 of one consistent target: both built, both classify to it, both realize its rules. */
function checkTarget<T>(t: T, layer: Layer<T>, tally: Tally): void {
  tally.checked++;
  let ok = true;
  for (const v of VARIANTS) {
    const b = layer.gamma(t, v);
    if (b.kind === "infeasible") {
      tally.failures.push(`${v.name}: consistent value not constructible (${b.reason}): ${canonical(t)}`);
      ok = false;
      continue;
    }
    const d = derive(b.state, b.facts, b.host, policy);
    const got = layer.situationOf(d.classified, v);
    if (canonical(got) !== canonical(t)) {
      tally.failures.push(`${v.name} classified ${canonical(got)}\n     wanted ${canonical(t)}`);
      ok = false;
      continue;
    }
    const have = layer.realized(d, v);
    const want = layer.rules(t);
    if (have !== want) {
      tally.failures.push(`${v.name} realized [${have}] but rules give [${want}] for ${canonical(t)}`);
      ok = false;
    }
  }
  if (ok) tally.constructed++;
}

/** Consistent count and per-constraint exclusion counts over a whole domain. */
function census<T>(domain: Domain<T>, constraints: readonly Constraint<T>[]): { consistent: T[]; excluded: number; byConstraint: Map<string, number> } {
  const consistent: T[] = [];
  const byConstraint = new Map<string, number>();
  let excluded = 0;
  for (const t of enumerate(domain)) {
    const broken = violations(constraints, t);
    if (broken.length === 0) consistent.push(t);
    else {
      excluded++;
      for (const b of broken) byConstraint.set(b, (byConstraint.get(b) ?? 0) + 1);
    }
  }
  return { consistent, excluded, byConstraint };
}

function printCensus(name: string, size: number, consistent: number, excluded: number, byConstraint: Map<string, number>, tally: Tally): void {
  console.log(
    `[abstraction] ${name}: domain ${size}, consistent ${consistent}, excluded by constraint ${excluded}; ` +
      `checked ${tally.checked}, constructed ×2 (γ1, γ2) ${tally.constructed}, failures ${tally.failures.length}`,
  );
  for (const [c, n] of byConstraint) console.log(`  excluded: ${n} values break «${c}»`);
  for (const f of tally.failures.slice(0, 15)) console.log(`  FAIL ${f}`);
}

const ctxOf = (v: Variant): string => `${v.repo.owner}/${v.repo.name}#${v.member}`;
const realizedIn = (kinds: readonly string[], context: (v: Variant) => string) => (d: Derived, v: Variant): string =>
  d.obligations
    .filter((o) => o.context === context(v) && kinds.includes(o.kind))
    .map((o) => `${o.kind}/${o.holder}`)
    .sort()
    .join(",");

const MEMBER_KINDS = ["decideClaim", "deliver", "decideFindings", "fix", "designFix", "decideChecks", "review", "accept", "merge"];
const RECONCILE_KINDS = ["close", "reopen", "decideReopened", "decideClosed"];
const VERIFICATION_KINDS = ["decideClaim", "postMerge", "decidePostMergeFail"];
const CLOSURE_KINDS = ["decideClaim", "closure", "decideClosureFail", "closeParent", "reopenParent", "report"];

const memberLayer: Layer<MemberSituation> = {
  gamma: memberGamma,
  situationOf: (c) => c.member?.s ?? null,
  realized: realizedIn(MEMBER_KINDS, ctxOf),
  rules: (t) => specKey(memberRules(t)),
};

/** Deterministic LCG (fixed seed) so the sample is the same on every run. */
function sampler(seed: number): () => number {
  let x = seed;
  return () => {
    x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
    return x / 0x80000000;
  };
}

const MEMBER_SAMPLE = 5_000;
const MEMBER_SEED = 20_260_929;

describe("abstraction layer (core.md §6.2)", () => {
  test("MemberSituation: systematic cover and a fixed-seed random sample of consistent values", () => {
    const { byConstraint, excluded } = census(memberDomain, MEMBER_CONSTRAINTS);
    const size = domainSize(memberDomain);
    const baseline: MemberSituation = {
      designOnly: false,
      claim: "none",
      ours: "maintainable",
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
    const systematic = systematicSubset(memberDomain, baseline, ["claim", "ours", "review", "accept", "materialized"]).filter(
      (t) => violations(MEMBER_CONSTRAINTS, t).length === 0,
    );
    const cover: Tally = { checked: 0, constructed: 0, failures: [] };
    for (const t of systematic) checkTarget(t, memberLayer, cover);
    const sample: Tally = { checked: 0, constructed: 0, failures: [] };
    const next = sampler(MEMBER_SEED);
    const seen = new Set<string>();
    while (sample.checked < MEMBER_SAMPLE) {
      const t = valueAt(memberDomain, Math.floor(next() * size));
      const k = canonical(t);
      if (seen.has(k) || violations(MEMBER_CONSTRAINTS, t).length > 0) continue;
      seen.add(k);
      checkTarget(t, memberLayer, sample);
    }
    printCensus("MemberSituation systematic cover", size, size - excluded, excluded, byConstraint, cover);
    console.log(
      `[abstraction] MemberSituation random sample (seed ${MEMBER_SEED}): checked ${sample.checked} distinct consistent values, ` +
        `constructed ×2 (γ1, γ2) ${sample.constructed}, failures ${sample.failures.length}`,
    );
    for (const f of sample.failures.slice(0, 15)) console.log(`  FAIL ${f}`);
    expect(cover.failures).toEqual([]);
    expect(sample.failures).toEqual([]);
    expect(cover.constructed).toBe(cover.checked);
    expect(sample.constructed).toBe(MEMBER_SAMPLE);
  }, 300_000);

  test("ReconcileSituation: every consistent value", () => {
    const { consistent, excluded, byConstraint } = census(reconcileDomain, RECONCILE_CONSTRAINTS);
    const histories = searchReconcile(6);
    const tally: Tally = { checked: 0, constructed: 0, failures: [] };
    const layer: Layer<ReconcileSituation> = {
      gamma: (t, v) => {
        const h = histories.get(canonical(t));
        return h === undefined ? { kind: "infeasible", reason: "no history up to 6 steps classifies to it" } : reconcileGamma(h, v);
      },
      situationOf: (c, v) => c.reconcile.find((x) => x.w.member.number === v.member)?.s ?? null,
      realized: realizedIn(RECONCILE_KINDS, ctxOf),
      rules: (t) => specKey(reconcileRules(t)),
    };
    for (const t of consistent) checkTarget(t, layer, tally);
    // the history search must never reach a value the constraints call inconsistent (that would make a constraint false)
    const falseExclusions = [...histories.keys()].filter((k) => violations(RECONCILE_CONSTRAINTS, JSON.parse(k) as ReconcileSituation).length > 0);
    printCensus("ReconcileSituation", domainSize(reconcileDomain), consistent.length, excluded, byConstraint, tally);
    expect(falseExclusions).toEqual([]);
    expect(tally.failures).toEqual([]);
    expect(tally.constructed).toBe(consistent.length);
  }, 120_000);

  test("VerificationSituation: every consistent value", () => {
    const { consistent, excluded, byConstraint } = census(verificationDomain, VERIFICATION_CONSTRAINTS);
    const recipes = new Map<string, VerificationRecipe>();
    for (const r of verificationRecipes()) {
      const b = verificationGamma(r, VARIANTS[0]);
      if (b.kind === "infeasible") continue;
      const v = derive(b.state, b.facts, b.host, policy).classified.verification;
      if (v !== null && !recipes.has(canonical(v.s))) recipes.set(canonical(v.s), r);
    }
    const tally: Tally = { checked: 0, constructed: 0, failures: [] };
    const layer: Layer<VerificationSituation> = {
      gamma: (t, v) => {
        const r = recipes.get(canonical(t));
        return r === undefined ? { kind: "infeasible", reason: "no recipe classifies to it" } : verificationGamma(r, v);
      },
      situationOf: (c) => c.verification?.s ?? null,
      realized: realizedIn(VERIFICATION_KINDS, (v) => `verify:${ctxOf(v)}`),
      rules: (t) => specKey(verificationRules(t)),
    };
    for (const t of consistent) checkTarget(t, layer, tally);
    const falseExclusions = [...recipes.keys()].filter((k) => violations(VERIFICATION_CONSTRAINTS, JSON.parse(k) as VerificationSituation).length > 0);
    printCensus("VerificationSituation", domainSize(verificationDomain), consistent.length, excluded, byConstraint, tally);
    expect(falseExclusions).toEqual([]);
    expect(tally.failures).toEqual([]);
    expect(tally.constructed).toBe(consistent.length);
  });

  test("ClosureSituation: every consistent value", () => {
    const { consistent, excluded, byConstraint } = census(closureDomain, CLOSURE_CONSTRAINTS);
    const tally: Tally = { checked: 0, constructed: 0, failures: [] };
    const layer: Layer<ClosureSituation> = {
      gamma: closureGamma,
      situationOf: (c) => c.closure.s,
      realized: realizedIn(CLOSURE_KINDS, () => "closure"),
      rules: (t) => specKey(closureRules(t)),
    };
    for (const t of consistent) checkTarget(t, layer, tally);
    printCensus("ClosureSituation", domainSize(closureDomain), consistent.length, excluded, byConstraint, tally);
    expect(tally.failures).toEqual([]);
    expect(tally.constructed).toBe(consistent.length);
  });
});
