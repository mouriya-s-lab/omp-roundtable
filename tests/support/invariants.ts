// AG invariants for the model checker (core.md §6.4), checked on concrete facts and state where possible.

import { canonical, memberGateGuard, verdictFails, type Derived } from "../../src/core/index.ts";
import type { Invariant } from "./explore.ts";
import { CLOSURE_CONSTRAINTS, MEMBER_CONSTRAINTS, RECONCILE_CONSTRAINTS, VERIFICATION_CONSTRAINTS, violations } from "./consistency.ts";
import { MEMBER_STALLS } from "./stalls.ts";
import type { IssueRef, Sha } from "../../src/core/index.ts";
import type { World } from "./world.ts";

export const invariants: readonly { readonly name: string; readonly check: Invariant }[] = [
  {
    name: "guard: no review/accept/merge while the member guard holds",
    check: (_n, d) => {
      const m = d.classified.member;
      if (m === null || !memberGateGuard(m.s)) return null;
      const bad = d.obligations.filter((o) => o.kind === "review" || o.kind === "accept" || o.kind === "merge");
      return bad.length === 0 ? null : `guard ${canonical(m.s)} but ${bad.map((o) => o.kind).join(",")}`;
    },
  },
  {
    name: "classified situations satisfy the consistency constraints",
    check: (_n, d) => {
      const c = d.classified;
      const bad = [
        ...(c.member === null ? [] : violations(MEMBER_CONSTRAINTS, c.member.s).map((v) => `member: ${v} ${canonical(c.member?.s ?? null)}`)),
        ...(c.verification === null ? [] : violations(VERIFICATION_CONSTRAINTS, c.verification.s).map((v) => `verification: ${v}`)),
        ...violations(CLOSURE_CONSTRAINTS, c.closure.s).map((v) => `closure: ${v}`),
        ...c.reconcile.flatMap((r) => violations(RECONCILE_CONSTRAINTS, r.s).map((v) => `reconcile: ${v} ${canonical(r.s)}`)),
      ];
      return bad.length === 0 ? null : bad.join("; ");
    },
  },
  {
    name: "decide(stall) only in an enumerated stall",
    check: (_n, d) => {
      if (!d.obligations.some((o) => o.kind === "decideStall" && o.context === "agenda" && o.id === d.classified.stall.id)) return null;
      const m = d.classified.member;
      return m !== null && MEMBER_STALLS.some((x) => x.holds(m.s)) ? null : `stall outside the enumerated list: member=${canonical(m?.s ?? null)} verification=${canonical(d.classified.verification?.s ?? null)} closure=${canonical(d.classified.closure.s)}`;
    },
  },
  {
    name: "no merge on stale or invalid gates",
    check: (n, d) => mergeViolation(n.world, d),
  },
];

/** Checked on concrete facts and the state's gate slots, independent of classify's gate evaluation. */
function mergeViolation(w: World, d: Derived): string | null {
  const merge = d.obligations.find((o) => o.kind === "merge");
  if (merge === undefined || merge.action === null || merge.action.kind !== "merge") return null;
  const m = d.classified.member;
  if (m === null || m.w.pr === null) return "merge without an active member PR";
  const pr = w.facts.prs.find((p) => p.ref.number === m.w.pr?.ref.number);
  if (pr === undefined || pr.state.kind !== "open") return "merge of a PR that is not open";
  if (merge.action.head !== pr.head) return `merge head ${merge.action.head} != PR head ${pr.head}`;
  if (pr.mergeable !== "yes" || pr.checks.state !== "pass") return `merge with mergeable=${pr.mergeable} checks=${pr.checks.state}`;
  const ms = w.state.members.find((x) => x.issue.number === m.w.entry.issue.number);
  const passFor = (gate: "review" | "accept"): boolean => {
    const want = gate === "review" ? m.w.reviewManifest : m.w.acceptManifest;
    const slot = ms === undefined ? null : gate === "review" ? ms.review : ms.accept;
    const v = slot?.verdict ?? null;
    return v !== null && slot !== null && v.attempt === slot.attempt && !verdictFails(v.verdict) && canonical(v.manifest) === canonical(want) && "head" in v.manifest && v.manifest.head === pr.head;
  };
  if (!passFor("review")) return "merge without a passing review verdict on the current pin";
  if (!passFor("accept")) return "merge without a passing accept verdict on the current pin";
  if (w.state.claims.length > 0) return "merge while a claim is undecided";
  const missing = missingDesignCommits(w, m.w.entry.issue, pr.head);
  return missing.length === 0 ? null : `merge of head ${pr.head} missing design commits ${missing.join(",")}`;
}

/**
 * Design commits decided for `member` (designFix, designGap withPr carried by it) that are neither on the default branch
 * nor in `head`. Computed from the state, independently of classify; also part of the explorer's state key so that
 * worlds differing only in this hidden fact are not merged.
 */
export function missingDesignCommits(w: World, member: IssueRef, head: Sha): string[] {
  const contained = new Set<string>([head]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of w.facts.commits.contains)
      if (contained.has(c.descendant) && !contained.has(c.ancestor)) {
        contained.add(c.ancestor);
        grew = true;
      }
  }
  const same = (a: IssueRef | null): boolean => a !== null && a.number === member.number && a.repo.owner === member.repo.owner && a.repo.name === member.repo.name;
  const required: string[] = [
    ...(w.state.members.find((m) => same(m.issue))?.designFixes.map((d) => d.commit) ?? []),
    ...w.state.contracts.flatMap((c) => c.routes.filter((r) => r.route.kind === "withPr" && same(r.carrier)).map((r) => r.route.commit)),
  ];
  const onDefault = new Set<string>(w.facts.commits.onDefault.map((c) => c.sha));
  return required.filter((s) => !onDefault.has(s) && !contained.has(s));
}
