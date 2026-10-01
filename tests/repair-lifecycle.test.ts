import { describe, expect, test } from "bun:test";
import {
  bodyHash,
  convene,
  derive,
  replyId,
  step,
  type AgendaId,
  type AgendaState,
  type AgentId,
  type Caller,
  type DeliveryTarget,
  type Facts,
  type FindingVerdict,
  type Host,
  type IssueFact,
  type IssueRef,
  type LiveFacts,
  type Millis,
  type Obligation,
  type ObligationId,
  type PrFact,
  type PrRef,
  type Reply,
  type Sha,
  type StoredVerdict,
  type StepEvent,
  type Transition,
} from "../src/core/index.ts";

const repo = { owner: "lab", name: "sandbox" };
const target: DeliveryTarget = { repo, base: "main" };
const policy = {
  appendSystem: "APPEND",
  systemBlocks: "BLOCKS",
  seatAgents: { owner: "task:high", gate: "task:mid" },
};
const noLive: LiveFacts = { branchHead: null, branchContains: [] };

const sha = (value: string): Sha => value as Sha;
const at = (value: number): Millis => value as Millis;
const issueRef = (number: number): IssueRef => ({ repo, number });
const prRef = (number: number): PrRef => ({ repo, number });
const contextOf = (issue: IssueRef): string => `${issue.repo.owner}/${issue.repo.name}#${issue.number}`;

interface Scenario {
  readonly state: AgendaState;
  readonly facts: Facts;
  readonly host: Host;
  readonly clock: number;
}

function issue(number: number, body = `issue-${number}`, open = true): IssueFact {
  return {
    ref: issueRef(number),
    open,
    events: [],
    bodyHash: bodyHash(body),
    children: [],
  };
}

function pr(
  number: number,
  head: Sha,
  body: string,
  over: Partial<PrFact> = {},
): PrFact {
  return {
    ref: prRef(number),
    state: { kind: "open" },
    headBranch: "feature",
    head,
    target,
    closes: [issueRef(1)],
    bodyHash: bodyHash(body),
    mergeable: "yes",
    checks: { state: "pass", failedRunId: null },
    ...over,
  };
}

function adoptedScenario(): Scenario {
  const adopted = pr(11, sha("head-1"), "pr-1");
  const state = convene("repair-lifecycle" as AgendaId, at(1), null, [
    { issue: issueRef(1), target, designOnly: false, adoptPr: adopted.ref },
  ]);
  return {
    state,
    facts: {
      issues: [issue(1)],
      prs: [adopted],
      links: [adopted],
      commits: { onDefault: [{ repo, sha: sha("base") }], contains: [], baseHead: [{ repo, base: "main", sha: sha("base") }] },
    },
    host: { agents: [], failures: [] },
    clock: 10,
  };
}

function emptyDeliveryScenario(): Scenario {
  const state = convene("repair-lifecycle-empty" as AgendaId, at(1), null, [
    { issue: issueRef(1), target, designOnly: false, adoptPr: null },
  ]);
  return {
    state,
    facts: {
      issues: [issue(1)],
      prs: [],
      links: [],
      commits: { onDefault: [{ repo, sha: sha("base") }], contains: [], baseHead: [{ repo, base: "main", sha: sha("base") }] },
    },
    host: { agents: [], failures: [] },
    clock: 10,
  };
}

function memberOf(s: Scenario) {
  const member = s.state.members[0];
  if (member === undefined) throw new Error("test fixture has no member");
  return member;
}

function derived(s: Scenario) {
  return derive(s.state, s.facts, s.host, policy);
}

function oneObligation(s: Scenario, kind: string, predicate: (obligation: Obligation) => boolean = () => true): Obligation {
  const matches = derived(s).obligations.filter((obligation) => obligation.kind === kind && predicate(obligation));
  expect(matches).toHaveLength(1);
  const result = matches[0];
  if (result === undefined) throw new Error(`missing ${kind} obligation`);
  return result;
}

function callerFor(s: Scenario, obligation: Obligation): Caller {
  if (obligation.holder === "main") return { kind: "main" };
  const requestName = obligation.seat?.requestName;
  if (requestName === undefined) throw new Error(`${obligation.kind} has no seat`);
  const holder = s.state.seats.find((seat) => seat.requestName === requestName)?.holder;
  if (holder === undefined || holder === null) throw new Error(`seat ${requestName} has no holder`);
  return { kind: "sub", agentId: holder, sessionMatches: true };
}

