import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createAgenda, parseAgenda, tickets, transition } from '../src/domain/index.ts';
import type {
  Agenda, Caller, CaseDecision, DecisionCase, Effect, Entry, Event, Facts,
  GateJob, HostSeat, Inputs, Insertion, IssueRef, IssueSnapshot, Position,
  PrSnapshot, ProtocolReply, Ticket, Transition,
} from '../src/domain/index.ts';

// Independent fixtures: every durable state below comes from the public API.
const repo = { owner: 'InsertionAcceptance', name: 'source' };
const target = { repo, base: 'main' };
const parent: IssueRef = { repo, number: 90 };
const original: IssueRef = { repo, number: 1 };
const external: IssueRef = { repo, number: 2 };
const externalTwo: IssueRef = { repo, number: 3 };
const unrelatedParent: IssueRef = { repo, number: 91 };
const prRef = { repo, number: 101 };
const base = '1'.repeat(40);
const head = '2'.repeat(40);
const merge = '3'.repeat(40);
const main: Caller = { agentId: 'main', sessionId: 'main-session', parentId: null, runId: 'insertion-run', kind: 'main', depth: 0 };
const hash = (body: string): string => createHash('sha256').update(body).digest('hex');
const sameRef = (left: IssueRef, right: IssueRef): boolean => left.number === right.number && left.repo.owner === right.repo.owner && left.repo.name === right.repo.name;
const entry = (issue: IssueRef): Entry => ({ issue, target, designOnly: false, adoptPr: null });
const issue = (ref: IssueRef, children: IssueRef[] = []): IssueSnapshot => {
  const body = `Acceptance source issue ${ref.number}`;
  return { ref, body, bodyHash: hash(body), updatedAt: 1, state: 'open', lastClose: null, lastReopen: null, children };
};
const pr = (): PrSnapshot => ({
  ref: prRef, headRepo: repo, headBranch: 'ordinary-owner', head, target,
  title: 'Deliver ordinary issue', body: 'Closes #1', bodyHash: hash('Closes #1'), updatedAt: 2,
  state: { kind: 'open' }, closes: [original], mergeable: 'yes', checks: { kind: 'passing', required: [] },
});
const sourceFacts = (): Facts => ({
  viewer: 'InsertionAcceptance',
  issues: [issue(parent, [original]), issue(original), issue(external), issue(externalTwo), issue(unrelatedParent)],
  prs: [], links: [],
  repos: [{ repo, defaultBranch: 'main', defaultHead: base, bases: [{ name: 'main', state: { kind: 'present', head: base, isDefault: true, rules: { required: [], strict: false, upToDate: true, constraints: [] } } }] }],
  branches: [{ repo, name: 'main', state: { kind: 'present', head: base } }, { repo, name: 'ordinary-owner', state: { kind: 'present', head } }],
  maintenance: [],
  commits: [base, head, merge].map(sha => ({ repo, ancestor: sha, descendant: sha, result: 'contains' })),
  checkAttempts: [], createdIssues: [],
});

type Attachment = Effect & { action: Extract<Effect['action'], { kind: 'attachChild' }> };
type AcceptedTransition = Exclude<Transition, { kind: 'rejected' }>;

class Scenario {
  state: Agenda;
  facts: Facts;
  seats: HostSeat[] = [];
  trace: string[] = [];

  constructor() {
    this.facts = sourceFacts();
    const result = createAgenda({ op: 'convene', mode: 'execute', parent, entries: [entry(original)] }, this.facts, 10, 'b884ae86-40a4-47bf-92f3-7b700f8fe616');
    if (!result.ok) throw new Error(`Initial convene rejected: ${JSON.stringify(result.error)}`);
    this.state = result.value;
    this.accept({ kind: 'resume', runId: main.runId, operatorConfirmedOriginalSessionEnded: true });
    this.observe();
  }

