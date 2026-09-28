// core.md §6.3 模型检查: bounded BFS over concrete worlds; AG invariants and EF(delivery complete).

import { describe, expect, test } from "bun:test";
import { canonical } from "../src/core/index.ts";
import { canReach, explore, trace, type Exploration, type Node } from "./support/explore.ts";
import { invariants } from "./support/invariants.ts";
import { initialWorld, type AgendaSpec, type World } from "./support/world.ts";

function report(name: string, x: Exploration): { unreachable: Node[]; stalls: Node[] } {
  const reach = canReach(x.nodes, (n) => n.derived?.done === true);
  const expanded = x.nodes.filter((n) => n.derived !== null);
  const unreachable = expanded.filter((n) => !reach.has(n.id));
  // enumerated stalls are legal (checked by an invariant); counted for the report
  const stalls = expanded.filter((n) => n.derived?.obligations.some((o) => o.kind === "decideStall") === true);
  const doneCount = expanded.filter((n) => n.derived?.done === true).length;
  console.log(
    `[model] ${name}: ${x.nodes.length} states (${expanded.length} expanded${x.truncated ? ", TRUNCATED" : ""}), ${x.edges} edges, ${doneCount} done, ` +
      `${x.violations.length} AG violations, ${unreachable.length} without a path to done, ${stalls.length} states in an enumerated stall, ${x.rejections.length} rejected replies`,
  );
  const shown = new Set<string>();
  for (const v of x.violations) {
    if (shown.has(v.property)) continue;
    shown.add(v.property);
    console.log(`  AG violated: ${v.property}: ${v.detail}\n${trace(x.nodes, v.node).join("\n")}`);
  }
  const firstUnreachable = [...unreachable].sort((a, b) => a.depth - b.depth)[0];
  if (firstUnreachable !== undefined) console.log(`  EF(done) fails; shortest counterexample:\n${trace(x.nodes, firstUnreachable.id).join("\n")}\n  successors: ${firstUnreachable.succ.map((s) => s.label).join(" | ") || "(none)"}`);
  const reasons = new Map<string, number>();
  for (const r of x.rejections) reasons.set(`${r.label} — ${r.reason}`, (reasons.get(`${r.label} — ${r.reason}`) ?? 0) + 1);
  for (const [k, v] of reasons) console.log(`  rejected ×${v}: ${k}`);
  return { unreachable, stalls };
}

/** Edge labels (variant names, no ids) seen across all explorations, for the coverage assertion at the end. */
const labelsSeen = new Set<string>();

function check(name: string, spec: AgendaSpec, maxNodes: number): void {
  const x = explore(initialWorld(spec), invariants, maxNodes);
  for (const n of x.nodes) for (const s of n.succ) labelsSeen.add(s.label);
  const r = report(name, x);
  expect(x.truncated).toBe(false);
  expect(x.violations.map((v) => `${v.property}: ${v.detail}`)).toEqual([]);
  expect(x.rejections.map((v) => `${v.label}: ${v.reason}`)).toEqual([]);
  expect(r.unreachable.map((n) => n.id)).toEqual([]);
}

const zero = { perturb: 0, fail: 0, claim: 0, draft: 0 };
// Budgets bound the explored graph (core.md §6.3 "bounded"). Each profile spends one kind of budget so every edge kind
// is explored from every reachable state of the protocol, while the state space stays finite and exhaustively expanded.
const profiles: readonly { readonly name: string; readonly budget: AgendaSpec["budget"] }[] = [
  { name: "gate/check/effect failures", budget: { ...zero, fail: 1 } },
  { name: "claims and draft-inserting decisions", budget: { ...zero, claim: 1, draft: 1 } },
  { name: "perturbations", budget: { ...zero, perturb: 1 } },
];
// Corrections need a failing postMerge/closure or a human reopen before the draft: explored on a one-unit agenda with a parent.
const correctionProfiles: readonly { readonly name: string; readonly budget: AgendaSpec["budget"] }[] = [
  { name: "failures + corrections", budget: { ...zero, fail: 1, draft: 1 } },
  { name: "perturbations + corrections", budget: { ...zero, perturb: 1, draft: 1 } },
];

