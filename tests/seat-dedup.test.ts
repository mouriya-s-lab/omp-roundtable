import { describe, expect, test } from "bun:test";
import { derive, step, type AgentId, type Derived, type Host, type MemberSituation, type Obligation, type RegisteredAgent, type Sha, type StepEvent, type Transition } from "../src/core/index.ts";
import { memberGamma, VARIANTS, type Built } from "./support/gamma.ts";
import { ms, policy } from "./support/world.ts";

type BuiltWorld = Extract<Built, { kind: "built" }>;

type AgentStatus = RegisteredAgent["status"];

const requestName = "rt-sandbox-11-owner";
const firstAgent = requestName as AgentId;
const secondAgent = `${requestName}-2` as AgentId;

const ownerPending: MemberSituation = {
  designOnly: false,
  claim: "none",
  ours: "none",
  materialized: "settled",
  review: "none",
  accept: "none",
  repairOwner: false,
  repairMain: false,
  mergeable: "unknown",
  checks: "unknown",
  checksRunFixed: false,
  checksDecided: "none",
  deliverDone: false,
  fixDone: false,
  externalBlock: false,
};

function world(): BuiltWorld {
  const built = memberGamma(ownerPending, VARIANTS[0]);
  if (built.kind === "infeasible") throw new Error(built.reason);
  return built;
}

function agent(id: AgentId, status: AgentStatus = "live"): RegisteredAgent {
  return { id, requestName, status, parkedSince: null };
}

function host(agents: readonly RegisteredAgent[]): Host {
  return { agents, failures: [] };
}

function withHolder(state: BuiltWorld["state"], holder: AgentId): BuiltWorld["state"] {
  return { ...state, seats: [{ requestName, holder }] };
}

function spawnObligations(derived: Derived): Obligation[] {
  return derived.obligations.filter((obligation) => obligation.kind === "spawn");
}

function onlySpawn(derived: Derived): Obligation {
  const spawns = spawnObligations(derived);
  expect(spawns).toHaveLength(1);
  const spawn = spawns[0];
  if (spawn === undefined) throw new Error("expected one spawn obligation");
  return spawn;
}

function seatedEvent(obligation: Obligation, agentId: AgentId, previous: AgentId | null): StepEvent {
  return {
    kind: "reply",
    caller: { kind: "main" },
    reply: {
      kind: "decision",
      obligation: obligation.id,
      decision: { subject: "seated", requestName, previous, agentId },
      rationale: "test",
      drafts: [],
      bodyReplacements: [],
    },
    live: { branchHead: null, branchContains: [] },
    at: ms(10),
  };
}

function expectNext(transition: Transition): Extract<Transition, { kind: "next" }> {
  expect(transition.kind).toBe("next");
  if (transition.kind !== "next") throw new Error(`expected next, got ${transition.kind}`);
  return transition;
}

function expectRejected(transition: Transition, reason: string): void {
  expect(transition.kind).toBe("rejected");
  if (transition.kind === "rejected") expect(transition.reason).toContain(reason);
}

function ownerDeliver(derived: Derived): Obligation {
  const deliver = derived.obligations.find((obligation) => obligation.kind === "deliver" && obligation.holder === "owner");
  if (deliver === undefined) throw new Error("expected an owner deliver obligation");
  return deliver;
}

describe("seat deduplication", () => {
  test("selects one pending agent when two live agents share an owner request name", () => {
    const current = world();
    const derived = derive(current.state, current.facts, host([agent(firstAgent), agent(secondAgent)]), policy);
    const spawn = onlySpawn(derived);
    const seat = derived.classified.seats.find((candidate) => candidate.w.requestName === requestName);

    expect(seat).toMatchObject({ state: "pendingAck", w: { requestName, pending: firstAgent, holder: null, spawnId: spawn.id } });
    expect(spawn.brief).toContain(`"agentId": "${firstAgent}"`);
    expect(spawn.brief).not.toContain(`"agentId": "${secondAgent}"`);
  });

  test("does not spawn another acknowledgement after the selected agent is seated", () => {
    const current = world();
    const agents = host([agent(firstAgent), agent(secondAgent)]);
    const initial = derive(current.state, current.facts, agents, policy);
    const spawn = onlySpawn(initial);
    const seated = expectNext(step(current.state, current.facts, agents, policy, seatedEvent(spawn, firstAgent, null)));
    const holder = seated.state.seats.find((seat) => seat.requestName === requestName);

    expect(seated.state.seats).toHaveLength(1);
    expect(holder).toEqual({ requestName, holder: firstAgent });
    expect(spawnObligations(derive(seated.state, current.facts, agents, policy))).toHaveLength(0);

    const wrongCandidate = world();
    const wrongInitial = derive(wrongCandidate.state, wrongCandidate.facts, agents, policy);
    const wrongSpawn = onlySpawn(wrongInitial);
    expectRejected(step(wrongCandidate.state, wrongCandidate.facts, agents, policy, seatedEvent(wrongSpawn, secondAgent, null)), "待回执");
  });

  test("selects the next live agent when the recorded holder is aborted", () => {
    const current = world();
    const state = withHolder(current.state, firstAgent);
    const agents = host([agent(firstAgent, "aborted"), agent(secondAgent)]);
    const derived = derive(state, current.facts, agents, policy);
    const spawn = onlySpawn(derived);
    const seat = derived.classified.seats.find((candidate) => candidate.w.requestName === requestName);

    expect(seat).toMatchObject({ state: "pendingAck", w: { requestName, pending: secondAgent, holder: firstAgent, spawnId: spawn.id } });
    expect(spawn.brief).toContain(`"agentId": "${secondAgent}"`);

    const seated = expectNext(step(state, current.facts, agents, policy, seatedEvent(spawn, secondAgent, firstAgent)));
    expect(seated.state.seats).toEqual([{ requestName, holder: secondAgent }]);
    expect(spawnObligations(derive(seated.state, current.facts, agents, policy))).toHaveLength(0);
  });

  test("rejects owner work from a live same-name non-holder", () => {
    const current = world();
    const state = withHolder(current.state, firstAgent);
    const agents = host([agent(firstAgent), agent(secondAgent)]);
    const derived = derive(state, current.facts, agents, policy);
    const deliver = ownerDeliver(derived);
    const submit = {
      kind: "prSubmit" as const,
      obligation: deliver.id,
      branch: "feature",
      head: "feature-head" as Sha,
      title: "title",
      body: "body",
      template: "fourLayer" as const,
      retryNote: null,
    };

    const acceptedByHolder = step(state, current.facts, agents, policy, {
      kind: "reply",
      caller: { kind: "sub", agentId: firstAgent, sessionMatches: true },
      reply: submit,
      live: { branchHead: submit.head, branchContains: [] },
      at: ms(10),
    });
    expectNext(acceptedByHolder);

    const rejected = step(state, current.facts, agents, policy, {
      kind: "reply",
      caller: { kind: "sub", agentId: secondAgent, sessionMatches: true },
      reply: submit,
      live: { branchHead: submit.head, branchContains: [] },
      at: ms(10),
    });
    expectRejected(rejected, "持有者");
  });
});