  inputs(): Inputs {
    return {
      facts: { kind: 'available', generation: 1, observedAt: 100, facts: this.facts, scope: {
        issues: this.facts.issues.map(item => item.ref), prs: this.facts.prs.map(item => item.ref),
        repos: [{ repo, bases: ['main'] }], branches: this.facts.branches.map(item => ({ repo: item.repo, name: item.name })),
        commits: this.facts.commits.map(item => ({ repo: item.repo, ancestor: item.ancestor, descendant: item.descendant })),
        checkRuns: [], creations: [],
      } },
      host: { runId: main.runId, main, seats: this.seats, turnEnds: [], preflight: { ok: true, value: { asyncEnabled: true, isolationEnabled: true, asyncManager: true, gitCwd: '/tmp/insertion-acceptance', agents: [{ name: 'task:high', blocking: false }, { name: 'task:mid', blocking: false }] } } },
      policy: { text: 'Independent existing issue insertion acceptance.', ownerAgent: 'task:high', gateAgent: 'task:mid' },
    };
  }

  apply(event: Event): Transition {
    const result = transition(this.state, this.inputs(), event);
    if (result.kind === 'next') this.state = result.state;
    this.trace.push(JSON.stringify({ event, result: result.kind, error: result.kind === 'rejected' ? result.error : undefined, version: this.state.version, members: this.state.units.map(unit => unit.members.map(member => member.ref.number)), cases: this.state.cases.map(item => ({ id: item.id, subject: item.subject.kind, state: item.state.kind })), effects: this.state.effects.map(effect => ({ id: effect.id, action: effect.action.kind, state: effect.state.kind })) }));
    return result;
  }

  accept(event: Event): AcceptedTransition {
    const result = this.apply(event);
    if (result.kind === 'rejected') throw new Error(`Public event rejected: ${JSON.stringify(result.error)}\n${this.trace.join('\n')}`);
    return result;
  }

  observe(afterTransition?: () => void): void {
    for (let index = 0; index < 50; index++) {
      const result = this.accept({ kind: 'observe' });
      afterTransition?.();
      if (result.kind === 'same') return;
    }
    throw new Error(`Public observation did not settle\n${this.trace.join('\n')}`);
  }

  getIssue(ref: IssueRef): IssueSnapshot {
    const found = this.facts.issues.find(item => sameRef(item.ref, ref));
    if (!found) throw new Error(`Fixture source missing issue ${ref.number}`);
    return found;
  }

  ticket(id: string): Ticket {
    const found = tickets(this.state, this.inputs()).find(item => item.id === id);
    if (!found) throw new Error(`Missing public ticket ${id}\n${this.trace.join('\n')}`);
    return found;
  }

  reply(ticket: Ticket, payload: ProtocolReply, caller = main): AcceptedTransition {
    return this.accept({ kind: 'reply', caller, ticket: ticket.id, revision: ticket.revision, payload, acceptedAt: 100 });
  }

  bind(requestId: string): Caller {
    const request = this.state.requests.find(item => item.id === requestId);
    if (!request) throw new Error(`Missing seat request ${requestId}`);
    const agentId = `seat-${this.seats.length + 1}`;
    const sessionId = `${agentId}-session`;
    this.seats.push({ agentId, requestedName: request.name, parentId: main.agentId, sessionId, createdAt: 20 + this.seats.length, status: 'running', plan: 'disabled', streaming: false });
    this.reply(this.ticket(`spawn:${requestId}`), { kind: 'spawned', agentId });
    return { agentId, sessionId, parentId: main.agentId, runId: main.runId, kind: 'sub', depth: 1 };
  }

  decision(item: DecisionCase, decision: CaseDecision): AcceptedTransition {
    return this.reply(this.ticket(`case:${item.id}`), { kind: 'decision', decision });
  }

  findCase(kind: DecisionCase['subject']['kind']): DecisionCase {
    const found = this.state.cases.find(item => item.subject.kind === kind && item.state.kind === 'open');
    if (!found) throw new Error(`Missing open ${kind} case\n${this.trace.join('\n')}`);
    return found;
  }

  currentCase(id: string): DecisionCase {
    const found = this.state.cases.find(item => item.id === id);
    if (!found) throw new Error(`Case disappeared: ${id}`);
    return found;
  }

  attachments(): Attachment[] {
    return this.state.effects.filter((effect): effect is Attachment => effect.action.kind === 'attachChild');
  }

