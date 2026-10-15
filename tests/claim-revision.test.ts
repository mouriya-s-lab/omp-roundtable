import {createHash} from 'node:crypto';
import {describe, expect, test} from 'bun:test';
import {createAgenda, parsePortInput, tickets, transition} from '../src/domain/index.ts';
import type {Agenda, Caller, CaseDecision, DecisionCase, Event, Facts, HostSeat, Inputs, OwnerWork, ProtocolReply, ReplyResult, SeatRequest, Ticket, Transition} from '../src/domain/model.ts';

// Independent source/registry fixtures: no author helpers or fabricated domain state.
const repo = {owner: 'claim-revision-tests', name: 'delivery'};
const issue = {repo, number: 41};
const pr = {repo, number: 42};
const baseHead = '1'.repeat(40);
const ownerHead = '2'.repeat(40);
const issueBody = 'Deliver the documented result and its independent runtime evidence.';
const prBody = `Runtime evidence for the documented result.\n\nCloses #${issue.number}`;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const main: Caller = {agentId: 'main', sessionId: 'main-session', parentId: null, runId: 'claim-test-run', kind: 'main', depth: 0};
const submit: ProtocolReply = {kind: 'submit', branch: 'claim-revision-owner', head: ownerHead, title: 'Deliver documented result', body: prBody, template: 'fourLayer', retryNote: null};
const question: ProtocolReply & {kind: 'claim'} = {
  kind: 'claim',
  claim: {kind: 'question', reproduction: 'The same input permits two interpretations.', readings: ['Use the documented result.', 'Use the proposed alternate result.'], earliestGap: 'The issue does not choose the alternate interpretation.', proposal: 'Confirm the documented result.'},
};

type ClaimScenario = {name: string; claim: ProtocolReply & {kind: 'claim'}; decision: CaseDecision};
const scenarios: ClaimScenario[] = [
  {name: 'question answered', claim: question, decision: {kind: 'answer', basis: 'The current contract requires the documented result.'}},
  {name: 'noCode refuted', claim: {kind: 'claim', claim: {kind: 'noCode', evidence: 'The branch may already satisfy the issue.'}}, decision: {kind: 'refute', basis: 'The required result has not been delivered.'}},
  {name: 'split refuted', claim: {kind: 'claim', claim: {kind: 'split', proposal: 'Move independent evidence to another issue.'}}, decision: {kind: 'refute', basis: 'The evidence belongs to this delivery.'}},
  {name: 'blocked refuted', claim: {kind: 'claim', claim: {kind: 'blocked', category: 'source prerequisite', attempts: 'Read the source contract and existing branch.'}}, decision: {kind: 'refute', basis: 'The documented source already permits the required implementation.'}},
];

function sourceFacts(adopted: boolean): Facts {
  return {
    viewer: 'RiriAgent',
    issues: [{ref: issue, body: issueBody, bodyHash: hash(issueBody), updatedAt: 10, state: 'open', lastClose: null, lastReopen: null, children: []}],
    prs: adopted ? [{ref: pr, headRepo: repo, headBranch: 'claim-revision-owner', head: ownerHead, target: {repo, base: 'main'}, title: 'Deliver documented result', body: prBody, bodyHash: hash(prBody), updatedAt: 10, state: {kind: 'open'}, closes: [issue], mergeable: 'yes', checks: {kind: 'passing', required: []}}] : [],
    links: adopted ? [{issue, pr}] : [],
    repos: [{repo, defaultBranch: 'main', defaultHead: baseHead, bases: [{name: 'main', state: {kind: 'present', head: baseHead, isDefault: true, rules: {required: [], strict: false, upToDate: true, constraints: []}}}]}],
    branches: [{repo, name: 'main', state: {kind: 'present', head: baseHead}}, {repo, name: 'claim-revision-owner', state: {kind: 'present', head: ownerHead}}],
    maintenance: adopted ? [{pr, result: {kind: 'maintainable', basis: {headRepo: repo, headBranch: 'claim-revision-owner', viewerPermission: 'ADMIN', author: 'RiriAgent', maintainerCanModify: true, authorization: {kind: 'actorIsAuthor', actor: 'RiriAgent'}}}}] : [],
    commits: [], checkAttempts: [], createdIssues: [],
  };
}

class Scenario {
  state: Agenda;
  readonly facts: Facts;
  seats: HostSeat[] = [];
  readonly trace: {event: Event; outcome: Transition['kind']; detail: string; version: number; cases: {id: string; state: string; revision: number; claimRevision: number | null}[]; work: {id: string; contentVersion: number; holds: OwnerWork['holds']} | null; wakes: {id: string; state: string; ticket: string; revision: number}[]}[] = [];
  private acceptedAt = 100;

