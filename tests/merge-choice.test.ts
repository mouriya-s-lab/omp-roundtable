import { describe, expect, test } from "bun:test";
import { convene, outcomeOf, type AgendaId, type AgendaState, type Facts, type Hash, type Millis, type PrFact, type PrLink, type Sha } from "../src/core/index.ts";

const repo = { owner: "lab", name: "sandbox" };
const member = { repo, number: 11 };
const target = { repo, base: "main" };

const sha = (value: string): Sha => value as Sha;
const hash = (value: string): Hash => value as Hash;
const millis = (value: number): Millis => value as Millis;

function mergedLink(number: number, commit: string, mergedAt: number): PrLink {
  return {
    ref: { repo, number },
    state: { kind: "merged", mergeSha: sha(commit), mergedAt: millis(mergedAt) },
    headBranch: `pr-${number}`,
    head: sha(`head-${number}`),
    target,
    closes: [member],
  };
}

function registered(link: PrLink): PrFact {
  return { ...link, bodyHash: hash(`body-${link.ref.number}`), mergeable: "yes", checks: { state: "pass", failedRunId: null } };
}

function stateFor(pr: PrLink): AgendaState {
  return convene("merge-choice" as AgendaId, millis(1), null, [{ issue: member, target, designOnly: false, adoptPr: pr.ref }]);
}

function factsFor(prs: readonly PrFact[], links: readonly PrLink[]): Facts {
  return { issues: [], prs, links, commits: { onDefault: [], contains: [], baseHead: [] } };
}

function deliveredCommit(state: AgendaState, facts: Facts): Sha {
  const entry = state.convened[0];
  if (entry === undefined) throw new Error("test fixture has no convened entry");
  const outcome = outcomeOf(state, facts, entry);
  expect(outcome.kind).toBe("delivered");
  if (outcome.kind !== "delivered") throw new Error(`expected delivered outcome, got ${outcome.kind}`);
  return outcome.merge.commit;
}

describe("outcomeOf merged PR choice", () => {
  test("chooses the newer registered PR over an older link", () => {
    const olderLink = mergedLink(20, "older-link", 100);
    const newerRegistered = mergedLink(10, "newer-registered", 200);

    expect(deliveredCommit(stateFor(newerRegistered), factsFor([registered(newerRegistered)], [olderLink]))).toBe(sha("newer-registered"));
  });

  test("chooses a newer link over an older registered PR", () => {
    const olderRegistered = mergedLink(10, "older-registered", 100);
    const newerLink = mergedLink(20, "newer-link", 200);

    expect(deliveredCommit(stateFor(olderRegistered), factsFor([registered(olderRegistered)], [newerLink]))).toBe(sha("newer-link"));
  });

  test("breaks equal-time ties by canonical PR ref, not candidate order", () => {
    const lowerRef = mergedLink(10, "lower-ref", 200);
    const higherRef = mergedLink(20, "higher-ref", 200);

    const lowerRegistered = deliveredCommit(stateFor(lowerRef), factsFor([registered(lowerRef)], [higherRef]));
    const higherRegistered = deliveredCommit(stateFor(higherRef), factsFor([registered(higherRef)], [lowerRef]));

    expect(lowerRegistered).toBe(sha("lower-ref"));
    expect(higherRegistered).toBe(sha("lower-ref"));
  });
});