function replyEvent(s: Scenario, caller: Caller, reply: Reply, live: LiveFacts = noLive): StepEvent {
  return { kind: "reply", caller, reply, live, at: at(s.clock + 1) };
}

function expectNext(transition: Transition): AgendaState {
  expect(transition.kind).toBe("next");
  if (transition.kind !== "next") throw new Error(`expected next, got ${transition.kind}`);
  return transition.state;
}

function acceptReply(s: Scenario, caller: Caller, reply: Reply, live: LiveFacts = noLive): Scenario {
  const event = replyEvent(s, caller, reply, live);
  const next = expectNext(step(s.state, s.facts, s.host, policy, event));
  expect(step(next, s.facts, s.host, policy, event).kind).toBe("same");
  return { ...s, state: next, clock: s.clock + 1 };
}

function acceptEffect(s: Scenario, effect: ObligationId, result: Extract<StepEvent, { kind: "effectDone" }>['result']): Scenario {
  const event: StepEvent = { kind: "effectDone", effect, result };
  const next = expectNext(step(s.state, s.facts, s.host, policy, event));
  expect(step(next, s.facts, s.host, policy, event).kind).toBe("same");
  return { ...s, state: next };
}

function rejectReply(s: Scenario, caller: Caller, reply: Reply, live: LiveFacts): Transition {
  const transition = step(s.state, s.facts, s.host, policy, replyEvent(s, caller, reply, live));
  expect(transition.kind).toBe("rejected");
  return transition;
}

function addLiveAgent(s: Scenario, requestName: string): Scenario {
  if (s.host.agents.some((agent) => agent.id === requestName && agent.status === "live")) return s;
  return {
    ...s,
    host: {
      ...s.host,
      agents: [...s.host.agents, { id: requestName as AgentId, requestName, status: "live", parkedSince: null }],
    },
  };
}

/** Seat every currently needed owner/gate obligation using derive + a real seated reply. */
function ensureSeats(scenario: Scenario): Scenario {
  let s = scenario;
  for (let i = 0; i < 12; i++) {
    const d = derived(s);
    const unseated = d.obligations.find((obligation) => {
      const requestName = obligation.seat?.requestName;
      if (requestName === undefined) return false;
      const record = s.state.seats.find((seat) => seat.requestName === requestName);
      return record?.holder === undefined || record.holder === null || !s.host.agents.some((agent) => agent.id === record.holder && agent.status === "live");
    });
    if (unseated === undefined || unseated.seat === null) return s;
    const requestName = unseated.seat.requestName;
    s = addLiveAgent(s, requestName);
    const afterAgent = derived(s);
    const seat = afterAgent.classified.seats.find((candidate) => candidate.w.requestName === requestName);
    if (seat === undefined) throw new Error(`missing classified seat ${requestName}`);
    const spawn = afterAgent.obligations.find((obligation) => obligation.id === seat.w.spawnId);
    if (spawn === undefined) throw new Error(`missing spawn obligation for ${requestName}`);
    const previous = s.state.seats.find((record) => record.requestName === requestName)?.holder ?? null;
    s = acceptReply(s, { kind: "main" }, {
      kind: "decision",
      obligation: spawn.id,
      decision: { subject: "seated", requestName, previous, agentId: requestName as AgentId },
      rationale: "seat",
      drafts: [],
      bodyReplacements: [],
    });
  }
  throw new Error("seat setup did not converge");
}

function withFacts(s: Scenario, facts: Facts): Scenario {
  return { ...s, facts };
}

function replacePr(s: Scenario, ref: PrRef, update: (current: PrFact) => PrFact): Scenario {
  const current = s.facts.prs.find((candidate) => candidate.ref.number === ref.number && candidate.ref.repo.owner === ref.repo.owner && candidate.ref.repo.name === ref.repo.name);
  if (current === undefined) throw new Error(`missing PR ${ref.number}`);
  return withFacts(s, { ...s.facts, prs: s.facts.prs.map((candidate) => (candidate === current ? update(current) : candidate)) });
}

function addPr(s: Scenario, added: PrFact): Scenario {
  return withFacts(s, { ...s.facts, prs: [...s.facts.prs, added], links: [...s.facts.links, added] });
}

function addContains(s: Scenario, ancestor: Sha, descendant: Sha): Scenario {
  return withFacts(s, { ...s.facts, commits: { ...s.facts.commits, contains: [...s.facts.commits.contains, { repo, ancestor, descendant }] } });
}