  constructor(adopted = false) {
    this.facts = sourceFacts(adopted);
    const created = createAgenda({op: 'convene', mode: 'execute', parent: null, entries: [{issue, target: {repo, base: 'main'}, designOnly: false, adoptPr: adopted ? pr : null}]}, this.facts, 20, 'd249a78b-ecb8-46a2-9d84-79cdb134a731');
    if (!created.ok) throw new Error(`Independent fixture rejected: ${JSON.stringify(created.error)}`);
    this.state = created.value;
    this.observe();
  }

  get input(): Inputs {
    return {
      facts: {kind: 'available', generation: 1, observedAt: 30, scope: {issues: [issue], prs: this.facts.prs.map(snapshot => snapshot.ref), repos: [{repo, bases: ['main']}], branches: this.facts.branches.map(branch => ({repo: branch.repo, name: branch.name})), commits: [], checkRuns: [], creations: []}, facts: this.facts},
      host: {runId: main.runId, main, seats: this.seats, turnEnds: [], preflight: {ok: true, value: {asyncEnabled: true, isolationEnabled: true, asyncManager: true, gitCwd: '/tmp/claim-revision-public-api', agents: [{name: 'task:free', blocking: false}]}}},
      policy: {text: 'Independent public API regression. Implement the complete contract and preserve evidence.', ownerAgent: 'task:free', gateAgent: 'task:free'},
    };
  }

  step(event: Event): Transition {
    const before = JSON.stringify(this.state);
    const version = this.state.version;
    const result = transition(this.state, this.input, event);
    expect(JSON.stringify(this.state)).toBe(before);
    if (result.kind === 'next') {
      expect(result.state.version).toBe(version + 1);
      this.state = result.state;
    }
    const work = this.state.units[0]?.members[0]?.work;
    this.trace.push({event, outcome: result.kind, detail: result.kind === 'rejected' ? `${result.error.kind}: ${result.error.message}` : JSON.stringify(result.reply), version: this.state.version, cases: this.state.cases.map(item => ({id: item.id, state: item.state.kind, revision: item.contentVersion, claimRevision: item.openedBy?.revision ?? null})), work: work ? {id: work.id, contentVersion: work.contentVersion, holds: work.holds} : null, wakes: this.state.effects.flatMap(effect => effect.action.kind === 'wake' ? [{id: effect.id, state: effect.state.kind, ticket: effect.action.ticket, revision: effect.action.revision}] : [])});
    return result;
  }

  observe(): void {
    const result = this.step({kind: 'observe'});
    if (result.kind === 'rejected') throw new Error(`observe rejected: ${JSON.stringify(result.error)}`);
  }

  ticket(id: Ticket['id']): Ticket {
    const current = tickets(this.state, this.input).find(ticket => ticket.id === id);
    if (!current) throw new Error(`Missing public ticket ${id}`);
    return current;
  }

  ownerTicket(): Ticket {
    const current = tickets(this.state, this.input).find(ticket => ticket.id.startsWith('work:') && ticket.context.kind === 'member');
    if (!current) throw new Error('Missing owner work ticket');
    return current;
  }

  reply(caller: Caller, ticket: Ticket, payload: ProtocolReply): Transition {
    const parsed = parsePortInput({op: 'reply', ticket: ticket.id, revision: ticket.revision, reply: payload});
    if (!parsed.ok || parsed.value.op !== 'reply') throw new Error(`Invalid test reply: ${JSON.stringify(parsed)}`);
    return this.step({kind: 'reply', caller, ticket: parsed.value.ticket, revision: parsed.value.revision, payload: parsed.value.reply, acceptedAt: this.acceptedAt++});
  }

  accept(caller: Caller, ticket: Ticket, payload: ProtocolReply): ReplyResult {
    const result = this.reply(caller, ticket, payload);
    if (result.kind !== 'next' || !result.reply) throw new Error(`Expected accepted next reply: ${JSON.stringify(result)}`);
    return result.reply;
  }

  bind(ticket: Ticket, agentId: string): Caller {
    if (ticket.holder.kind !== 'seat') throw new Error('Expected native seat request');
    const request: SeatRequest | undefined = this.state.requests.find(request => request.id === (ticket.holder.kind === 'seat' ? ticket.holder.requestId : ''));
    if (!request) throw new Error('Expected persisted seat request');
    const sessionId = `${agentId}-session`;
    this.seats = [...this.seats, {agentId, requestedName: request.name, parentId: main.agentId, sessionId, createdAt: this.seats.length + 40, status: 'running', plan: 'disabled', streaming: false}];
    this.accept(main, this.ticket(`spawn:${request.id}`), {kind: 'spawned', agentId});
    return {agentId, sessionId, parentId: main.agentId, runId: main.runId, kind: 'sub', depth: 1};
  }

