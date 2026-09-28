// core.md §3 守卫: a pending claim holds back merge even when both gates passed on the current pin
// (issue #2 acceptance row 5: deleting the claim clause of memberGateGuard must make this fail).

import { describe, expect, test } from "bun:test";
import { derive } from "../src/core/index.ts";
import type { MemberSituation } from "../src/core/index.ts";
import { memberGamma, VARIANTS } from "./support/gamma.ts";
import { policy } from "./support/world.ts";

const ready: MemberSituation = {
  designOnly: false,
  claim: "none",
  ours: "maintainable",
  foreign: false,
  foreignNoticed: false,
  materialized: "settled",
  review: "validPass",
  accept: "validPass",
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

function kindsFor(s: MemberSituation): string[] {
  const b = memberGamma(s, VARIANTS[0]);
  if (b.kind !== "built") throw new Error(b.reason);
  const d = derive(b.snap, b.host, policy);
  expect(d.classified.member?.s).toEqual(s);
  return d.obligations.map((o) => o.kind);
}

describe("guard: pending claim blocks merge", () => {
  test("two validPass verdicts, mergeable, checks pass, no claim ⇒ merge", () => {
    expect(kindsFor(ready)).toContain("merge");
  });

  for (const claim of ["question", "noCode", "split", "blocked"] as const) {
    test(`pending ${claim} claim + two validPass ⇒ no merge, Main decide(claim)`, () => {
      const kinds = kindsFor({ ...ready, claim });
      expect(kinds).not.toContain("merge");
      expect(kinds).toContain("decideClaim");
    });
  }
});
