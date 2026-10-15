import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createAgenda, parseAgenda, tickets, transition } from '../src/domain/index.ts';
import type {
  Action, Agenda, Caller, CaseDecision, DecisionCase, Effect, Event, Facts,
  HostObservation, Inputs, Member, PrSnapshot, ProtocolReply, Ticket, Transition,
} from '../src/domain/index.ts';

const repo = { owner: 'consumer', name: 'cancellation' };
const issue = { repo, number: 11 };
const prRef = { repo, number: 21 };
const target = { repo, base: 'main' };
const branch = 'deliver-cancellation';
const h1 = '1'.repeat(40);
const h2 = '2'.repeat(40);
const h3 = '3'.repeat(40);
const base = 'a'.repeat(40);
const mergeSha = 'b'.repeat(40);
const hash = (body: string): string => createHash('sha256').update(body).digest('hex');
const main: Caller = { agentId: 'main', sessionId: 'main-session', parentId: null, runId: 'run', kind: 'main', depth: 0 };
type EffectOf<K extends Action['kind']> = Effect & { action: Extract<Action, { kind: K }> };

// Every state in these traces comes from the public constructor/transition API.
// Source changes are independent observations, never edits to persisted Agenda objects.
class Consumer {
  state: Agenda;
  facts: Facts;
  host: HostObservation;
  readonly events: unknown[] = [];
  private time = 10_000;

  constructor(adopt = false, checks: PrSnapshot['checks'] = { kind: 'passing', required: [] }, readonly headRepo = repo) {
    const required = checks.kind === 'passing' ? checks.required : checks.kind === 'unknown' ? [] : checks.required.map(check => check.identity);
    const pr: PrSnapshot = {
      ref: prRef, headRepo, headBranch: branch, head: h1, target,
      title: 'Previous title', body: 'Closes consumer/cancellation#11\n\nPrevious evidence.',
      bodyHash: hash('Closes consumer/cancellation#11\n\nPrevious evidence.'), updatedAt: 1,
      state: { kind: 'open' }, closes: [issue], mergeable: 'yes', checks,
    };
    this.facts = {
      viewer: 'consumer',
      issues: [{ ref: issue, body: 'Deliver the complete cancellation behavior.', bodyHash: hash('Deliver the complete cancellation behavior.'), updatedAt: 1, state: 'open', lastClose: null, lastReopen: null, children: [] }],
      prs: adopt ? [pr] : [], links: adopt ? [{ issue, pr: prRef }] : [],
      repos: [{ repo, defaultBranch: 'main', defaultHead: base, bases: [
        { name: 'main', state: { kind: 'present', head: base, isDefault: true, rules: { required, strict: false, upToDate: true, constraints: [] } } },
        { name: 'release', state: { kind: 'present', head: base, isDefault: false, rules: { required: [], strict: false, upToDate: true, constraints: [] } } },
      ] }],
      branches: [{ repo: headRepo, name: branch, state: { kind: 'present', head: h1 } }],
      maintenance: adopt ? [{ pr: prRef, result: { kind: 'maintainable', basis: {
        headRepo, headBranch: branch, viewerPermission: 'WRITE', author: 'consumer',
        maintainerCanModify: true, authorization: { kind: 'actorIsAuthor', actor: 'consumer' },
      } } }] : [], commits: [], checkAttempts: [], createdIssues: [],
    };
    if (headRepo.name !== repo.name) this.facts.repos.push({ ...this.facts.repos[0]!, repo: headRepo });
    this.host = {
      runId: 'run', main, seats: [], turnEnds: [],
      preflight: { ok: true, value: { asyncEnabled: true, isolationEnabled: true, asyncManager: true, gitCwd: '/tmp/cancellation-consumer', agents: [{ name: 'owner', blocking: false }, { name: 'gate', blocking: false }] } },
    };
    const made = createAgenda({ op: 'convene', mode: 'execute', parent: null, entries: [{ issue, target, designOnly: false, adoptPr: adopt ? prRef : null }] }, this.facts, 1, '42222222-2222-4222-8222-222222222222');
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    this.state = made.value;
    this.roundTrip();
  }

