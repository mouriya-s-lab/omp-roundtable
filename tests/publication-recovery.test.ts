import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createAgenda, parseAgenda, parsePortInput, tickets, transition } from '../src/domain/index.ts';
import type {
  Action, Agenda, Caller, CaseDecision, DecisionCase, Effect, Event, Facts,
  HostObservation, Inputs, IssueRef, Member, PrSnapshot, ProtocolReply, Ticket, Transition,
} from '../src/domain/index.ts';

const repo = { owner: 'publication-reader', name: 'recovery' };
const fork = { owner: 'another-author', name: 'recovery' };
const issue: IssueRef = { repo, number: 101 };
const otherIssue: IssueRef = { repo, number: 102 };
const parent: IssueRef = { repo, number: 100 };
const actualPr = { repo, number: 201 };
const differentPr = { repo, number: 202 };
const target = { repo, base: 'main' };
const branch = 'publication-recovery';
const h1 = '1'.repeat(40);
const h2 = '2'.repeat(40);
const base = 'a'.repeat(40);
const merge = 'b'.repeat(40);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const main: Caller = { agentId: 'main', sessionId: 'main-session', parentId: null, runId: 'publication-run', kind: 'main', depth: 0 };
type Publication = Effect & { action: Extract<Action, { kind: 'publishPr' }> };
type ReplyEvent = Extract<Event, { kind: 'reply' }>;
type Submit = Extract<ProtocolReply, { kind: 'submit' }>;
type Loss = 'responseLost' | 'confirmationReadLost';
type Advance = 'head' | 'title' | 'body' | 'headTitleBody';

function sourceIssue(ref: IssueRef) {
  const body = `Deliver the observable contract for issue ${ref.number}.`;
  return { ref, body, bodyHash: hash(body), updatedAt: 1, state: 'open' as const, lastClose: null, lastReopen: null, children: [] as IssueRef[] };
}

// This driver creates no Agenda internals: every persisted state is the result of
// a public constructor or event, with independent source and registry observations.
class PublicationReader {
  state: Agenda;
  facts: Facts;
  host: HostObservation;
  readonly trace: unknown[] = [];
  private time = 10_000;

  constructor(options: { ownedByOther?: boolean; withParent?: boolean } = {}) {
    this.facts = {
      viewer: 'publication-reader', issues: [sourceIssue(issue), sourceIssue(otherIssue)], prs: [], links: [],
      repos: [{ repo, defaultBranch: 'main', defaultHead: base, bases: [
        { name: 'main', state: { kind: 'present', head: base, isDefault: true, rules: { required: [], strict: false, upToDate: true, constraints: [] } } },
        { name: 'release', state: { kind: 'present', head: base, isDefault: false, rules: { required: [], strict: false, upToDate: true, constraints: [] } } },
      ] }], branches: [{ repo, name: branch, state: { kind: 'present', head: h1 } }],
      maintenance: [], commits: [], checkAttempts: [], createdIssues: [],
    };
    if (options.ownedByOther) {
      const body = `Closes publication-reader/recovery#${otherIssue.number}\n\nOther member evidence.`;
      this.facts.prs = [{ ref: actualPr, headRepo: repo, headBranch: branch, head: h1, target, title: 'Other member delivery', body, bodyHash: hash(body), updatedAt: 1, state: { kind: 'open' }, closes: [otherIssue], mergeable: 'yes', checks: { kind: 'passing', required: [] } }];
      this.facts.links = [{ issue: otherIssue, pr: actualPr }];
      this.authorize(this.facts.prs[0]!);
    }
    if (options.withParent) this.facts.issues.push({ ...sourceIssue(parent), children: [issue] });
    this.host = {
      runId: main.runId, main, seats: [], turnEnds: [],
      preflight: { ok: true, value: { asyncEnabled: true, isolationEnabled: true, asyncManager: true, gitCwd: '/tmp/publication-recovery-reader', agents: [{ name: 'owner', blocking: false }, { name: 'gate', blocking: false }] } },
    };
    const created = createAgenda({ op: 'convene', mode: 'execute', parent: options.withParent ? parent : null,
      entries: [
        { issue, target, designOnly: false, adoptPr: null },
        ...(options.ownedByOther ? [{ issue: otherIssue, target, designOnly: false, adoptPr: actualPr }] : []),
      ] }, this.facts, 1, '56111111-1111-4111-8111-111111111111');
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    this.state = created.value;
    this.roundTrip();
    this.accept({ kind: 'observe' });
  }