  parked(caller: Caller): void {
    this.seats = this.seats.map(seat => seat.agentId === caller.agentId ? {...seat, status: 'parked'} : seat);
  }

  opened(result: ReplyResult): DecisionCase {
    expect(result.outcome).toBe('claimOpened');
    const refs = result.created.filter(ref => ref.kind === 'case');
    expect(refs).toHaveLength(1);
    const item = this.state.cases.find(item => item.id === refs[0]?.id);
    if (!item) throw new Error('Claim result must name its newly created case');
    expect(item.state.kind).toBe('open');
    return item;
  }

  replay(caller: Caller, ticket: Ticket, payload: ProtocolReply, receipt: ReplyResult): void {
    const before = JSON.stringify(this.state);
    expect(this.reply(caller, ticket, payload)).toEqual({kind: 'same', reply: receipt});
    expect(JSON.stringify(this.state)).toBe(before);
  }

  reject(caller: Caller, ticket: Ticket, payload: ProtocolReply, kind: 'pendingClaim' | 'superseded'): void {
    const before = JSON.stringify(this.state);
    const result = this.reply(caller, ticket, payload);
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('Expected rejected reply');
    expect(result.error.kind).toBe(kind);
    expect(JSON.stringify(this.state)).toBe(before);
  }

  assertHeld(ticket: Ticket, caseId: string, caller: Caller): void {
    const work = this.state.units[0]?.members[0]?.work;
    expect(work?.id).toBe(ticket.id.slice(5));
    expect(work?.holds).toContainEqual({kind: 'case', caseId});
    expect(this.ticket(ticket.id).runDisposition).toBe('mayWait');
    this.reject(caller, this.ticket(ticket.id), submit, 'pendingClaim');
    this.parked(caller);
    const wakeCount = this.state.effects.filter(effect => effect.action.kind === 'wake').length;
    for (let epoch = 0; epoch < 3; epoch++) this.observe();
    expect(this.state.effects.filter(effect => effect.action.kind === 'wake')).toHaveLength(wakeCount);
    expect(this.state.effects.filter(effect => effect.action.kind === 'wake' && effect.action.ticket === ticket.id && !['cancelled', 'confirmed'].includes(effect.state.kind))).toHaveLength(0);
    expect(tickets(this.state, this.input).filter(ticket => ticket.id.startsWith('gate:'))).toHaveLength(0);
    expect(this.state.effects.filter(effect => effect.action.kind === 'publishPr' || effect.action.kind === 'merge')).toHaveLength(0);
  }
}

function traced(run: (scenario: Scenario) => void, adopted = false): void {
  const scenario = new Scenario(adopted);
  try {
    run(scenario);
  } catch (error) {
    console.error('CLAIM_REVISION_PUBLIC_API_TRACE', JSON.stringify(scenario.trace, null, 2));
    throw error;
  }
}

describe('owner claim identity includes its accepted work content revision', () => {
  for (const scenario of scenarios) {
    test(`${scenario.name}: identical later claim is a NEW unresolved case, not a resolved subject reuse`, () => traced(world => {
      const firstTicket = world.ownerTicket();
      const caller = world.bind(firstTicket, 'owner');
      const firstReceipt = world.accept(caller, firstTicket, scenario.claim);
      const firstCase = world.opened(firstReceipt);
      const firstClaimReceipt = structuredClone(firstCase.openedBy);
      world.replay(caller, firstTicket, scenario.claim, firstReceipt);
      world.reject(caller, firstTicket, {kind: 'claim', claim: {kind: 'blocked', category: 'different pending claim', attempts: 'A different claim cannot overwrite the pending case.'}}, 'pendingClaim');
      world.assertHeld(firstTicket, firstCase.id, caller);

      world.accept(main, world.ticket(`case:${firstCase.id}`), {kind: 'decision', decision: scenario.decision});
      const resumed = world.ownerTicket();
      expect(resumed.id).toBe(firstTicket.id);
      expect(resumed.revision).toBe(firstTicket.revision + 1);
      expect(resumed.runDisposition).toBe('mustRun');
      expect(world.state.cases.find(item => item.id === firstCase.id)?.state.kind).toBe('resolved');
      world.replay(caller, firstTicket, scenario.claim, firstReceipt);
      world.observe();
      const resumedWakes = world.state.effects.filter(effect => effect.action.kind === 'wake' && effect.action.ticket === resumed.id && effect.action.revision === resumed.revision);
      expect(resumedWakes).toHaveLength(1);
      expect(resumedWakes[0]?.state.kind).toBe('ready');

      const secondReceipt = world.accept(caller, resumed, scenario.claim);
      const secondCase = world.opened(secondReceipt);
      expect(secondCase.id).not.toBe(firstCase.id);
      expect(secondCase.openedBy?.revision).toBe(resumed.revision);
      expect(world.state.cases.find(item => item.id === firstCase.id)?.openedBy).toEqual(firstClaimReceipt);
      world.assertHeld(resumed, secondCase.id, caller);
      world.replay(caller, firstTicket, scenario.claim, firstReceipt);
      world.replay(caller, resumed, scenario.claim, secondReceipt);
      world.reject(caller, resumed, {kind: 'claim', claim: {kind: 'noCode', evidence: 'A conflicting claim while the second case is unresolved.'}}, 'pendingClaim');
      expect(world.ticket(`case:${secondCase.id}`).runDisposition).toBe('mustRun');
    }));
  }

  test('old claim replay preserves its original receipt even after another content revision claims again', () => traced(world => {
    const first = world.ownerTicket();
    const caller = world.bind(first, 'replay-owner');
    const originalReceipt = world.accept(caller, first, question);
    const firstCase = world.opened(originalReceipt);
    world.accept(main, world.ticket(`case:${firstCase.id}`), {kind: 'decision', decision: {kind: 'answer', basis: 'The documented interpretation remains required.'}});
    const second = world.ownerTicket();
    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(first.revision + 1);
    world.accept(caller, second, question);
    // Check replay independently of the new-case assertion so a reused resolved
    // case cannot hide the separate corruption of its old claim receipt.
    world.replay(caller, first, question, originalReceipt);
  }));
});