describe("model checking (core.md §6.3)", () => {
  for (const p of profiles) {
    test(`convened single-member agenda — ${p.name}`, () => {
      check(`single member, ${p.name}`, { members: [11], parent: null, outsideChild: false, budget: p.budget }, 100_000);
    }, 1_800_000);
  }
  for (const p of correctionProfiles) {
    test(`single-member agenda with a parent — ${p.name}`, () => {
      check(`single member + parent, ${p.name}`, { members: [11], parent: 5, outsideChild: false, budget: p.budget }, 100_000);
    }, 1_800_000);
  }
  test("two-unit agenda with a parent and an out-of-agenda child — no budget", () => {
    check("two units + parent (and a child outside the agenda), no budget", { members: [11, 12], parent: 5, outsideChild: true, budget: zero }, 100_000);
  }, 1_800_000);
  for (const p of profiles) {
    test(`two-unit agenda with a parent — ${p.name}`, () => {
      check(`two units + parent, ${p.name}`, { members: [11, 12], parent: 5, outsideChild: false, budget: p.budget }, 100_000);
    }, 1_800_000);
  }
  test("every edge kind of core.md §6.3 was explored", () => {
    const families = new Map<string, number>();
    for (const l of labelsSeen) families.set(l.split(":")[0] ?? l, (families.get(l.split(":")[0] ?? l) ?? 0) + 1);
    console.log(`[model] ${labelsSeen.size} distinct edge labels: ${[...labelsSeen].sort().join(" | ")}`);
    const required = [
      // replies: every reply variant the explored obligations admit
      "deliver: prSubmit(new head)", "fix: prSubmit(new head)", "fix: prSubmit(same head)",
      "deliver: claim(question)", "deliver: claim(noCode)", "deliver: claim(split)", "deliver: claim(blocked)",
      "review: pass", "review: fail", "review: claim(question)", "accept: pass", "accept: fail", "accept: pass+unrelated",
      "postMerge: pass", "postMerge: fail", "postMerge: claim(question)", "closure: pass", "closure: fail", "closure: claim(question)",
      "decideClaim: answered", "decideClaim: outOfDomain", "decideClaim: implDefect", "decideClaim: designGap(withPr)", "decideClaim: acceptanceMethod",
      "decideClaim: confirmed", "decideClaim: refuted", "decideClaim: confirmed(before)", "decideClaim: confirmed(after)",
      "decideClaim: replacePr", "decideClaim: external",
      "decideFindings: upheld(owner)", "decideFindings: upheld(main)", "decideFindings: rejected", "decideFindings: outOfScope",
      "decideFindings: designGap(withPr)", "decideFindings: acceptanceMethod", "designFix: commit",
      "decideChecks: rerun", "decideChecks: fixNeeded", "decideChecks: external",
      "decideReopened: restore", "decideReopened: correction", "decideClosed: confirmedNoCode", "decideClosed: reopen",
      "decidePostMergeFail: reverify", "decidePostMergeFail: correction", "decideClosureFail: reverify", "decideClosureFail: correction",
      "decide:unrelated: unrelated", "decide:agendaGap: resolved", "decide:agendaGap: external",
      "decideEffectFailed: retry", "decideEffectFailed: external", "decideStall: external", "report: summary",
      "spawn: seated", "wake: woken",
      // program effects, including failures
      "effect openPr", "effect updatePr", "effect applyBody", "effect createIssue", "effect noticeDecision", "effect rerunChecks",
      "effect closeAgenda", "effect attachAgenda", "effect openPr fails", "noticeForeignPr",
      "merge (issue auto-closed)", "merge (no auto-close)", "program close", "program reopen", "program closeParent",
      // perturbations and fairness
      "perturb: push new head", "perturb: member body edited", "perturb: human close member", "perturb: human reopen member",
      "perturb: checks -> fail", "perturb: mergeable -> no", "perturb: seat parked", "perturb: seat aborted", "perturb: PR closed unmerged",
      "settle: checks -> pass", "settle: checks -> fail", "settle: mergeable -> yes", "settle: mergeable -> no",
      "restart (execution failures forgotten)",
    ];
    expect(required.filter((r) => ![...labelsSeen].some((l) => l === r || l.startsWith(`${r} `) || l.startsWith(`${r}(`)))).toEqual([]);
  });
});