  get input(): Inputs {
    return { facts: { kind: 'available', generation: this.trace.length + 1, observedAt: this.time,
      scope: {
        issues: this.facts.issues.map(value => value.ref), prs: this.facts.prs.map(value => value.ref),
        repos: this.facts.repos.map(value => ({ repo: value.repo, bases: value.bases.map(item => item.name) })),
        branches: this.facts.branches.map(value => ({ repo: value.repo, name: value.name })),
        commits: this.facts.commits.map(value => ({ repo: value.repo, ancestor: value.ancestor, descendant: value.descendant })), checkRuns: [], creations: [],
      }, facts: this.facts }, host: this.host,
      policy: { text: 'Verify actual source and preserve accepted delivery evidence; never infer acceptance from live metadata.', ownerAgent: 'owner', gateAgent: 'gate' } };
  }
  get member(): Member { return this.memberFor(issue); }
  memberFor(ref: IssueRef): Member {
    const found = this.state.units.flatMap(unit => unit.members).find(member => member.ref.number === ref.number && member.ref.repo.owner === ref.repo.owner && member.ref.repo.name === ref.repo.name);
    if (!found) throw new Error(`Missing member ${ref.number}\n${this.diagnostic()}`);
    return found;
  }
  diagnostic(): string { return `Independent publication recovery trace:\n${JSON.stringify(this.trace, null, 2)}`; }
  roundTrip(): void {
    const parsed = parseAgenda(JSON.parse(JSON.stringify(this.state)));
    if (!parsed.ok) throw new Error(`Public state cannot be persisted: ${JSON.stringify(parsed.error)}\n${this.diagnostic()}`);
    this.state = parsed.value;
  }
  event(event: Event, input = this.input): Transition {
    const before = JSON.stringify(this.state);
    const version = this.state.version;
    const result = transition(this.state, input, event);
    this.trace.push({ event, facts: input.facts.kind === 'available' ? { prs: input.facts.facts.prs, branches: input.facts.facts.branches, maintenance: input.facts.facts.maintenance } : input.facts,
      result: result.kind === 'rejected' ? result.error : { kind: result.kind, reply: result.reply }, version: result.kind === 'next' ? result.state.version : version });
    expect(JSON.stringify(this.state), this.diagnostic()).toBe(before);
    if (result.kind === 'next') {
      expect(result.state.version, this.diagnostic()).toBe(version + 1);
      this.state = result.state;
      this.roundTrip();
    } else expect(this.state.version, this.diagnostic()).toBe(version);
    return result;
  }
  accept(event: Event): Exclude<Transition, { kind: 'rejected' }> {
    const result = this.event(event);
    if (result.kind === 'rejected') throw new Error(`Expected accepted public event: ${JSON.stringify(result.error)}\n${this.diagnostic()}`);
    return result;
  }
  reject(event: Event, input = this.input): void {
    const before = JSON.stringify(this.state);
    expect(this.event(event, input).kind, this.diagnostic()).toBe('rejected');
    expect(JSON.stringify(this.state), this.diagnostic()).toBe(before);
  }
  ticket(id: string): Ticket {
    const found = tickets(this.state, this.input).find(ticket => ticket.id === id);
    if (!found) throw new Error(`Missing public ticket ${id}\n${this.diagnostic()}`);
    return found;
  }
  replyEvent(ticket: Ticket, payload: ProtocolReply): ReplyEvent {
    const parsed = parsePortInput({ op: 'reply', ticket: ticket.id, revision: ticket.revision, reply: payload });
    if (!parsed.ok || parsed.value.op !== 'reply') throw new Error('Independent protocol payload did not parse');
    let caller = main;
    if (ticket.holder.kind === 'seat') {
      const agentId = ticket.holder.agentId;
      const seat = this.host.seats.find(value => value.agentId === agentId);
      if (!seat?.sessionId) throw new Error(`No authenticated registry seat for ${ticket.id}`);
      caller = { agentId: seat.agentId, sessionId: seat.sessionId, parentId: seat.parentId, runId: this.host.runId, kind: 'sub', depth: 1 };
    }
    return { kind: 'reply', caller, ticket: ticket.id, revision: ticket.revision, payload: parsed.value.reply, acceptedAt: ++this.time };
  }
  bindOwner(ref = issue): Ticket {
    const work = this.memberFor(ref).work;
    if (!work) throw new Error(`No owner work for ${ref.number}\n${this.diagnostic()}`);
    let ticket = this.ticket(`work:${work.id}`);
    if (ticket.holder.kind === 'seat' && ticket.holder.agentId === null) {
      const requestId = ticket.holder.requestId;
      const request = this.state.requests.find(value => value.id === requestId);
      if (!request) throw new Error('No request for owner');
      const agentId = `publication-owner-${this.host.seats.length + 1}`;
      this.host.seats = [...this.host.seats, { agentId, requestedName: request.name, parentId: main.agentId, sessionId: `${agentId}-session`, createdAt: ++this.time, status: 'running', plan: 'disabled', streaming: false }];
      this.accept(this.replyEvent(this.ticket(`spawn:${request.id}`), { kind: 'spawned', agentId }));
      ticket = this.ticket(`work:${work.id}`);
    }
    return ticket;
  }
  publication(id?: string): Publication {
    const found = this.state.effects.find((effect): effect is Publication => effect.action.kind === 'publishPr' && (id ? effect.id === id : effect.state.kind === 'ready'));
    if (!found) throw new Error(`Missing publication ${id ?? 'ready'}\n${this.diagnostic()}`);
    return found;
  }
  recoveryCase(effect: Effect): DecisionCase {
    const found = this.state.cases.find(value => value.subject.kind === 'effectFailure' && value.subject.effectId === effect.id && value.state.kind === 'open');
    if (!found) throw new Error(`Missing recovery case ${effect.id}\n${this.diagnostic()}`);
    return found;
  }
  submit(ref = issue, head = h1): { event: ReplyEvent; effect: Publication } {
    const ticket = this.bindOwner(ref);
    const payload: Submit = { kind: 'submit', branch, head, title: `Deliver issue ${ref.number}`, body: `Closes publication-reader/recovery#${ref.number}\n\nImplementation: complete behavior.\nVerification: independent runtime path.\nEvidence: actual source.\nRisks: no hidden completion.`, template: 'fourLayer', retryNote: null };
    const event = this.replyEvent(ticket, payload);
    this.accept(event);
    const effect = this.publication();
    expect(effect.state.kind, this.diagnostic()).toBe('ready');
    expect(this.memberFor(ref).work, this.diagnostic()).toBeNull();
    return { event, effect };
  }
  start(effect: Effect): void { this.accept({ kind: 'effectStarted', id: effect.id, attempt: effect.attempt + 1, startedAt: ++this.time }); }
  authorize(pr: PrSnapshot): void {
    this.facts.maintenance = this.facts.maintenance.filter(value => value.pr.number !== pr.ref.number);
    this.facts.maintenance.push({ pr: pr.ref, result: { kind: 'maintainable', basis: { headRepo: pr.headRepo, headBranch: pr.headBranch, viewerPermission: 'WRITE', author: 'publication-reader', maintainerCanModify: true, authorization: { kind: 'actorIsAuthor', actor: 'publication-reader' } } } });
  }
  actual(effect: Publication, patch: Partial<PrSnapshot> = {}): PrSnapshot {
    const action = effect.action;
    const pr: PrSnapshot = { ref: actualPr, headRepo: action.headRepo, headBranch: action.submission.payload.branch, head: action.submission.payload.head, target: action.target,
      title: action.submission.payload.title, body: action.body, bodyHash: hash(action.body), updatedAt: ++this.time, state: { kind: 'open' }, closes: [action.member], mergeable: 'yes', checks: { kind: 'passing', required: [] }, ...patch };
    this.facts.prs = [pr];
    this.facts.links = [{ issue: action.member, pr: pr.ref }];
    this.authorize(pr);
    return pr;
  }
  uncertain(loss: Loss, options: { ownedByOther?: boolean } = {}): { original: ReplyEvent; effect: Publication; recovery: DecisionCase } {
    const submitted = this.submit();
    this.start(submitted.effect);
    expect(this.publication(submitted.effect.id).state.kind, this.diagnostic()).toBe('executing');
    this.actual(submitted.effect);
    this.accept({ kind: 'effectFailed', id: submitted.effect.id, attempt: 1, outcome: 'uncertain',
      error: { kind: 'uncertainOutcome', message: loss === 'responseLost' ? 'Write response was lost after source created the PR' : 'Write returned the exact PR identity; confirming source read was lost' },
      ...(loss === 'confirmationReadLost' ? { received: { kind: 'pr' as const, pr: actualPr } } : {}) });
    const effect = this.publication(submitted.effect.id);
    expect(effect.state.kind, this.diagnostic()).toBe('uncertain');
    if (effect.state.kind !== 'uncertain') throw new Error('Expected uncertain publication');
    expect(effect.state.received, this.diagnostic()).toEqual(loss === 'responseLost' ? null : { kind: 'pr', pr: actualPr });
    if (options.ownedByOther) expect(this.memberFor(otherIssue).binding.kind, this.diagnostic()).toBe('registered');
    return { original: submitted.event, effect, recovery: this.recoveryCase(effect) };
  }
  advance(effect: Publication, advancement: Advance): PrSnapshot {
    const body = advancement === 'body' || advancement === 'headTitleBody' ? 'Human changed evidence after the original publication.\n\nCloses publication-reader/recovery#101' : effect.action.body;
    const head = advancement === 'head' || advancement === 'headTitleBody' ? h2 : h1;
    const pr = this.actual(effect, { head, title: advancement === 'title' || advancement === 'headTitleBody' ? 'Human revised the publication title' : effect.action.submission.payload.title, body, bodyHash: hash(body) });
    this.facts.branches = this.facts.branches.map(value => value.name === branch ? { ...value, state: { kind: 'present', head } } : value);
    this.trace.push({ source: 'actual PR advanced after write', advancement, pr });
    return pr;
  }
  adoption(effect: Publication, recovery: DecisionCase, selected = actualPr): ReplyEvent {
    const decision: CaseDecision = { kind: 'adoptResult', effectId: effect.id, result: { kind: 'pr', pr: selected } };
    return this.replyEvent(this.ticket(`case:${recovery.id}`), { kind: 'decision', decision });
  }
  assertNoGatesOrMerge(): void {
    expect([this.member.review, this.member.accept].filter(value => value?.status.kind !== 'cancelled' && value !== null), this.diagnostic()).toEqual([]);
    expect(this.state.effects.filter(value => value.action.kind === 'merge' && value.state.kind !== 'cancelled'), this.diagnostic()).toEqual([]);
    expect(tickets(this.state, this.input).filter(value => value.id.startsWith('gate:')), this.diagnostic()).toEqual([]);
  }
}