  get input(): Inputs {
    return {
      facts: { kind: 'available', generation: this.events.length + 1, observedAt: this.time,
        scope: { issues: this.facts.issues.map(value => value.ref), prs: this.facts.prs.map(value => value.ref),
          repos: this.facts.repos.map(value => ({ repo: value.repo, bases: value.bases.map(item => item.name) })), branches: this.facts.branches.map(value => ({ repo: value.repo, name: value.name })),
          commits: this.facts.commits.map(value => ({ repo: value.repo, ancestor: value.ancestor, descendant: value.descendant })),
          checkRuns: this.facts.checkAttempts.map(value => ({ repo: value.repo, runId: value.workflowRunId })), creations: [] },
        facts: this.facts },
      host: this.host, policy: { text: 'Preserve all delivery obligations and report actual source results.', ownerAgent: 'owner', gateAgent: 'gate' },
    };
  }

  get member(): Member { return this.state.units[0]!.members[0]!; }
  get pr(): PrSnapshot {
    const pr = this.facts.prs[0];
    if (!pr) throw new Error(`No PR in source\n${this.trace()}`);
    return pr;
  }
  trace(): string { return `Public cancellation trace:\n${JSON.stringify(this.events, null, 2)}`; }
  roundTrip(): void {
    const parsed = parseAgenda(JSON.parse(JSON.stringify(this.state)));
    if (!parsed.ok) throw new Error(`Persisted public state rejected: ${JSON.stringify(parsed.error)}\n${this.trace()}`);
    this.state = parsed.value;
  }
  event(event: Event): Transition {
    const result = transition(this.state, this.input, event);
    this.events.push({ event, result: result.kind === 'rejected' ? result.error : result.kind,
      version: result.kind === 'next' ? result.state.version : this.state.version });
    if (result.kind === 'next') { this.state = result.state; this.roundTrip(); }
    return result;
  }
  accept(event: Event): Exclude<Transition, { kind: 'rejected' }> {
    const result = this.event(event);
    if (result.kind === 'rejected') throw new Error(`Unexpected rejection: ${JSON.stringify(result.error)}\n${this.trace()}`);
    return result;
  }
  observe(): void { this.accept({ kind: 'observe' }); }
  ticket(id: string): Ticket {
    const found = tickets(this.state, this.input).find(value => value.id === id);
    if (!found) throw new Error(`No public ticket ${id}\n${this.trace()}`);
    return found;
  }
  ownerTicket(): Ticket {
    if (!this.member.work) throw new Error(`No owner obligation\n${this.trace()}`);
    return this.ticket(`work:${this.member.work.id}`);
  }
  effect<K extends Action['kind']>(kind: K): EffectOf<K> {
    const found = this.state.effects.find((value): value is EffectOf<K> => value.action.kind === kind && value.state.kind === 'ready');
    if (!found) throw new Error(`No ready ${kind} effect\n${this.trace()}`);
    return found;
  }
  effectById(id: string): Effect {
    const found = this.state.effects.find(value => value.id === id);
    if (!found) throw new Error(`Missing effect ${id}\n${this.trace()}`);
    return found;
  }
  caseById(id: string): DecisionCase {
    const found = this.state.cases.find(value => value.id === id);
    if (!found) throw new Error(`Missing case ${id}\n${this.trace()}`);
    return found;
  }
  currentCase(kind: DecisionCase['subject']['kind']): DecisionCase {
    const found = this.state.cases.find(value => value.subject.kind === kind && value.state.kind === 'open');
    if (!found) throw new Error(`No open ${kind} case\n${this.trace()}`);
    return found;
  }
  caller(ticket: Ticket): Caller {
    if (ticket.holder.kind === 'main') return main;
    const seat = this.host.seats.find(value => value.agentId === (ticket.holder.kind === 'seat' ? ticket.holder.agentId : null));
    if (!seat?.sessionId) throw new Error(`No real bound caller for ${ticket.id}\n${this.trace()}`);
    return { agentId: seat.agentId, sessionId: seat.sessionId, parentId: seat.parentId, runId: this.host.runId, kind: 'sub', depth: 1 };
  }
  reply(ticket: Ticket, payload: ProtocolReply): Exclude<Transition, { kind: 'rejected' }> {
    return this.accept({ kind: 'reply', caller: this.caller(ticket), ticket: ticket.id, revision: ticket.revision, payload, acceptedAt: ++this.time });
  }
  decide(item: DecisionCase, decision: CaseDecision): void { this.reply(this.ticket(`case:${item.id}`), { kind: 'decision', decision }); }
  bind(ticket: Ticket): void {
    if (ticket.holder.kind !== 'seat') throw new Error('Expected a native seat ticket');
    const request = this.state.requests.find(value => value.id === (ticket.holder.kind === 'seat' ? ticket.holder.requestId : null));
    if (!request) throw new Error('Expected public request');
    const agentId = `seat-${this.host.seats.length + 1}`;
    this.host.seats = [...this.host.seats, { agentId, requestedName: request.name, parentId: main.agentId, sessionId: `${agentId}-session`, createdAt: ++this.time, status: 'running', plan: 'disabled', streaming: false }];
    this.events.push({ source: 'registry candidate', request: request.id, agentId });
    this.reply(this.ticket(`spawn:${request.id}`), { kind: 'spawned', agentId });
  }
  start(effect: Effect): void { this.accept({ kind: 'effectStarted', id: effect.id, attempt: effect.attempt + 1, startedAt: ++this.time }); }
  push(head: string): void {
    this.facts.branches = [{ repo: this.headRepo, name: branch, state: { kind: 'present', head } }];
    if (this.facts.prs.length) this.facts.prs = [{ ...this.pr, head, updatedAt: ++this.time }];
    this.events.push({ source: 'remote branch pushed', branch, head, pr: this.facts.prs[0]?.ref ?? null });
  }
  submit(note = 'Current complete evidence'): { ticket: Ticket; payload: Extract<ProtocolReply, { kind: 'submit' }>; effect: EffectOf<'publishPr'> } {
    let ticket = this.ownerTicket();
    if (ticket.holder.kind === 'seat' && ticket.holder.agentId === null) { this.bind(ticket); ticket = this.ownerTicket(); }
    const remote = this.facts.branches[0]!;
    if (remote.state.kind !== 'present') throw new Error('Expected remote branch');
    const payload: Extract<ProtocolReply, { kind: 'submit' }> = { kind: 'submit', branch, head: remote.state.head, title: 'Deliver cancellation behavior', body: `Closes consumer/cancellation#11\n\n${note}`, template: 'fourLayer', retryNote: null };
    this.reply(ticket, payload);
    return { ticket, payload, effect: this.effect('publishPr') };
  }
  publish(effect: EffectOf<'publishPr'>): void {
    this.start(effect);
    const body = effect.action.body;
    const published: PrSnapshot = { ref: prRef, headRepo: effect.action.headRepo, headBranch: branch, head: effect.action.submission.payload.head, target: effect.action.target,
      title: effect.action.submission.payload.title, body, bodyHash: hash(body), updatedAt: ++this.time,
      state: { kind: 'open' }, closes: [issue], mergeable: 'yes', checks: this.facts.prs[0]?.checks ?? { kind: 'passing', required: [] } };
    this.facts.prs = [published]; this.facts.links = [{ issue, pr: prRef }];
    this.facts.maintenance = [{ pr: prRef, result: { kind: 'maintainable', basis: { headRepo: effect.action.headRepo, headBranch: branch, viewerPermission: 'WRITE', author: 'consumer', maintainerCanModify: true, authorization: { kind: 'actorIsAuthor', actor: 'consumer' } } } }];
    this.events.push({ source: 'publish response and source read', pr: published.ref, head: published.head, bodyHash: published.bodyHash });
    this.accept({ kind: 'effectConfirmed', id: effect.id, attempt: this.effectById(effect.id).attempt, result: { kind: 'published', pr: prRef } });
  }
  readyMerge(): EffectOf<'merge'> {
    this.observe();
    for (const kind of ['review', 'accept'] as const) {
      const gate = this.member[kind];
      if (!gate) throw new Error(`Missing ${kind} gate\n${this.trace()}`);
      let ticket = this.ticket(`gate:${gate.id}`);
      if (ticket.holder.kind === 'seat' && ticket.holder.agentId === null) { this.bind(ticket); ticket = this.ticket(ticket.id); }
      this.reply(ticket, { kind: 'verdict', ok: true, note: `${kind}: independently exercised the complete behavior at the pinned head.` });
    }
    this.observe();
    return this.effect('merge');
  }
  fail(effect: Effect, uncertain = false): DecisionCase {
    this.start(effect);
    this.accept({ kind: 'effectFailed', id: effect.id, attempt: this.effectById(effect.id).attempt,
      error: uncertain ? { kind: 'uncertainOutcome', message: 'Merge response connection lost; source result unknown.' } : { kind: 'permission', message: 'Source explicitly rejected this merge attempt before applying it.' },
      outcome: uncertain ? 'uncertain' : 'knownFailed' });
    return this.currentCase('effectFailure');
  }
  merged(head: string, destination = target): void {
    this.facts.prs = [{ ...this.pr, head, target: destination, state: { kind: 'merged', sha: mergeSha, at: ++this.time }, updatedAt: this.time }];
    this.facts.branches = [{ repo: this.headRepo, name: branch, state: { kind: 'present', head } }];
    this.facts.repos = this.facts.repos.map(value => ({
      ...value,
      defaultHead: destination.base === value.defaultBranch ? mergeSha : value.defaultHead,
      bases: value.bases.map(value => value.name === destination.base && value.state.kind === 'present' ? { ...value, state: { ...value.state, head: mergeSha } } : value),
    }));
    this.events.push({ source: 'PR source merged', pr: prRef, head, target: destination, sha: mergeSha });
  }
}