function currentMemberSituation(s: Scenario) {
  const member = derived(s).classified.member;
  if (member === null) throw new Error("expected active member");
  return member;
}

function currentGate(s: Scenario, kind: "review" | "accept"): Obligation {
  return oneObligation(s, kind, (obligation) => obligation.context === contextOf(issueRef(1)));
}

function gateVerdict(s: Scenario, kind: "review" | "accept", ok: boolean): Scenario {
  const obligation = currentGate(s, kind);
  return acceptReply(s, callerFor(s, obligation), { kind: "verdict", obligation: obligation.id, ok, note: ok ? "pass" : "finding" });
}

function findings(s: Scenario, verdict: FindingVerdict): Scenario {
  const member = currentMemberSituation(s);
  const pending = member.w.unadjudicated;
  if (pending === null) throw new Error("expected an unadjudicated gate finding");
  const obligation = oneObligation(s, "decideFindings");
  return acceptReply(s, { kind: "main" }, {
    kind: "decision",
    obligation: obligation.id,
    decision: { subject: "findings", verdictId: pending.id, verdict },
    rationale: "r",
    drafts: [],
    bodyReplacements: [],
  });
}

function submit(s: Scenario, obligation: Obligation, head: Sha, body: string, liveContains: readonly Sha[] = []): Scenario {
  return acceptReply(s, callerFor(s, obligation), {
    kind: "prSubmit",
    obligation: obligation.id,
    branch: "feature",
    head,
    title: "delivery",
    body,
    template: "fourLayer",
    retryNote: null,
  }, { branchHead: head, branchContains: liveContains });
}

function initialSubmit(scenario: Scenario, head: Sha, body: string, number = 11): Scenario {
  let s = ensureSeats(scenario);
  const deliver = oneObligation(s, "deliver");
  s = submit(s, deliver, head, body);
  const effect = oneObligation(s, "effect:openPr");
  const materialized = pr(number, head, body);
  s = addPr(s, materialized);
  return acceptEffect(s, effect.id, { kind: "prApplied", pr: materialized.ref });
}

function updateFactsHead(s: Scenario, ref: PrRef, head: Sha, body: string): Scenario {
  return replacePr(s, ref, (current) => ({ ...current, head, bodyHash: bodyHash(body), mergeable: "yes", checks: { state: "pass", failedRunId: null } }));
}

function completePrUpdate(s: Scenario): Scenario {
  const effect = oneObligation(s, "effect:updatePr");
  const action = effect.action;
  if (action?.kind !== "effect" || action.target.kind !== "updatePr") throw new Error("expected updatePr effect");
  if (action.target.pr === null) throw new Error("updatePr fixture has no PR");
  return acceptEffect(s, effect.id, { kind: "prApplied", pr: action.target.pr });
}

function repairCycle(scenario: Scenario, gate: "review" | "accept", normalLatestSubmit: boolean): Scenario {
  let s = normalLatestSubmit ? initialSubmit(emptyDeliveryScenario(), sha("head-1"), "pr-1") : ensureSeats(scenario);
  s = ensureSeats(s);
  if (gate === "accept") s = gateVerdict(s, "review", true);
  s = gateVerdict(s, gate, false);
  s = findings(s, { kind: "upheld", responsible: "owner" });
  s = ensureSeats(s);
  const beforePush = currentMemberSituation(s);
  expect(beforePush.s.repairOwner).toBe(true);
  const fixBeforePush = oneObligation(s, "fix");
  const beforeAttempt = memberOf(s).review.attempt;
  const beforeAcceptAttempt = memberOf(s).accept.attempt;
  const oldPr = beforePush.w.pr;
  if (oldPr === null) throw new Error("owner repair fixture lost its PR");
  const newHead = sha(`${gate}-head-2`);
  s = updateFactsHead(s, oldPr.ref, newHead, "pr-2");
  const afterPush = currentMemberSituation(s);
  const fixAfterPush = oneObligation(s, "fix");
  expect(fixAfterPush.id).toBe(fixBeforePush.id);
  expect(afterPush.s.repairOwner).toBe(true);
  expect(derived(s).obligations.some((obligation) => obligation.kind === "review" || obligation.kind === "accept" || obligation.kind === "merge")).toBe(false);
  const staleBefore = memberOf(s);
  const rejected = rejectReply(s, callerFor(s, fixAfterPush), {
    kind: "prSubmit",
    obligation: fixAfterPush.id,
    branch: "feature",
    head: newHead,
    title: "delivery",
    body: "pr-2",
    template: "fourLayer",
    retryNote: null,
  }, { branchHead: sha("wrong-live-head"), branchContains: [] });
  expect(rejected.kind).toBe("rejected");
  expect(memberOf(s)).toEqual(staleBefore);
  expect(memberOf(s).review.attempt).toBe(beforeAttempt);
  expect(memberOf(s).accept.attempt).toBe(beforeAcceptAttempt);
  s = submit(s, fixAfterPush, newHead, "pr-2");
  const afterSubmit = currentMemberSituation(s);
  expect(afterSubmit.s.repairOwner).toBe(false);
  expect(afterSubmit.s.materialized).toBe("pending");
  expect(derived(s).obligations.some((obligation) => obligation.kind === "fix")).toBe(false);
  s = completePrUpdate(s);
  const afterApplied = currentMemberSituation(s);
  expect(afterApplied.s.repairOwner).toBe(false);
  expect(afterApplied.s.materialized).toBe("settled");
  expect(memberOf(s).review.attempt).toBe(beforeAttempt + (gate === "review" ? 1 : 0));
  expect(memberOf(s).accept.attempt).toBe(beforeAcceptAttempt + (gate === "accept" ? 1 : 0));
  const repairedSlot = memberOf(s)[gate];
  expect(repairedSlot.verdict?.adjudication).toEqual({ kind: "upheld", responsible: "owner" });
  expect(repairedSlot.verdict?.attempt).toBe(gate === "review" ? beforeAttempt : beforeAcceptAttempt);
  expect(repairedSlot.attempt).toBe((gate === "review" ? beforeAttempt : beforeAcceptAttempt) + 1);
  expect(derived(s).obligations.some((obligation) => obligation.kind === "fix")).toBe(false);
  return s;
}