function unavailable(reader: PublicationReader): Inputs {
  return { ...reader.input, facts: { kind: 'unavailable', error: { kind: 'unavailable', message: 'Replay must not need a source read' } } };
}

function assertReplay(reader: PublicationReader, event: ReplyEvent, accepted: Exclude<Transition, { kind: 'rejected' }>): void {
  const before = JSON.stringify(reader.state);
  const originalIds = reader.state.units.flatMap(unit => unit.members).flatMap(member => member.work ? [member.work.id] : []);
  const replay = reader.event(event, unavailable(reader));
  expect(replay.kind, reader.diagnostic()).toBe('same');
  if (replay.kind === 'same') expect(replay.reply, reader.diagnostic()).toEqual(accepted.reply);
  expect(JSON.stringify(reader.state), reader.diagnostic()).toBe(before);
  expect(reader.state.units.flatMap(unit => unit.members).flatMap(member => member.work ? [member.work.id] : []), reader.diagnostic()).toEqual(originalIds);
  reader.reject({ ...event, caller: { ...main, sessionId: 'not-the-main-session' } }, unavailable(reader));
}

describe('explicit publication association recovery is not acceptance of advanced source', () => {
  for (const loss of ['responseLost', 'confirmationReadLost'] as const) {
    for (const advancement of ['head', 'title', 'body', 'headTitleBody'] as const) {
      test(`${loss}: ${advancement} requires explicit association, fresh owner submission and confirmed materialization`, () => {
        const reader = new PublicationReader();
        const { original, effect, recovery } = reader.uncertain(loss);
        const acceptedBaseline = structuredClone(reader.member.baseline);
        const acceptedReceipt = structuredClone(reader.member.ownerReceipt);
        const acceptedTerminal = structuredClone(reader.member.ownerTerminal);
        const source = reader.advance(effect, advancement);
        reader.reject({ kind: 'effectSatisfied', id: effect.id, result: { kind: 'published', pr: actualPr } });
        reader.reject(reader.replyEvent(reader.ticket(`case:${recovery.id}`), { kind: 'decision', decision: { kind: 'retry', effectId: effect.id, attempt: 1 } }));
        reader.reject(reader.replyEvent(reader.ticket(`case:${recovery.id}`), { kind: 'decision', decision: { kind: 'retryAfterAbsence', effectId: effect.id, attempt: 1 } }));
        const event = reader.adoption(effect, recovery);
        const version = reader.state.version;
        const accepted = reader.accept(event);
        expect(accepted.kind, reader.diagnostic()).toBe('next');
        expect(reader.state.version, reader.diagnostic()).toBe(version + 1);
        expect(reader.publication(effect.id).state, reader.diagnostic()).toEqual({ kind: 'cancelled', reason: 'sourceAlreadyAdvanced' });
        expect(reader.member.binding, reader.diagnostic()).toEqual({ kind: 'registered', pr: actualPr, headRepo: repo, branch, origin: 'adopted' });
        expect(reader.member.baseline, reader.diagnostic()).toEqual(acceptedBaseline);
        expect(reader.member.ownerReceipt, reader.diagnostic()).toEqual(acceptedReceipt);
        expect(reader.member.ownerTerminal, reader.diagnostic()).toEqual(acceptedTerminal);
        const work = reader.member.work;
        expect(work, reader.diagnostic()).not.toBeNull();
        if (!work) throw new Error(reader.diagnostic());
        expect(work.id, reader.diagnostic()).not.toBe(effect.action.submission.workId);
        expect(work.baseline, reader.diagnostic()).toBe(source.head);
        expect(work.reasons.some(reason => reason.kind === 'sourceChange' && reason.caseId === recovery.id), reader.diagnostic()).toBe(true);
        expect(work.contentVersion, reader.diagnostic()).toBe(1);
        const resolved = reader.state.cases.find(value => value.id === recovery.id);
        if (event.payload.kind !== 'decision') throw new Error(reader.diagnostic());
        if (accepted.reply === null) throw new Error(reader.diagnostic());
        expect(resolved?.state, reader.diagnostic()).toEqual({ kind: 'resolved', result: event.payload.decision });
        expect(resolved?.receipt?.result, reader.diagnostic()).toEqual(accepted.reply);
        expect(accepted.reply.created, reader.diagnostic()).toContainEqual({ kind: 'work', id: work.id });
        reader.assertNoGatesOrMerge();
        assertReplay(reader, event, accepted);
        // The old owner's receipt is local replay, not a new acceptance of live h2.
        const oldReplay = reader.event(original, unavailable(reader));
        expect(oldReplay.kind, reader.diagnostic()).toBe('same');
        expect(reader.member.baseline, reader.diagnostic()).toEqual(acceptedBaseline);
        expect(reader.member.work?.id, reader.diagnostic()).toBe(work.id);
        reader.accept({ kind: 'observe' });
        reader.assertNoGatesOrMerge();
        const owner = reader.bindOwner();
        const correct: Submit = { ...effect.action.submission.payload, head: source.head, body: `Closes publication-reader/recovery#101\n\nFresh evidence reviewed after explicit late-write association: ${advancement}.`, retryNote: 'Fresh owner response accepts the actual current source, not a metadata adoption alias.' };
        reader.reject(reader.replyEvent(owner, { ...correct, head: source.head === h2 ? h1 : h2 }));
        reader.reject(reader.replyEvent(owner, { ...correct, body: 'Closes publication-reader/recovery#102\n\nWrong member evidence.' }));
        reader.accept(reader.replyEvent(owner, correct));
        expect(reader.member.baseline, reader.diagnostic()).toEqual({ kind: 'submitted', submission: { workId: work.id, payload: correct } });
        const replacement = reader.publication();
        expect(replacement.id, reader.diagnostic()).not.toBe(effect.id);
        expect(replacement.action.pr, reader.diagnostic()).toEqual(actualPr);
        expect(replacement.action.expectedBodyHash, reader.diagnostic()).toBe(source.bodyHash);
        reader.accept({ kind: 'observe' });
        reader.assertNoGatesOrMerge();
        reader.start(replacement);
        reader.actual(replacement);
        reader.accept({ kind: 'effectConfirmed', id: replacement.id, attempt: 1, result: { kind: 'published', pr: actualPr } });
        expect(reader.member.work, reader.diagnostic()).toBeNull();
        reader.accept({ kind: 'observe' });
        expect(reader.member.review?.status.kind, reader.diagnostic()).toBe('requested');
        expect(reader.member.accept?.status.kind, reader.diagnostic()).toBe('requested');
        expect(reader.member.review?.stamp.kind, reader.diagnostic()).toBe('review');
        if (reader.member.review?.stamp.kind === 'review') expect(reader.member.review.stamp.head, reader.diagnostic()).toBe(source.head);
        if (reader.member.accept?.stamp.kind === 'accept') expect(reader.member.accept.stamp.head, reader.diagnostic()).toBe(source.head);
      });
    }
    test(`${loss}: exact original publication explicit adoption confirms without inventing repair work`, () => {
      const reader = new PublicationReader();
      const { effect, recovery } = reader.uncertain(loss);
      const baseline = structuredClone(reader.member.baseline);
      const receipt = structuredClone(reader.member.ownerReceipt);
      const event = reader.adoption(effect, recovery);
      const accepted = reader.accept(event);
      expect(reader.publication(effect.id).state, reader.diagnostic()).toEqual({ kind: 'confirmed', result: { kind: 'published', pr: actualPr } });
      expect(reader.member.binding, reader.diagnostic()).toEqual({ kind: 'registered', pr: actualPr, headRepo: repo, branch, origin: 'published' });
      expect(reader.member.baseline, reader.diagnostic()).toEqual(baseline);
      expect(reader.member.ownerReceipt, reader.diagnostic()).toEqual(receipt);
      expect(reader.member.work, reader.diagnostic()).toBeNull();
      expect(accepted.reply?.created.filter(ref => ref.kind === 'work'), reader.diagnostic()).toEqual([]);
      assertReplay(reader, event, accepted);
      reader.accept({ kind: 'observe' });
      expect(reader.member.review?.status.kind, reader.diagnostic()).toBe('requested');
      expect(reader.member.accept?.status.kind, reader.diagnostic()).toBe('requested');
    });
    test(`${loss}: exact original source satisfaction confirms without an explicit late-write exception`, () => {
      const reader = new PublicationReader();
      const { effect } = reader.uncertain(loss);
      reader.accept({ kind: 'effectSatisfied', id: effect.id, result: { kind: 'published', pr: actualPr } });
      expect(reader.publication(effect.id).state.kind, reader.diagnostic()).toBe('confirmed');
      expect(reader.member.work, reader.diagnostic()).toBeNull();
      expect(reader.member.baseline, reader.diagnostic()).toEqual({ kind: 'submitted', submission: effect.action.submission });
    });
  }
});