function noPrematureDelivery(world: Consumer): void {
  expect(world.member.terminal.kind, world.trace()).toBe('pending');
  expect([world.member.review, world.member.accept].some(gate => gate && gate.status.kind !== 'cancelled'), world.trace()).toBe(false);
  expect(world.state.effects.some(effect => effect.action.kind === 'merge' && effect.state.kind !== 'cancelled'), world.trace()).toBe(false);
}

function retryMerge(): { world: Consumer; effect: EffectOf<'merge'>; item: DecisionCase } {
  const world = new Consumer(true);
  const effect = world.readyMerge();
  const item = world.fail(effect);
  world.decide(item, { kind: 'retry', effectId: effect.id, attempt: world.effectById(effect.id).attempt });
  expect(world.caseById(item.id).state, world.trace()).toEqual({ kind: 'applying', decision: { kind: 'retry', effectId: effect.id, attempt: 1 }, required: [{ kind: 'effect', effectId: effect.id }] });
  return { world, effect, item };
}

describe('cancelled effects retain truthful public obligations', () => {
  for (const previous of ['none', 'adopted', 'published'] as const) {
    test(`unsent publication cancellation restores ${previous} binding without consuming accepted submission`, () => {
      const world = new Consumer(previous === 'adopted', { kind: 'passing', required: [] }, previous === 'adopted' ? { owner: 'consumer', name: 'cancellation-fork' } : repo);
      if (previous === 'adopted') world.facts.prs = [{ ...world.pr, mergeable: 'no' }];
      world.observe();
      if (previous === 'published') {
        const first = world.submit('First accepted publication');
        world.publish(first.effect);
        world.push(h2);
        world.observe();
      }
      const priorBinding = structuredClone(world.member.binding);
      if (previous === 'adopted') world.facts.prs = [{ ...world.pr, mergeable: 'yes' }];
      const submitted = world.submit('Accepted evidence awaiting publication');
      const accepted = structuredClone(world.member.baseline);
      const receipt = structuredClone(world.member.ownerReceipt);
      const ownerTerminal = structuredClone(world.member.ownerTerminal);
      expect(world.member.binding.kind, world.trace()).toBe('publishing');
      expect(submitted.effect.state.kind, world.trace()).toBe('ready');
      world.push(previous === 'published' ? h3 : h2);
      const blocked = world.event({ kind: 'effectStarted', id: submitted.effect.id, attempt: 1, startedAt: 20_000 });
      expect(blocked.kind, world.trace()).toBe('rejected');
      world.accept({ kind: 'effectCancelled', id: submitted.effect.id, reason: 'preconditionChanged' });
      world.observe();
      expect(world.effectById(submitted.effect.id).state, world.trace()).toEqual({ kind: 'cancelled', reason: 'preconditionChanged' });
      expect(world.member.binding, world.trace()).toEqual(priorBinding);
      expect(world.member.baseline, world.trace()).toEqual(accepted);
      expect(world.member.ownerReceipt, world.trace()).toEqual(receipt);
      expect(world.member.ownerTerminal, world.trace()).toEqual(ownerTerminal);
      noPrematureDelivery(world);
      const next = world.ownerTicket();
      expect(next.id !== submitted.ticket.id || next.revision > submitted.ticket.revision, world.trace()).toBe(true);
      expect(next.runDisposition, world.trace()).toBe('mustRun');
      const replay = world.reply(submitted.ticket, submitted.payload);
      expect(replay.kind, world.trace()).toBe('same');
      expect(replay.reply, world.trace()).toEqual(receipt?.result ?? null);
      const staleHead = world.event({ kind: 'reply', caller: world.caller(next), ticket: next.id, revision: next.revision, payload: submitted.payload, acceptedAt: 20_001 });
      expect(staleHead.kind, world.trace()).toBe('rejected');
      world.submit('New evidence explicitly accepts the actual pushed remote head');
      expect(world.member.baseline.kind === 'submitted' && world.member.baseline.submission.payload.head, world.trace()).toBe(previous === 'published' ? h3 : h2);
      noPrematureDelivery(world);
    });
  }

  for (const change of ['head', 'target'] as const) {
    test(`cancelled merge retry ends its operational case after ${change} changes, not the business obligation`, () => {
      const { world, effect, item } = retryMerge();
      const retryReceipt = structuredClone(world.caseById(item.id).receipt);
      if (change === 'head') world.push(h2);
      else {
        world.facts.prs = [{ ...world.pr, target: { repo, base: 'release' } }];
        world.events.push({ source: 'PR retargeted', target: { repo, base: 'release' } });
      }
      const blocked = world.event({ kind: 'effectStarted', id: effect.id, attempt: 2, startedAt: 20_000 });
      expect(blocked.kind, world.trace()).toBe('rejected');
      world.accept({ kind: 'effectCancelled', id: effect.id, reason: 'preconditionChanged' });
      world.observe();
      expect(world.effectById(effect.id).state.kind, world.trace()).toBe('cancelled');
      expect(world.caseById(item.id).state, world.trace()).toEqual({ kind: 'cancelled', reason: 'sourceEventSuperseded' });
      expect(world.caseById(item.id).receipt, world.trace()).toEqual(retryReceipt);
      expect(world.member.terminal.kind, world.trace()).toBe('pending');
      expect(world.member.ownerReceipt, world.trace()).toBeNull();
      expect(world.state.lifecycle, world.trace()).toBe('active');
      if (change === 'head') {
        const work = world.ownerTicket();
        expect(work.runDisposition, world.trace()).toBe('mustRun');
        expect(world.member.work?.reasons.some(reason => reason.kind === 'unsubmittedPush' && reason.acceptedHead === h1), world.trace()).toBe(true);
      } else {
        const sourceCase = world.currentCase('unexpectedSourceChange');
        expect(sourceCase.id, world.trace()).not.toBe(item.id);
        expect(world.ticket(`case:${sourceCase.id}`).runDisposition, world.trace()).toBe('mustRun');
      }
      noPrematureDelivery(world);
    });
  }

  for (const finalSource of ['differentHead', 'differentTarget'] as const) {
    test(`unknown merge cannot be satisfied by the same PR merged with ${finalSource}`, () => {
      const world = new Consumer(true);
      const effect = world.readyMerge();
      world.fail(effect, true);
      world.merged(finalSource === 'differentHead' ? h2 : h1, finalSource === 'differentTarget' ? { repo, base: 'release' } : target);
      const result = world.event({ kind: 'effectSatisfied', id: effect.id, result: { kind: 'merged', pr: prRef, merge: { repo, sha: mergeSha }, at: world.pr.state.kind === 'merged' ? world.pr.state.at : 0 } });
      expect(result.kind, world.trace()).toBe('rejected');
      expect(world.effectById(effect.id).state.kind, world.trace()).toBe('uncertain');
    });

    test(`actual ${finalSource} source merge can obsolete an unknown intent without claiming its success`, () => {
      const world = new Consumer(true);
      const effect = world.readyMerge();
      const operational = world.fail(effect, true);
      world.merged(finalSource === 'differentHead' ? h2 : h1, finalSource === 'differentTarget' ? { repo, base: 'release' } : target);
      world.observe();
      expect(world.member.ownerReceipt, world.trace()).toBeNull();
      if (finalSource === 'differentHead') {
        expect(world.member.terminal, world.trace()).toEqual({ kind: 'merged', pr: prRef, merge: { repo, sha: mergeSha }, at: world.pr.state.kind === 'merged' ? world.pr.state.at : 0 });
      } else {
        expect(world.member.terminal.kind, world.trace()).toBe('pending');
        expect(world.currentCase('unexpectedSourceChange').state.kind, world.trace()).toBe('open');
      }
      world.accept({ kind: 'effectCancelled', id: effect.id, reason: finalSource === 'differentHead' ? 'sourceAlreadyAdvanced' : 'targetBecameInapplicable' });
      world.observe();
      expect(world.effectById(effect.id).state.kind, world.trace()).toBe('cancelled');
      expect(world.caseById(operational.id).state, world.trace()).toEqual({ kind: 'cancelled', reason: 'sourceEventSuperseded' });
    });
  }

  test('unknown exact-head exact-target merge is satisfied by its real source result', () => {
    const world = new Consumer(true);
    const effect = world.readyMerge();
    world.fail(effect, true);
    world.merged(h1);
    if (world.pr.state.kind !== 'merged') throw new Error('Expected source merge');
    world.accept({ kind: 'effectSatisfied', id: effect.id, result: { kind: 'merged', pr: prRef, merge: { repo, sha: mergeSha }, at: world.pr.state.at } });
    expect(world.effectById(effect.id).state.kind, world.trace()).toBe('confirmed');
    expect(world.effectById(effect.id).attempt, world.trace()).toBe(1);
    world.observe();
    expect(world.member.terminal.kind, world.trace()).toBe('merged');
  });

  test('an old workflow run does not authorize rerun after the current PR head advances', () => {
    const checks: PrSnapshot['checks'] = { kind: 'failing', required: [{ kind: 'actions', identity: { name: 'required-ci', source: { kind: 'app', id: 7 } }, checkRunId: 100, workflowRunId: 200, jobId: 300, runAttempt: 1, head: h1 }] };
    const world = new Consumer(true, checks);
    world.facts.checkAttempts = [{ repo, workflowRunId: 200, attempt: 1, head: h1 }];
    world.observe();
    const submitted = world.submit('Owner repaired evidence; source check attempt still failed');
    world.publish(submitted.effect);
    world.observe();
    const item = world.currentCase('checks');
    world.decide(item, { kind: 'rerun', runId: 200 });
    const rerun = world.effect('rerunChecks');
    expect(rerun.action.head, world.trace()).toBe(h1);
    world.push(h2);
    world.facts.prs = [{ ...world.pr, checks: { kind: 'pending', required: [{ identity: { name: 'required-ci', source: { kind: 'app', id: 7 } }, head: h2 }] } }];
    world.facts.checkAttempts.push({ repo, workflowRunId: 201, attempt: 1, head: h2 });
    const start = world.event({ kind: 'effectStarted', id: rerun.id, attempt: 1, startedAt: 20_000 });
    expect(start.kind, world.trace()).toBe('rejected');
    expect(world.effectById(rerun.id).state.kind, world.trace()).toBe('ready');
    expect(world.effectById(rerun.id).attempt, world.trace()).toBe(0);
  });

  for (const current of ['held', 'newRevision', 'submitted'] as const) {
    test(`a live seat cannot start wake for ${current === 'held' ? 'held work' : current === 'submitted' ? 'an already submitted work ticket' : 'a superseded work revision'}`, () => {
      const world = new Consumer();
      world.observe();
      world.bind(world.ownerTicket());
      world.host.seats = world.host.seats.map(seat => ({ ...seat, status: 'parked' }));
      world.observe();
      const oldTicket = world.ownerTicket();
      const wake = world.effect('wake');
      expect(wake.action.ticket, world.trace()).toBe(oldTicket.id);
      expect(wake.action.revision, world.trace()).toBe(oldTicket.revision);
      if (current === 'submitted') {
        world.submit('Owner already completed this precise work ticket');
        expect(tickets(world.state, world.input).some(ticket => ticket.id === oldTicket.id), world.trace()).toBe(false);
      } else {
        world.reply(oldTicket, { kind: 'claim', claim: { kind: 'question', reproduction: 'Delivery contract leaves a branch-policy ambiguity.', readings: ['Existing branch remains the delivery carrier.', 'A new branch is required.'], earliestGap: 'Branch ownership clause', proposal: 'Confirm the existing branch as carrier.' } });
        if (current === 'newRevision') world.decide(world.currentCase('claim'), { kind: 'answer', basis: 'Existing branch is the delivery carrier; preserve the full issue outcome.' });
        const actual = world.ownerTicket();
        if (current === 'held') expect(actual.runDisposition, world.trace()).toBe('mayWait');
        else {
          expect(actual.id, world.trace()).toBe(oldTicket.id);
          expect(actual.revision, world.trace()).toBeGreaterThan(oldTicket.revision);
          expect(actual.runDisposition, world.trace()).toBe('mustRun');
        }
      }
      // No observe between the reply and start: execution must revalidate the
      // authoritative work, not rely on a prior scheduler cancelling the wake.
      const start = world.event({ kind: 'effectStarted', id: wake.id, attempt: 1, startedAt: 20_000 });
      expect(start.kind, world.trace()).toBe('rejected');
      expect(world.effectById(wake.id).attempt, world.trace()).toBe(0);
    });
  }

  test('wake for the exact current mustRun ticket and holder records only delivery', () => {
    const world = new Consumer();
    world.observe(); world.bind(world.ownerTicket());
    world.host.seats = world.host.seats.map(seat => ({ ...seat, status: 'parked' }));
    world.observe();
    const ticket = world.ownerTicket();
    const wake = world.effect('wake');
    world.start(wake);
    world.accept({ kind: 'effectConfirmed', id: wake.id, attempt: 1, result: { kind: 'delivered', agentId: wake.action.holder, messageId: `${wake.id}:1`, outcome: 'woken' } });
    expect(world.effectById(wake.id).state.kind, world.trace()).toBe('confirmed');
    expect(world.ownerTicket().id, world.trace()).toBe(ticket.id);
    expect(world.ownerTicket().revision, world.trace()).toBe(ticket.revision);
    expect(world.ownerTicket().runDisposition, world.trace()).toBe('mustRun');
    expect(world.member.ownerReceipt, world.trace()).toBeNull();
  });

  test('an aborted holder cannot start its old wake through a new live candidate', () => {
    const world = new Consumer();
    world.observe(); world.bind(world.ownerTicket());
    world.host.seats = world.host.seats.map(seat => ({ ...seat, status: 'parked' }));
    world.observe();
    const wake = world.effect('wake');
    const oldSeat = world.host.seats[0]!;
    world.host.seats = [
      { ...oldSeat, status: 'aborted' },
      { ...oldSeat, agentId: 'replacement-owner', sessionId: 'replacement-session', createdAt: 20_000, status: 'parked' },
    ];
    world.events.push({ source: 'native holder aborted and replacement candidate registered', old: oldSeat.agentId, replacement: 'replacement-owner' });
    const holder = world.ownerTicket().holder;
    expect(holder.kind === 'seat' && holder.agentId, world.trace()).toBe('replacement-owner');
    const start = world.event({ kind: 'effectStarted', id: wake.id, attempt: 1, startedAt: 20_001 });
    expect(start.kind, world.trace()).toBe('rejected');
    expect(world.effectById(wake.id).attempt, world.trace()).toBe(0);
  });

  test('ordinary cancellation of a nested body edit does not make its amendment effective', () => {
    const world = new Consumer();
    world.observe(); world.bind(world.ownerTicket());
    world.reply(world.ownerTicket(), { kind: 'claim', claim: { kind: 'question', reproduction: 'The current body lacks a precise public acceptance entrypoint.', readings: ['Verify through the public API.', 'Verify through private helpers.'], earliestGap: 'Acceptance entrypoint', proposal: 'Keep all requirements and specify the public API.' } });
    const item = world.currentCase('claim');
    const revised = 'Deliver the complete cancellation behavior. Verify every obligation through the public API.';
    const amendmentDecision: CaseDecision = { kind: 'amend', amendment: { kind: 'designGap', affected: [issue], bodyEdits: [{ issue, expectedHash: world.facts.issues[0]!.bodyHash, body: revised }], route: { kind: 'withPr', member: issue } } };
    world.decide(item, amendmentDecision);
    const amendment = world.state.amendments[0]!;
    expect(world.caseById(item.id).state, world.trace()).toEqual({ kind: 'applying', decision: amendmentDecision, required: [{ kind: 'amendment', id: amendment.id }] });
    const design = world.state.designWorks[0]!;
    world.facts.commits.push({ repo, ancestor: h1, descendant: h1, result: 'contains' });
    world.reply(world.ticket(`work:${design.id}`), { kind: 'designCommit', commit: { repo, sha: h1 } });
    const body = world.effect('replaceBody');
    const external = 'Human-edited full requirements; acceptance wording requires a new decision.';
    world.facts.issues = [{ ...world.facts.issues[0]!, body: external, bodyHash: hash(external), updatedAt: 20_000 }];
    world.events.push({ source: 'issue body edited externally', hash: hash(external) });
    const start = world.event({ kind: 'effectStarted', id: body.id, attempt: 1, startedAt: 20_001 });
    expect(start.kind, world.trace()).toBe('rejected');
    world.accept({ kind: 'effectCancelled', id: body.id, reason: 'preconditionChanged' });
    world.observe();
    expect(world.effectById(body.id).state.kind, world.trace()).toBe('cancelled');
    expect(world.state.amendments.find(value => value.id === amendment.id)?.state.kind, world.trace()).toBe('pending');
    expect(world.caseById(item.id).state.kind, world.trace()).not.toBe('resolved');
    expect(world.member.contract.revision, world.trace()).toBe(1);
    expect(world.member.contract.body, world.trace()).toBe('Deliver the complete cancellation behavior.');
    expect(world.ownerTicket().runDisposition, world.trace()).toBe('mayWait');
    // An independently matching body is not confirmation of this cancelled
    // child. The amendment must not count cancellation as successful delivery.
    world.facts.issues = [{ ...world.facts.issues[0]!, body: revised, bodyHash: hash(revised), updatedAt: 20_002 }];
    world.events.push({ source: 'human independently applied matching target body', hash: hash(revised) });
    world.observe();
    expect(world.state.amendments.find(value => value.id === amendment.id)?.state.kind, world.trace()).toBe('pending');
    expect(world.caseById(item.id).state.kind, world.trace()).not.toBe('resolved');
    expect(world.member.contract.revision, world.trace()).toBe(1);
    expect(world.ownerTicket().runDisposition, world.trace()).toBe('mayWait');
    noPrematureDelivery(world);
  });
});