  membership(): IssueRef[] { return this.state.units.flatMap(unit => unit.members.map(member => member.ref)); }

  assertPending(caseId: string, expectedMembers: IssueRef[]): void {
    expect(this.membership(), this.trace.join('\n')).toEqual(expectedMembers);
    expect(this.currentCase(caseId).state.kind, this.trace.join('\n')).toBe('applying');
    const persisted = parseAgenda(JSON.parse(JSON.stringify(this.state)));
    expect(persisted.ok, persisted.ok ? undefined : JSON.stringify(persisted.error)).toBe(true);
  }

  mergeOriginal(): GateJob {
    const merged = pr();
    merged.state = { kind: 'merged', sha: merge, at: 30 };
    this.facts.prs = [merged];
    this.facts.links = [{ issue: original, pr: prRef }];
    const originalSource = this.getIssue(original);
    originalSource.state = 'closed';
    originalSource.lastClose = { id: 'ordinary-source-close', at: 30 };
    originalSource.updatedAt = 30;
    this.facts.repos[0]!.defaultHead = merge;
    this.facts.repos[0]!.bases[0]!.state = { kind: 'present', head: merge, isDefault: true, rules: { required: [], strict: false, upToDate: true, constraints: [] } };
    this.facts.branches[0]!.state = { kind: 'present', head: merge };
    this.facts.commits.push({ repo, ancestor: base, descendant: merge, result: 'contains' });
    this.observe();
    const gate = this.state.units[0]!.postMerge;
    if (!gate || gate.status.kind !== 'requested') throw new Error(`No fresh postMerge job\n${this.trace.join('\n')}`);
    return gate;
  }

  postMergeFailure(): DecisionCase {
    const gate = this.mergeOriginal();
    const caller = this.bind(gate.requestId);
    this.reply(this.ticket(`gate:${gate.id}`), { kind: 'verdict', ok: false, note: 'Ordinary delivery needs an existing external correction issue.' }, caller);
    this.observe();
    return this.findCase('postMerge');
  }

  splitClaim(): DecisionCase {
    const member = this.state.units[0]!.members[0]!;
    if (!member.work || !member.ownerRequestId) throw new Error(`Missing ordinary owner work\n${this.trace.join('\n')}`);
    const caller = this.bind(member.ownerRequestId);
    this.reply(this.ticket(`work:${member.work.id}`), { kind: 'claim', claim: { kind: 'split', proposal: 'Narrow original and deliver two already-existing issue obligations.' } }, caller);
    return this.findCase('claim');
  }
}

function correction(scenario: Scenario): Insertion & { kind: 'existing' } {
  return { kind: 'existing', entry: entry(external), position: { kind: 'correctionOf', unitId: scenario.state.units[0]!.id } };
}

function assertAttachment(effect: Attachment, caseId: string, insertion: Insertion & { kind: 'existing' }): void {
  expect(effect.action).toEqual({ kind: 'attachChild', owner: { kind: 'insertion', caseId, insertion }, parent, child: insertion.entry.issue });
  expect(effect.state.kind).toBe('ready');
  expect(effect.attempt).toBe(0);
}

function attachSource(scenario: Scenario, child: IssueRef): void {
  const source = scenario.getIssue(parent);
  source.children = [...source.children, child];
  source.updatedAt++;
}

function assertPlaced(scenario: Scenario, caseId: string, child: IssueRef): void {
  expect(scenario.membership().filter(ref => sameRef(ref, child))).toHaveLength(1);
  expect(scenario.currentCase(caseId).state.kind, scenario.trace.join('\n')).toBe('resolved');
  expect(scenario.state.effects.filter(effect => effect.action.kind === 'createIssue')).toHaveLength(0);
}