type InvalidSource = 'wrongBase' | 'wrongHeadRepo' | 'wrongBranch' | 'missingBranch' | 'branchHeadMismatch' | 'closed' | 'merged' | 'foreign' | 'unknownMaintenance' | 'privilegeWithoutHandover';
const invalidSources: readonly InvalidSource[] = ['wrongBase', 'wrongHeadRepo', 'wrongBranch', 'missingBranch', 'branchHeadMismatch', 'closed', 'merged', 'foreign', 'unknownMaintenance', 'privilegeWithoutHandover'];

function invalidate(reader: PublicationReader, effect: Publication, invalid: InvalidSource, advanced: boolean): void {
  const current = advanced ? reader.advance(effect, 'headTitleBody') : reader.actual(effect);
  switch (invalid) {
    case 'wrongBase': reader.actual(effect, { ...current, target: { repo, base: 'release' } }); break;
    case 'wrongHeadRepo': reader.actual(effect, { ...current, headRepo: fork }); break;
    case 'wrongBranch': reader.actual(effect, { ...current, headBranch: 'other-source-branch' }); reader.facts.branches.push({ repo, name: 'other-source-branch', state: { kind: 'present', head: current.head } }); break;
    case 'missingBranch': reader.facts.branches = []; break;
    case 'branchHeadMismatch': reader.facts.branches = [{ repo, name: branch, state: { kind: 'present', head: current.head === h1 ? h2 : h1 } }]; break;
    case 'closed': reader.actual(effect, { ...current, state: { kind: 'closed' } }); break;
    case 'merged': reader.actual(effect, { ...current, state: { kind: 'merged', sha: merge, at: 20_000 } }); break;
    case 'unknownMaintenance': reader.facts.maintenance = [{ pr: actualPr, result: { kind: 'unknown', reason: 'Author authorization could not be read' } }]; break;
    case 'foreign': case 'privilegeWithoutHandover': {
      reader.facts.maintenance = [{ pr: actualPr, result: { kind: invalid === 'foreign' ? 'foreign' : 'maintainable', basis: { headRepo: current.headRepo, headBranch: current.headBranch, viewerPermission: 'ADMIN', author: 'unrelated-author', maintainerCanModify: true, authorization: { kind: 'none' } } } }];
      break;
    }
  }
}

