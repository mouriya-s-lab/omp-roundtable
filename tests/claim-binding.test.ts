import { describe, expect, test } from "bun:test";
import { derive, step, type Decision, type Hash, type IssueRef, type MemberSituation, type Obligation, type PendingClaim, type StepEvent, type Transition } from "../src/core/index.ts";
import { memberGamma, VARIANTS, verificationGamma, type Built, type VerificationRecipe } from "./support/gamma.ts";
import { ms, policy } from "./support/world.ts";

type BuiltWorld = Extract<Built, { kind: "built" }>;

type ClaimScenario = BuiltWorld & {
  readonly pending: PendingClaim;
  readonly obligation: Obligation;
  readonly member: IssueRef;
  readonly bodyHash: Hash;
};

const ready: MemberSituation = {
  designOnly: false,
  claim: "none",
  ours: "maintainable",
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

const expectRejected = (transition: Transition, reason: string): void => {
  expect(transition.kind).toBe("rejected");
  if (transition.kind === "rejected") expect(transition.reason).toContain(reason);
};

const expectNext = (transition: Transition): void => {
  expect(transition.kind).toBe("next");
};

function builtMember(claim: "question" | "noCode"): BuiltWorld {
  const result = memberGamma({ ...ready, claim }, VARIANTS[0]);
  if (result.kind === "infeasible") throw new Error(result.reason);
  return result;
}

function memberClaimScenario(claim: "question" | "noCode"): ClaimScenario {
  const world = builtMember(claim);
  const pending = world.state.claims.at(-1);
  if (pending === undefined) throw new Error("expected a pending claim");
  const obligation = derive(world.state, world.facts, world.host, policy).obligations.find((o) => o.kind === "decideClaim");
  if (obligation === undefined) throw new Error("expected a decideClaim obligation");
  const member = world.state.members[0]?.issue;
  if (member === undefined) throw new Error("expected a member");
  const bodyHash = world.facts.issues.find((issue) => issue.ref.number === member.number)?.bodyHash;
  if (bodyHash === undefined) throw new Error("expected the member body hash");
  return { ...world, pending, obligation, member, bodyHash };
}

const verificationRecipe: VerificationRecipe = {
  correction: "none",
  mOutcome: "delivered",
  mClosed: false,
  claim: true,
  verdict: "none",
  failDecision: "none",
};

function verificationClaimScenario(): ClaimScenario {
  const result = verificationGamma(verificationRecipe, VARIANTS[0]);
  if (result.kind === "infeasible") throw new Error(result.reason);
  const pending = result.state.claims.at(-1);
  if (pending === undefined) throw new Error("expected a pending verification claim");
  const obligation = derive(result.state, result.facts, result.host, policy).obligations.find((o) => o.kind === "decideClaim");
  if (obligation === undefined) throw new Error("expected a decideClaim obligation");
  const member = result.state.members[0]?.issue;
  if (member === undefined) throw new Error("expected a member");
  const bodyHash = result.facts.issues.find((issue) => issue.ref.number === member.number)?.bodyHash;
  if (bodyHash === undefined) throw new Error("expected the member body hash");
  return { ...result, pending, obligation, member, bodyHash };
}

function decisionEvent(obligation: Obligation, decision: Decision): StepEvent {
  return {
    kind: "reply",
    caller: { kind: "main" },
    reply: { kind: "decision", obligation: obligation.id, decision, rationale: "r", drafts: [], bodyReplacements: [] },
    live: { branchHead: null, branchContains: [] },
    at: ms(50_000),
  };
}

describe("step claim binding", () => {
  test("rejects a noCode claim answered for a different member", () => {
    const scenario = memberClaimScenario("noCode");
    const otherMember: IssueRef = { ...scenario.member, number: scenario.member.number + 1 };
    const decision: Decision = {
      subject: "noCodeClaim",
      claim: scenario.pending.id,
      member: otherMember,
      bodyHash: scenario.bodyHash,
      verdict: "confirmed",
    };

    expectRejected(step(scenario.state, scenario.facts, scenario.host, policy, decisionEvent(scenario.obligation, decision)), "member");
  });

  test("rejects a noCode claim answered with a stale body hash", () => {
    const scenario = memberClaimScenario("noCode");
    const decision: Decision = {
      subject: "noCodeClaim",
      claim: scenario.pending.id,
      member: scenario.member,
      bodyHash: "stale-body-hash" as Hash,
      verdict: "confirmed",
    };

    expectRejected(step(scenario.state, scenario.facts, scenario.host, policy, decisionEvent(scenario.obligation, decision)), "bodyHash");
  });

  test("accepts a noCode claim answered for its member and current body hash", () => {
    const scenario = memberClaimScenario("noCode");
    const decision: Decision = {
      subject: "noCodeClaim",
      claim: scenario.pending.id,
      member: scenario.member,
      bodyHash: scenario.bodyHash,
      verdict: "confirmed",
    };

    expectNext(step(scenario.state, scenario.facts, scenario.host, policy, decisionEvent(scenario.obligation, decision)));
  });

  test("rejects a question claim answered with noCodeClaim", () => {
    const scenario = memberClaimScenario("question");
    const decision: Decision = {
      subject: "noCodeClaim",
      claim: scenario.pending.id,
      member: scenario.member,
      bodyHash: scenario.bodyHash,
      verdict: "confirmed",
    };

    expectRejected(step(scenario.state, scenario.facts, scenario.host, policy, decisionEvent(scenario.obligation, decision)), "subject");
  });

  test("rejects implDefect for a unitVerification question", () => {
    const scenario = verificationClaimScenario();
    const decision: Decision = {
      subject: "question",
      claim: scenario.pending.id,
      verdict: { kind: "implDefect" },
      affected: [],
    };

    expectRejected(step(scenario.state, scenario.facts, scenario.host, policy, decisionEvent(scenario.obligation, decision)), "implDefect");
  });

  test("accepts answered for a unitVerification question", () => {
    const scenario = verificationClaimScenario();
    const decision: Decision = {
      subject: "question",
      claim: scenario.pending.id,
      verdict: { kind: "answered" },
      affected: [],
    };

    expectNext(step(scenario.state, scenario.facts, scenario.host, policy, decisionEvent(scenario.obligation, decision)));
  });
});