describe('existing issue insertion waits for exact source parent attachment', () => {
  test('initial convene still rejects initial members absent from the parent source', () => {
    const facts = sourceFacts();
    const result = createAgenda({ op: 'convene', mode: 'execute', parent, entries: [entry(original), entry(external)] }, facts, 10, 'b884ae86-40a4-47bf-92f3-7b700f8fe616');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('premiseChanged');
    expect(facts.issues.find(item => sameRef(item.ref, parent))!.children).toEqual([original]);
  });

  test('direct postMerge correction persists attachment intent before placement and places the same case after confirmed source write', () => {
    const scenario = new Scenario();
    const item = scenario.postMergeFailure();
    const insertion = correction(scenario);
    const unitIds = scenario.state.units.map(unit => unit.id);
    const result = scenario.decision(item, { kind: 'correct', insertion });
    expect(result.reply?.outcome).toBe('accepted');
    const [attachment] = scenario.attachments();
    expect(attachment).toBeDefined();
    assertAttachment(attachment!, item.id, insertion);
    expect(scenario.currentCase(item.id).state).toEqual({ kind: 'applying', decision: { kind: 'correct', insertion }, required: [{ kind: 'effect', effectId: attachment!.id }] });
    scenario.assertPending(item.id, [original]);
    expect(scenario.state.units.map(unit => unit.id)).toEqual(unitIds);

    // Neither another parent's child list nor a different child in the exact parent proves this attachment.
    scenario.getIssue(unrelatedParent).children.push(external);
    attachSource(scenario, externalTwo);
    scenario.observe();
    scenario.assertPending(item.id, [original]);
    scenario.accept({ kind: 'effectStarted', id: attachment!.id, attempt: 1, startedAt: 101 });
    expect(scenario.state.effects.find(effect => effect.id === attachment!.id)!.state.kind).toBe('executing');
    expect(scenario.getIssue(parent).children.some(ref => sameRef(ref, external))).toBe(false);
    scenario.assertPending(item.id, [original]);

    attachSource(scenario, external);
    const beforeConfirmation = scenario.state.version;
    scenario.accept({ kind: 'effectConfirmed', id: attachment!.id, attempt: 1, result: { kind: 'attached', parent, child: external } });
    const assertAtomicPlacement = (): void => {
      expect(scenario.currentCase(item.id).state.kind === 'resolved').toBe(scenario.membership().some(ref => sameRef(ref, external)));
    };
    assertAtomicPlacement();
    scenario.observe(assertAtomicPlacement);
    assertPlaced(scenario, item.id, external);
    expect(scenario.state.units.map(unit => unit.id)).toEqual(unitIds);
    expect(scenario.state.version).toBeGreaterThan(beforeConfirmation);
    expect(scenario.attachments()).toHaveLength(1);
    console.log('existing-insertion/direct', JSON.stringify({ caseId: item.id, attachment: attachment!.id, state: scenario.currentCase(item.id).state.kind, members: scenario.membership() }));
  });

  for (const outcome of ['knownFailed', 'uncertain'] as const) {
    test(`direct correction ${outcome} retains unplaced intent until exact source confirmation`, () => {
      const scenario = new Scenario();
      const item = scenario.postMergeFailure();
      scenario.decision(item, { kind: 'correct', insertion: correction(scenario) });
      const attachment = scenario.attachments()[0]!;
      scenario.accept({ kind: 'effectStarted', id: attachment.id, attempt: 1, startedAt: 101 });
      scenario.accept({ kind: 'effectFailed', id: attachment.id, attempt: 1, outcome, error: outcome === 'knownFailed' ? { kind: 'permission', message: 'Attachment rejected by source before applying.' } : { kind: 'uncertainOutcome', message: 'Attachment response lost; source still lacks child.' } });
      scenario.observe();
      expect(scenario.state.effects.find(effect => effect.id === attachment.id)!.state.kind).toBe(outcome === 'knownFailed' ? 'failed' : 'uncertain');
      scenario.assertPending(item.id, [original]);
      expect(scenario.state.cases.some(candidate => candidate.subject.kind === 'effectFailure' && candidate.subject.effectId === attachment.id)).toBe(true);
      scenario.observe();
      scenario.assertPending(item.id, [original]);
      if (outcome === 'knownFailed') {
        const failure = scenario.findCase('effectFailure');
        scenario.decision(failure, { kind: 'retry', effectId: attachment.id, attempt: 1 });
        expect(scenario.state.effects.find(effect => effect.id === attachment.id)!.state.kind).toBe('ready');
      }
      attachSource(scenario, external);
      scenario.accept({ kind: 'effectSatisfied', id: attachment.id, result: { kind: 'attached', parent, child: external } });
      scenario.observe();
      assertPlaced(scenario, item.id, external);
      expect(scenario.attachments()).toHaveLength(1);
      console.log(`existing-insertion/${outcome}`, JSON.stringify({ caseId: item.id, attachment: attachment.id, state: scenario.currentCase(item.id).state.kind }));
    });
  }

  test('already attached existing correction places immediately without duplicate attach mutation', () => {
    const scenario = new Scenario();
    const item = scenario.postMergeFailure();
    attachSource(scenario, external);
    scenario.decision(item, { kind: 'correct', insertion: correction(scenario) });
    scenario.observe();
    assertPlaced(scenario, item.id, external);
    expect(scenario.attachments()).toHaveLength(0);
  });

  test('split existing group is owned by one amendment and waits for every exact attachment plus body confirmation', () => {
    const scenario = new Scenario();
    const item = scenario.splitClaim();
    const workId = scenario.state.units[0]!.members[0]!.work!.id;
    const oldRevision = scenario.state.units[0]!.members[0]!.contract.revision;
    const position: Position = { kind: 'before', unitId: scenario.state.units[0]!.id };
    const insertions: [Insertion & { kind: 'existing' }, Insertion & { kind: 'existing' }] = [
      { kind: 'existing', entry: entry(external), position },
      { kind: 'existing', entry: entry(externalTwo), position },
    ];
    const narrowedBody = 'Original issue narrowed after handing off both existing obligations.';
    scenario.decision(item, { kind: 'split', bodyEdit: { issue: original, expectedHash: scenario.getIssue(original).bodyHash, body: narrowedBody }, insertions });
    const amendment = scenario.state.amendments.find(intent => intent.caseId === item.id);
    expect(amendment).toBeDefined();
    expect(amendment!.state.kind).toBe('pending');
    expect(scenario.currentCase(item.id).state.kind).toBe('applying');
    if (scenario.currentCase(item.id).state.kind === 'applying') {
      expect(scenario.currentCase(item.id).state).toMatchObject({ required: [{ kind: 'amendment', id: amendment!.id }] });
    }
    const attachments = scenario.attachments();
    expect(attachments).toHaveLength(2);
    for (const insertion of insertions) {
      const attachment = attachments.find(effect => sameRef(effect.action.child, insertion.entry.issue));
      expect(attachment).toBeDefined();
      assertAttachment(attachment!, item.id, insertion);
    }
    const bodyEffect = scenario.state.effects.find(effect => effect.action.kind === 'replaceBody');
    expect(bodyEffect).toBeDefined();
    if (amendment!.state.kind === 'pending') {
      expect([...amendment!.state.requiredEffectIds].sort()).toEqual([bodyEffect!.id, ...attachments.map(effect => effect.id)].sort());
    }
    scenario.assertPending(item.id, [original]);
    expect(scenario.state.units).toHaveLength(1);
    expect(scenario.state.units[0]!.members[0]!.contract.revision).toBe(oldRevision);

    // Source confirms the body and one child, but grouped placement must still be atomic.
    scenario.accept({ kind: 'effectStarted', id: bodyEffect!.id, attempt: 1, startedAt: 101 });
    const originalSource = scenario.getIssue(original);
    originalSource.body = narrowedBody;
    originalSource.bodyHash = hash(narrowedBody);
    originalSource.updatedAt++;
    scenario.accept({ kind: 'effectConfirmed', id: bodyEffect!.id, attempt: 1, result: { kind: 'bodyReplaced', issue: original, hash: hash(narrowedBody) } });
    attachSource(scenario, external);
    scenario.accept({ kind: 'effectSatisfied', id: attachments.find(effect => sameRef(effect.action.child, external))!.id, result: { kind: 'attached', parent, child: external } });
    scenario.observe();
    scenario.assertPending(item.id, [original]);
    expect(scenario.state.amendments.find(intent => intent.id === amendment!.id)!.state.kind).toBe('pending');
    const lastAttachment = attachments.find(effect => sameRef(effect.action.child, externalTwo))!;
    scenario.accept({ kind: 'effectStarted', id: lastAttachment.id, attempt: 1, startedAt: 102 });
    scenario.accept({ kind: 'effectFailed', id: lastAttachment.id, attempt: 1, outcome: 'uncertain', error: { kind: 'uncertainOutcome', message: 'Second grouped child attach outcome unavailable.' } });
    scenario.observe();
    scenario.assertPending(item.id, [original]);
    attachSource(scenario, externalTwo);
    scenario.accept({ kind: 'effectSatisfied', id: lastAttachment.id, result: { kind: 'attached', parent, child: externalTwo } });
    const assertAtomicGroupPlacement = (): void => {
      const placed = scenario.membership().filter(ref => sameRef(ref, external) || sameRef(ref, externalTwo)).length;
      expect([0, 2], scenario.trace.join('\n')).toContain(placed);
      expect(scenario.currentCase(item.id).state.kind === 'resolved').toBe(placed === 2);
      expect(scenario.state.amendments.find(intent => intent.id === amendment!.id)!.state.kind === 'effective').toBe(placed === 2);
    };
    assertAtomicGroupPlacement();
    scenario.observe(assertAtomicGroupPlacement);
    expect(scenario.membership()).toEqual([external, externalTwo, original]);
    expect(scenario.state.units).toHaveLength(1);
    expect(scenario.currentCase(item.id).state.kind).toBe('resolved');
    expect(scenario.state.amendments.find(intent => intent.id === amendment!.id)!.state.kind).toBe('effective');
    const resumed = scenario.state.units[0]!.members.find(member => sameRef(member.ref, original))!;
    expect(resumed.work!.id).toBe(workId);
    expect(resumed.contract.revision).toBe(oldRevision + 1);
    expect(scenario.attachments()).toHaveLength(2);
    console.log('existing-insertion/split', JSON.stringify({ caseId: item.id, amendmentId: amendment!.id, requiredAttachments: attachments.map(effect => effect.id), members: scenario.membership() }));
  });

  test('another independent case cannot claim an already queued existing insertion', () => {
    const scenario = new Scenario();
    const first = scenario.postMergeFailure();
    const insertion = correction(scenario);
    scenario.decision(first, { kind: 'correct', insertion });
    scenario.assertPending(first.id, [original]);
    const attachment = scenario.attachments()[0]!;
    assertAttachment(attachment, first.id, insertion);

    // An independent source write exposes the same issue as a real parent agenda gap.
    // Merely observing it does not confirm the first case's still-ready effect.
    attachSource(scenario, external);
    scenario.observe();
    const second = scenario.findCase('agendaGap');
    expect(second.subject).toMatchObject({ kind: 'agendaGap', issue: external });
    expect(second.id).not.toBe(first.id);
    scenario.assertPending(first.id, [original]);
    expect(scenario.state.effects.find(effect => effect.id === attachment.id)!.state.kind).toBe('ready');
    const before = JSON.stringify(scenario.state);
    const ticket = scenario.ticket(`case:${second.id}`);
    const result = scenario.apply({ kind: 'reply', caller: main, ticket: ticket.id, revision: ticket.revision, payload: { kind: 'decision', decision: { kind: 'includeExisting', issue: external, position: insertion.position } }, acceptedAt: 101 });
    expect(result.kind, scenario.trace.join('\n')).toBe('rejected');
    expect(JSON.stringify(scenario.state)).toBe(before);
    expect(scenario.attachments()).toHaveLength(1);
    expect(scenario.attachments()[0]!.action.owner).toEqual({ kind: 'insertion', caseId: first.id, insertion });
    expect(scenario.currentCase(second.id).state.kind).toBe('open');
    expect(scenario.membership()).toEqual([original]);
    console.log('existing-insertion/duplicate', JSON.stringify({ firstCase: first.id, competingCase: second.id, result: result.kind, owner: scenario.attachments()[0]!.action.owner }));
  });
});