describe("repair lifecycle through convene/derive/step", () => {
  for (const normalLatestSubmit of [false, true]) {
    for (const gate of ["review", "accept"] as const) {
      test(`${normalLatestSubmit ? "latest submit" : "adopted submit:null"} ${gate} upheld(owner) repairs symmetrically`, () => {
        repairCycle(adoptedScenario(), gate, normalLatestSubmit);
      });
    }
  }

  test("initial PrSubmit materialization blocks gates until the PR is applied", () => {
    let s = ensureSeats(emptyDeliveryScenario());
    const deliver = oneObligation(s, "deliver");
    const head = sha("new-head");
    s = submit(s, deliver, head, "new-pr");
    const pending = currentMemberSituation(s);
    expect(memberOf(s).submit?.applied).toBe(false);
    expect(pending.s.materialized).toBe("pending");
    expect(derived(s).obligations.some((obligation) => obligation.kind === "review" || obligation.kind === "accept" || obligation.kind === "merge")).toBe(false);
    const effect = oneObligation(s, "effect:openPr");
    const prFact = pr(11, head, "new-pr");
    s = addPr(s, prFact);
    s = acceptEffect(s, effect.id, { kind: "prApplied", pr: prFact.ref });
    expect(memberOf(s).submit?.applied).toBe(true);
    expect(currentMemberSituation(s).s.materialized).toBe("settled");
    s = ensureSeats(s);
    expect(derived(s).obligations.map((obligation) => obligation.kind)).toEqual(expect.arrayContaining(["review", "accept"]));
  });

  test("a source body replacement blocks gates until the source body is updated and applied", () => {
    let s = ensureSeats(adoptedScenario());
    s = gateVerdict(s, "review", false);
    const member = currentMemberSituation(s);
    const pending = member.w.unadjudicated;
    if (pending === null) throw new Error("expected review finding");
    const decide = oneObligation(s, "decideFindings");
    const sourceBody = "acceptance rows updated";
    const sourceIssue = member.w.issue;
    if (sourceIssue === null) throw new Error("body replacement fixture has no source issue");
    s = acceptReply(s, { kind: "main" }, {
      kind: "decision",
      obligation: decide.id,
      decision: { subject: "findings", verdictId: pending.id, verdict: { kind: "acceptanceMethod" } },
      rationale: "r",
      drafts: [],
      bodyReplacements: [{ issue: sourceIssue.ref, baseHash: sourceIssue.bodyHash, body: sourceBody }],
    });
    expect(currentMemberSituation(s).s.materialized).toBe("pending");
    expect(derived(s).obligations.some((obligation) => obligation.kind === "review" || obligation.kind === "accept" || obligation.kind === "merge")).toBe(false);
    const effect = oneObligation(s, "effect:applyBody");
    s = withFacts(s, {
      ...s.facts,
      issues: s.facts.issues.map((candidate) => (candidate.ref.number === 1 ? { ...candidate, bodyHash: bodyHash(sourceBody) } : candidate)),
    });
    s = acceptEffect(s, effect.id, { kind: "bodyApplied" });
    expect(currentMemberSituation(s).s.materialized).toBe("settled");
    s = ensureSeats(s);
    expect(derived(s).obligations.map((obligation) => obligation.kind)).toEqual(expect.arrayContaining(["review", "accept"]));
    expect(derived(s).obligations.some((obligation) => obligation.kind === "effect:applyBody")).toBe(false);
  });

  test("a main upheld finding takes the design-fix path before owner work and requires its commit", () => {
    let s = ensureSeats(adoptedScenario());
    s = gateVerdict(s, "review", false);
    s = findings(s, { kind: "upheld", responsible: "main" });
    const stalePr = currentMemberSituation(s).w.pr;
    if (stalePr === null) throw new Error("expected adopted PR");
    s = updateFactsHead(s, stalePr.ref, sha("main-stale-head"), "main-stale-body");
    const staleMain = currentMemberSituation(s);
    expect(staleMain.s.repairMain).toBe(true);
    expect(staleMain.s.repairOwner).toBe(false);
    expect(derived(s).obligations.map((obligation) => obligation.kind)).toContain("designFix");
    expect(derived(s).obligations.map((obligation) => obligation.kind)).not.toContain("fix");
    expect(derived(s).obligations.map((obligation) => obligation.kind)).not.toContain("deliver");
    const designObligation = oneObligation(s, "designFix");
    const designVerdict = staleMain.w.designFixVerdict;
    if (designVerdict === null) throw new Error("expected main design-fix verdict");
    const designCommit = sha("design-fix-1");
    s = acceptReply(s, { kind: "main" }, {
      kind: "decision",
      obligation: designObligation.id,
      decision: { subject: "designFix", verdictId: designVerdict.id, commit: designCommit },
      rationale: "r",
      drafts: [],
      bodyReplacements: [],
    });
    expect(currentMemberSituation(s).s.repairMain).toBe(false);
    expect(currentMemberSituation(s).s.repairOwner).toBe(true);
    const fix = oneObligation(s, "fix");
    const prNow = currentMemberSituation(s).w.pr;
    if (prNow === null) throw new Error("expected maintainable PR");
    const repairHead = sha("design-repair-head");
    s = updateFactsHead(s, prNow.ref, repairHead, "design-repair");
    s = ensureSeats(s);
    const missing = rejectReply(s, callerFor(s, fix), {
      kind: "prSubmit",
      obligation: fix.id,
      branch: "feature",
      head: repairHead,
      title: "delivery",
      body: "design-repair",
      template: "fourLayer",
      retryNote: null,
    }, { branchHead: repairHead, branchContains: [] });
    expect(missing.kind).toBe("rejected");
    expect(memberOf(s).review.attempt).toBe(1);
    expect(memberOf(s).accept.attempt).toBe(1);
    s = submit(s, fix, repairHead, "design-repair", [designCommit]);
    expect(currentMemberSituation(s).s.materialized).toBe("pending");
    s = addContains(s, designCommit, repairHead);
    s = completePrUpdate(s);
    expect(currentMemberSituation(s).s.repairOwner).toBe(false);
    expect(memberOf(s).review.attempt).toBe(2);
    expect(derived(s).obligations.some((obligation) => obligation.kind === "fix" || obligation.kind === "designFix")).toBe(false);
  });

  test("a rejected or out-of-scope finding advances the attempt without creating owner repair", () => {
    for (const verdict of [
      { kind: "rejected", basis: "not reproducible" } as const,
      { kind: "outOfScope", draft: { index: 0, repo, title: "split", body: "b", anchor: { kind: "outsideAgenda" }, target, designOnly: false } } as const,
    ]) {
      let s = ensureSeats(adoptedScenario());
      s = gateVerdict(s, "review", false);
      s = findings(s, verdict);
      expect(currentMemberSituation(s).s.repairOwner).toBe(false);
      expect(currentMemberSituation(s).s.repairMain).toBe(false);
      expect(derived(s).obligations.some((obligation) => obligation.kind === "fix" || obligation.kind === "designFix")).toBe(false);
      expect(memberOf(s).review.attempt).toBe(2);
      expect(memberOf(s).accept.attempt).toBe(1);
    }
  });

  test("a persisted boundary with owner and main repairs keeps only Main designFix until its commit is recorded", () => {
    let s = ensureSeats(adoptedScenario());
    s = gateVerdict(s, "review", false);
    s = findings(s, { kind: "upheld", responsible: "owner" });
    s = ensureSeats(s);
    const oldFix = oneObligation(s, "fix");
    const oldPr = currentMemberSituation(s).w.pr;
    if (oldPr === null) throw new Error("expected adopted PR");
    const movedHead = sha("boundary-new-head");
    s = updateFactsHead(s, oldPr.ref, movedHead, "boundary-new-body");

    // This is an explicit persisted boundary snapshot: old core versions could load
    // a current owner slot and a newly adjudicated main slot before owner submitted.
    const movedMember = currentMemberSituation(s);
    const acceptManifest = movedMember.w.acceptManifest;
    if (acceptManifest === null) throw new Error("expected accept manifest");
    const acceptTicket = movedMember.w.ids.accept;
    if (acceptTicket === null) throw new Error("expected accept ticket");
    const mainReply = { kind: "verdict" as const, obligation: acceptTicket, ok: false, note: "main finding" };
    const persistedMain: StoredVerdict = {
      id: replyId(acceptTicket, mainReply),
      ticket: acceptTicket,
      attempt: memberOf(s).accept.attempt,
      manifest: acceptManifest,
      verdict: { gate: "accept", ok: false, note: "main finding" },
      adjudication: { kind: "upheld", responsible: "main" },
      failDecision: null,
    };
    const persistedState: AgendaState = {
      ...s.state,
      members: s.state.members.map((member) => (member.issue.number === 1 ? { ...member, accept: { attempt: member.accept.attempt, verdict: persistedMain } } : member)),
    };
    s = { ...s, state: persistedState };

    const boundary = currentMemberSituation(s);
    expect(boundary.s.repairOwner).toBe(true);
    expect(boundary.s.repairMain).toBe(true);
    const memberKinds = derived(s).obligations.filter((obligation) => obligation.context === contextOf(issueRef(1))).map((obligation) => obligation.kind);
    expect(memberKinds).toContain("designFix");
    expect(memberKinds).not.toContain("fix");
    expect(memberKinds).not.toContain("deliver");
    expect(memberKinds).not.toContain("review");
    expect(memberKinds).not.toContain("accept");
    expect(memberKinds).not.toContain("merge");

    const oldReply: Reply = {
      kind: "prSubmit",
      obligation: oldFix.id,
      branch: "feature",
      head: movedHead,
      title: "delivery",
      body: "boundary-new-body",
      template: "fourLayer",
      retryNote: null,
    };
    const rejectedOldOwner = rejectReply(s, callerFor(s, oldFix), oldReply, { branchHead: movedHead, branchContains: [] });
    expect(rejectedOldOwner.kind).toBe("rejected");

    const designObligation = oneObligation(s, "designFix");
    const designVerdict = boundary.w.designFixVerdict;
    if (designVerdict === null) throw new Error("expected persisted main verdict");
    const designCommit = sha("boundary-design-fix");
    s = acceptReply(s, { kind: "main" }, {
      kind: "decision",
      obligation: designObligation.id,
      decision: { subject: "designFix", verdictId: designVerdict.id, commit: designCommit },
      rationale: "r",
      drafts: [],
      bodyReplacements: [],
    });
    expect(currentMemberSituation(s).s.repairMain).toBe(false);
    expect(currentMemberSituation(s).s.repairOwner).toBe(true);
    const currentFix = oneObligation(s, "fix");
    const repairHead = sha("boundary-repair-head");
    s = updateFactsHead(s, oldPr.ref, repairHead, "boundary-repair-body");
    const missingCommit = rejectReply(s, callerFor(s, currentFix), {
      kind: "prSubmit",
      obligation: currentFix.id,
      branch: "feature",
      head: repairHead,
      title: "delivery",
      body: "boundary-repair-body",
      template: "fourLayer",
      retryNote: null,
    }, { branchHead: repairHead, branchContains: [] });
    expect(missingCommit.kind).toBe("rejected");
    s = submit(s, currentFix, repairHead, "boundary-repair-body", [designCommit]);
    s = addContains(s, designCommit, repairHead);
    s = completePrUpdate(s);
    expect(memberOf(s).review.attempt).toBe(2);
    expect(memberOf(s).accept.attempt).toBe(2);
    expect(currentMemberSituation(s).s.repairOwner).toBe(false);
    expect(currentMemberSituation(s).s.repairMain).toBe(false);
    expect(derived(s).obligations.some((obligation) => obligation.kind === "fix" || obligation.kind === "designFix")).toBe(false);
  });

  test("upheld(main) survives a closed PR before designFix and the later delivery carries its recorded commit", () => {
    let s = ensureSeats(adoptedScenario());
    s = gateVerdict(s, "review", false);
    s = findings(s, { kind: "upheld", responsible: "main" });
    const designBeforeClose = oneObligation(s, "designFix");
    const beforeClose = currentMemberSituation(s);
    const mainVerdict = beforeClose.w.designFixVerdict;
    const oldPr = beforeClose.w.pr;
    if (mainVerdict === null || oldPr === null) throw new Error("expected Main finding on the adopted PR");
    const reviewAttempt = memberOf(s).review.attempt;
    const acceptAttempt = memberOf(s).accept.attempt;

    s = replacePr(s, oldPr.ref, (current) => ({ ...current, state: { kind: "closedUnmerged", closedAt: at(20) } }));
    const afterClose = currentMemberSituation(s);
    expect(afterClose.s.ours).toBe("none");
    expect(afterClose.s.repairMain).toBe(true);
    expect(afterClose.w.designFixVerdict?.id).toBe(mainVerdict.id);
    const designAfterClose = oneObligation(s, "designFix");
    expect(designAfterClose.id).toBe(designBeforeClose.id);
    expect(designAfterClose.holder).toBe("main");
    expect(derived(s).obligations.some((obligation) =>
      obligation.kind === "deliver" || obligation.kind === "fix" ||
      obligation.kind === "review" || obligation.kind === "accept" || obligation.kind === "merge"
    )).toBe(false);
    expect(memberOf(s).review.attempt).toBe(reviewAttempt);
    expect(memberOf(s).accept.attempt).toBe(acceptAttempt);

    const designCommit = sha("1111111111111111111111111111111111111111");
    s = acceptReply(s, { kind: "main" }, {
      kind: "decision",
      obligation: designAfterClose.id,
      decision: { subject: "designFix", verdictId: mainVerdict.id, commit: designCommit },
      rationale: "repair the upheld design finding",
      drafts: [],
      bodyReplacements: [],
    });
    expect(memberOf(s).designFixes).toEqual([{ verdictId: mainVerdict.id, commit: designCommit }]);
    expect(currentMemberSituation(s).s.repairMain).toBe(false);
    expect(currentMemberSituation(s).w.designCommits).toContain(designCommit);
    expect(derived(s).obligations.some((obligation) => obligation.kind === "designFix" || obligation.kind === "fix")).toBe(false);
    expect(memberOf(s).review.attempt).toBe(reviewAttempt);
    expect(memberOf(s).accept.attempt).toBe(acceptAttempt);

    s = ensureSeats(s);
    const deliver = oneObligation(s, "deliver");
    expect(deliver.holder).not.toBe("main");
    const deliveryHead = sha("2222222222222222222222222222222222222222");
    const beforeRejected = s.state;
    const missingCommit = rejectReply(s, callerFor(s, deliver), {
      kind: "prSubmit",
      obligation: deliver.id,
      branch: "feature",
      head: deliveryHead,
      title: "delivery",
      body: "closed-main-delivery",
      template: "fourLayer",
      retryNote: null,
    }, { branchHead: deliveryHead, branchContains: [] });
    if (missingCommit.kind !== "rejected") throw new Error("expected missing design commit rejection");
    expect(missingCommit.reason).toContain(designCommit);
    expect(s.state).toEqual(beforeRejected);
    expect(memberOf(s).review.attempt).toBe(reviewAttempt);
    expect(memberOf(s).accept.attempt).toBe(acceptAttempt);

    s = submit(s, deliver, deliveryHead, "closed-main-delivery", [designCommit]);
    expect(memberOf(s).review.attempt).toBe(reviewAttempt + 1);
    expect(memberOf(s).accept.attempt).toBe(acceptAttempt);
    expect(currentMemberSituation(s).s.materialized).toBe("pending");
    expect(memberOf(s).submit?.applied).toBe(false);
    const effect = oneObligation(s, "effect:openPr");
    const replacement = pr(12, deliveryHead, "closed-main-delivery");
    s = addPr(s, replacement);
    s = addContains(s, designCommit, deliveryHead);
    s = acceptEffect(s, effect.id, { kind: "prApplied", pr: replacement.ref });
    const delivered = currentMemberSituation(s);
    expect(delivered.w.pr?.ref).toEqual(replacement.ref);
    expect(delivered.s.materialized).toBe("settled");
    expect(delivered.s.repairMain).toBe(false);
    expect(delivered.s.repairOwner).toBe(false);
    expect(delivered.w.designCommits).toContain(designCommit);
    expect(memberOf(s).submit?.applied).toBe(true);
    expect(memberOf(s).submit?.appliedDesign).toContain(designCommit);
    expect(memberOf(s).review.verdict?.adjudication).toEqual({ kind: "upheld", responsible: "main" });
    expect(memberOf(s).review.verdict?.attempt).toBe(reviewAttempt);
    expect(derived(s).obligations.some((obligation) => obligation.kind === "deliver" || obligation.kind === "fix" || obligation.kind === "designFix")).toBe(false);
  });

  test("a designGap route on a closed or replaced PR goes to deliver and the next delivery carries its commit", () => {
    for (const mode of ["closed", "replaced"] as const) {
      let s = ensureSeats(adoptedScenario());
      s = gateVerdict(s, "review", false);
      const pending = currentMemberSituation(s).w.unadjudicated;
      if (pending === null) throw new Error("expected review finding");
      const designCommit = sha(`${mode}-design-commit`);
      const decide = oneObligation(s, "decideFindings");
      s = acceptReply(s, { kind: "main" }, {
        kind: "decision",
        obligation: decide.id,
        decision: {
          subject: "findings",
          verdictId: pending.id,
          verdict: { kind: "designGap", route: { kind: "withPr", commit: designCommit, designBranch: "design" } },
        },
        rationale: "r",
        drafts: [],
        bodyReplacements: [],
      });

      if (mode === "closed") {
        const prNow = currentMemberSituation(s).w.pr;
        if (prNow === null) throw new Error("expected adopted PR");
        s = replacePr(s, prNow.ref, (current) => ({ ...current, state: { kind: "closedUnmerged", closedAt: at(20) } }));
      } else {
        s = ensureSeats(s);
        const fix = oneObligation(s, "fix");
        s = acceptReply(s, callerFor(s, fix), {
          kind: "claim",
          obligation: fix.id,
          claim: { kind: "blocked", member: issueRef(1), category: "push rejected", attempts: "retry" },
        });
        const claimDecision = oneObligation(s, "decideClaim");
        const claimId = s.state.claims[0]?.id;
        if (claimId === undefined) throw new Error("expected blocked claim");
        s = acceptReply(s, { kind: "main" }, {
          kind: "decision",
          obligation: claimDecision.id,
          decision: { subject: "blockedClaim", claim: claimId, verdict: "replacePr" },
          rationale: "r",
          drafts: [],
          bodyReplacements: [],
        });
      }

      expect(currentMemberSituation(s).s.ours).toBe("none");
      expect(currentMemberSituation(s).s.repairMain).toBe(false);
      expect(derived(s).obligations.map((obligation) => obligation.kind)).toContain("deliver");
      expect(derived(s).obligations.map((obligation) => obligation.kind)).not.toContain("designFix");

      s = ensureSeats(s);
      const deliver = oneObligation(s, "deliver");
      const newHead = sha(`${mode}-delivery-head`);
      const rejected = rejectReply(s, callerFor(s, deliver), {
        kind: "prSubmit",
        obligation: deliver.id,
        branch: "feature-new",
        head: newHead,
        title: "delivery",
        body: "new-delivery",
        template: "fourLayer",
        retryNote: null,
      }, { branchHead: newHead, branchContains: [] });
      expect(rejected.kind).toBe("rejected");

      s = submit(s, deliver, newHead, "new-delivery", [designCommit]);
      expect(memberOf(s).submit?.applied).toBe(false);
      expect(currentMemberSituation(s).s.materialized).toBe("pending");
      const replacement = pr(mode === "closed" ? 12 : 13, newHead, "new-delivery");
      s = addPr(s, replacement);
      s = addContains(s, designCommit, newHead);
      const effect = oneObligation(s, "effect:openPr");
      s = acceptEffect(s, effect.id, { kind: "prApplied", pr: replacement.ref });
      expect(memberOf(s).submit?.applied).toBe(true);
      expect(currentMemberSituation(s).s.materialized).toBe("settled");
      expect(currentMemberSituation(s).w.designCommits).toContain(designCommit);
    }
  });
});