describe('gate claim identity follows a fresh immutable job generation', () => {
  for (const kind of ['review', 'accept'] as const) {
    test(`${kind}: answered claim creates a fresh job and holder; identical claim opens a new case`, () => traced(world => {
      const oldGate = world.state.units[0]?.members[0]?.[kind];
      if (!oldGate) throw new Error(`Expected adopted PR ${kind} job`);
      const first = world.ticket(`gate:${oldGate.id}`);
      const firstCaller = world.bind(first, `${kind}-first`);
      const originalReceipt = world.accept(firstCaller, first, question);
      const originalCase = world.opened(originalReceipt);
      expect(world.state.units[0]?.members[0]?.[kind]?.status).toEqual({kind: 'cancelled', reason: 'claimOpened'});
      world.parked(firstCaller);
      world.observe();
      expect(tickets(world.state, world.input).some(ticket => ticket.id === first.id)).toBe(false);
      expect(world.state.effects.filter(effect => effect.action.kind === 'wake' && effect.action.holder === firstCaller.agentId)).toHaveLength(0);
      world.replay(firstCaller, first, question, originalReceipt);

      const answer = `The ${kind} gate must use the documented result, not the alternate interpretation.`;
      world.accept(main, world.ticket(`case:${originalCase.id}`), {kind: 'decision', decision: {kind: 'answer', basis: answer}});
      world.observe();
      const freshGate = world.state.units[0]?.members[0]?.[kind];
      if (!freshGate) throw new Error(`Expected fresh ${kind} gate`);
      expect(freshGate.id).not.toBe(oldGate.id);
      expect(freshGate.requestId).not.toBe(oldGate.requestId);
      expect(freshGate.stamp.rulings).toContainEqual({kind: 'questionAnswered', question: originalCase.evidence, classification: 'answer', basis: answer, applicableContractRevision: 1});
      const fresh = world.ticket(`gate:${freshGate.id}`);
      expect(fresh.revision).toBe(1);
      expect(fresh.brief).toContain(answer);
      const freshCaller = world.bind(fresh, `${kind}-fresh`);
      expect(freshCaller.agentId).not.toBe(firstCaller.agentId);
      world.reject(firstCaller, first, {kind: 'verdict', ok: true, note: 'Old cancelled generation must not satisfy the new obligation.'}, 'superseded');
      const freshReceipt = world.accept(freshCaller, fresh, question);
      const freshCase = world.opened(freshReceipt);
      expect(freshCase.id).not.toBe(originalCase.id);
      expect(world.state.cases.find(item => item.id === originalCase.id)?.state.kind).toBe('resolved');
      expect(world.ticket(`case:${freshCase.id}`).runDisposition).toBe('mustRun');
      world.parked(freshCaller);
      world.observe();
      expect(world.state.effects.filter(effect => effect.action.kind === 'wake' && effect.action.holder === freshCaller.agentId)).toHaveLength(0);
      expect(tickets(world.state, world.input).some(ticket => ticket.id === fresh.id)).toBe(false);
      world.replay(firstCaller, first, question, originalReceipt);
      world.replay(freshCaller, fresh, question, freshReceipt);
      expect(world.state.effects.filter(effect => effect.action.kind === 'merge')).toHaveLength(0);
    }, true));
  }
});