describe('explicit publication recovery requires exact fresh association authority', () => {
  // Exact-field rows prevent a permissive old exact-match path bypassing these
  // association constraints; advanced rows exercise the new Main-only exception.
  for (const advanced of [false, true]) for (const invalid of invalidSources) {
    test(`${advanced ? 'advanced' : 'exact'} source: reject ${invalid}`, () => {
      const reader = new PublicationReader();
      const { effect, recovery } = reader.uncertain('confirmationReadLost');
      invalidate(reader, effect, invalid, advanced);
      reader.reject(reader.adoption(effect, recovery));
      expect(reader.publication(effect.id).state.kind, reader.diagnostic()).toBe('uncertain');
      expect(reader.member.binding.kind, reader.diagnostic()).toBe('publishing');
      expect(reader.member.baseline, reader.diagnostic()).toEqual({ kind: 'submitted', submission: effect.action.submission });
      reader.assertNoGatesOrMerge();
    });
  }
  test('confirmation-read loss cannot replace returned PR A with selected exact-matching PR B', () => {
    const reader = new PublicationReader();
    const { effect, recovery } = reader.uncertain('confirmationReadLost');
    const candidate = reader.actual(effect, { ref: differentPr });
    reader.authorize(candidate);
    reader.reject(reader.adoption(effect, recovery, differentPr));
    // Automatic confirmation is not allowed to ignore the actual returned identity either.
    reader.reject({ kind: 'effectSatisfied', id: effect.id, result: { kind: 'published', pr: differentPr } });
  });
  test('fresh explicit association cannot proceed on unavailable source', () => {
    const reader = new PublicationReader();
    const { effect, recovery } = reader.uncertain('confirmationReadLost');
    reader.advance(effect, 'head');
    reader.reject(reader.adoption(effect, recovery), unavailable(reader));
  });
  for (const advanced of [false, true]) test(`${advanced ? 'advanced' : 'exact'} identity already adopted by another member cannot be stolen`, () => {
    const reader = new PublicationReader({ ownedByOther: true });
    const { effect, recovery } = reader.uncertain('confirmationReadLost', { ownedByOther: true });
    if (advanced) reader.advance(effect, 'headTitleBody');
    reader.reject(reader.adoption(effect, recovery));
    expect(reader.memberFor(otherIssue).binding, reader.diagnostic()).toEqual({ kind: 'registered', pr: actualPr, headRepo: repo, branch, origin: 'adopted' });
  });
  test('externally merged terminal member cannot be revived by stale publication adoption', () => {
    const reader = new PublicationReader();
    const { effect, recovery } = reader.uncertain('confirmationReadLost');
    const decision = reader.adoption(effect, recovery);
    reader.actual(effect, { state: { kind: 'merged', sha: merge, at: 20_000 } });
    reader.facts.issues = reader.facts.issues.map(value => value.ref.number === issue.number ? { ...value, state: 'closed', lastClose: { id: 'source-merge-close', at: 20_000 } } : value);
    reader.facts.repos = reader.facts.repos.map(value => ({ ...value, defaultHead: merge, bases: value.bases.map(value => value.name === 'main' ? { ...value, state: { kind: 'present', head: merge, isDefault: true, rules: { required: [], strict: false, upToDate: true, constraints: [] } } } : value) }));
    reader.accept({ kind: 'observe' });
    expect(reader.member.terminal.kind, reader.diagnostic()).toBe('merged');
    // A terminal source fact is immutable: stale Main recovery must not reopen
    // its member or turn the old uncertain publication into owner work.
    reader.reject(decision);
    expect(reader.member.terminal.kind, reader.diagnostic()).toBe('merged');
    expect(reader.member.work, reader.diagnostic()).toBeNull();
  });
  test('a second pending publisher of the same branch blocks adoption even before it has a PR binding', () => {
    const reader = new PublicationReader({ withParent: true });
    const { effect, recovery } = reader.uncertain('confirmationReadLost');
    // A newly discovered true parent child is inserted as a prerequisite through
    // the public agendaGap decision; no state slots are manually fabricated.
    reader.facts.issues = reader.facts.issues.map(value => value.ref.number === parent.number ? { ...value, children: [issue, otherIssue] } : value);
    reader.accept({ kind: 'observe' });
    const gap = reader.state.cases.find(value => value.subject.kind === 'agendaGap' && value.subject.issue.number === otherIssue.number && value.state.kind === 'open');
    if (!gap) throw new Error(`No independently observed parent-child gap\n${reader.diagnostic()}`);
    reader.accept(reader.replyEvent(reader.ticket(`case:${gap.id}`), { kind: 'decision', decision: { kind: 'includeExisting', issue: otherIssue, position: { kind: 'before', unitId: reader.state.units[0]!.id } } }));
    reader.accept({ kind: 'observe' });
    const other = reader.submit(otherIssue);
    expect(other.effect.action.submission.payload.branch, reader.diagnostic()).toBe(branch);
    expect(other.effect.state.kind, reader.diagnostic()).toBe('ready');
    // Restore the first returned object's exact source publication: it must not
    // be associated while another member has a competing live publisher intent.
    reader.actual(effect);
    reader.reject(reader.adoption(effect, recovery));
    expect(reader.memberFor(otherIssue).binding, reader.diagnostic()).toEqual({ kind: 'publishing', effectId: other.effect.id, previous: { kind: 'none' } });
  });
});
