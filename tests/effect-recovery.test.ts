import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createAgenda, parseAgenda, tickets, transition } from '../src/domain/index.ts';
import type {
  Action, Agenda, Caller, CaseDecision, DecisionCase, DomainError, Effect,
  EffectResult, Event, Facts, HostObservation, Inputs, IssueRef, IssueSnapshot,
  PortError, PrSnapshot, ProtocolReply, SeatRequest, Ticket, Transition,
} from '../src/domain/index.ts';

// Independent public-API fixtures: no old implementation, author world, or private
// reducer/helper imports. Every effect below is produced by public protocol events.
const repo = { owner: 'Audit', name: 'effect-recovery' };
const issue: IssueRef = { repo, number: 11 };
const parent: IssueRef = { repo, number: 10 };
const transfer: IssueRef = { repo, number: 12 };
const created: IssueRef = { repo, number: 13 };
const prRef = { repo, number: 21 };
const target = { repo, base: 'main' };
const h1 = '1'.repeat(40);
const h2 = '2'.repeat(40);
const base = 'a'.repeat(40);
const merged = 'b'.repeat(40);
const hash = (body: string): string => createHash('sha256').update(body).digest('hex');
const main: Caller = { agentId: 'main', sessionId: 'main-session', parentId: null, runId: 'run-one', kind: 'main', depth: 0 };
const submit: ProtocolReply & {kind:'submit'} = {
  kind: 'submit', branch: 'audit-topic', head: h1, title: 'Independent delivery',
  body: 'Closes Audit/effect-recovery#11\n\nImplementation and runtime evidence.',
  template: 'fourLayer', retryNote: null,
};
const question: ProtocolReply & {kind:'claim'} = {
  kind: 'claim', claim: { kind: 'question', reproduction: 'The public entry leaves two specified readings.', readings: ['keep the original contract', 'transfer its verification'], earliestGap: 'verification ownership', proposal: 'Main must decide the contract.' },
};
const denied: PortError = { kind: 'permission', message: 'Source explicitly rejected this mutation before applying it.' };
const lost: PortError = { kind: 'uncertainOutcome', message: 'Transport response was lost after send; application is unknown.' };

function required<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`Independent fixture missing ${label}`);
  return value;
}
function snapshot(ref: IssueRef, body: string): IssueSnapshot {
  return { ref, body, bodyHash: hash(body), updatedAt: 100, state: 'open', lastClose: null, lastReopen: null, children: [] };
}
function pullRequest(): PrSnapshot {
  return { ref: prRef, headRepo: repo, headBranch: submit.branch, head: h1, target,
    title: 'Adopted delivery', body: 'Closes Audit/effect-recovery#11\n\nOriginal source evidence.',
    bodyHash: hash('Closes Audit/effect-recovery#11\n\nOriginal source evidence.'),
    updatedAt: 100, state: { kind: 'open' }, closes: [issue], mergeable: 'yes', checks: { kind: 'passing', required: [] } };
}
function facts(adopt: boolean, withParent: boolean): Facts {
  const original = snapshot(issue, 'Deliver the exact public outcome and verify its runtime result.');
  const parentIssue = { ...snapshot(parent, 'Finish every child and independently verify their integration.'), children: [issue] };
  return {
    viewer: repo.owner,
    issues: [original, snapshot(transfer, 'A separately owned verification obligation.'), ...(withParent ? [parentIssue] : [])],
    prs: adopt ? [pullRequest()] : [], links: adopt ? [{ issue, pr: prRef }] : [],
    repos: [{ repo, defaultBranch: 'main', defaultHead: base, bases: [{ name: 'main', state: { kind: 'present', head: base, isDefault: true, rules: { required: [], strict: false, upToDate: true, constraints: [] } } }] }],
    branches: [{ repo, name: submit.branch, state: { kind: 'present', head: h1 } }],
    maintenance: adopt ? [{ pr: prRef, result: { kind: 'maintainable', basis: { headRepo: repo, headBranch: submit.branch, viewerPermission: 'WRITE', author: 'AuditOwner', maintainerCanModify: true, authorization: { kind: 'authorAuthorized', evidence: 'The author explicitly authorized this exact branch and PR.' } } } }] : [],
    commits: [], checkAttempts: [], createdIssues: [],
  };
}
type Observation = { event: Event; before: Agenda; input: Inputs; result: Transition };
class World {
  state: Agenda;
  source: Facts;
  host: HostObservation;
  observedAt = 1_000;
  last: Observation | null = null;
  constructor(adopt = false, withParent = false) {
    this.source = facts(adopt, withParent);
    this.host = { runId: main.runId, main: structuredClone(main), seats: [], turnEnds: [], preflight: { ok: true, value: { asyncEnabled: true, isolationEnabled: true, asyncManager: true, gitCwd: '/tmp/effect-recovery-fixture', agents: [{ name: 'task:free', blocking: false }] } } };
    const result = createAgenda({ op: 'convene', mode: 'execute', parent: withParent ? parent : null, entries: [{ issue, target, designOnly: false, adoptPr: adopt ? prRef : null }] }, this.source, 100, 'f103da84-96cb-43f4-bd15-990f8f980011');
    if (!result.ok) throw new Error(`convene rejected: ${JSON.stringify(result.error)}`);
    this.state = result.value;
    this.next({ kind: 'observe' });
  }
  input(): Inputs {
    return { facts: { kind: 'available', generation: 1, scope: { issues: this.source.issues.map(item => item.ref), prs: this.source.prs.map(item => item.ref), repos: [{ repo, bases: ['main'] }], branches: [{ repo, name: submit.branch }], commits: [], checkRuns: this.source.checkAttempts.map(run => ({ repo: run.repo, runId: run.workflowRunId })), creations: this.state.drafts.map(draft => ({ repo: draft.spec.repo, since: 1_000, title: draft.spec.title, body: draft.spec.body, actor: this.source.viewer })) }, observedAt: this.observedAt, facts: this.source }, host: this.host, policy: { text: 'Independent audit policy: preserve the specified outcome and report actual evidence.', ownerAgent: 'task:free', gateAgent: 'task:free' } };
  }
  diagnostic(): string {
    const seen = this.last;
    if (!seen) return 'No public event has run.';
    return JSON.stringify({ event: seen.event, before: { version: seen.before.version, effects: seen.before.effects, cases: seen.before.cases, requests: seen.before.requests }, input: seen.input, observed: seen.result }, null, 2);
  }
  run(event: Event, input = this.input()): Transition {
    const before = structuredClone(this.state);
    const inputBefore = structuredClone(input);
    const result = transition(this.state, input, event);
    this.last = { event, before, input: inputBefore, result };
    expect(this.state, 'transition must not mutate its supplied Agenda').toEqual(before);
    expect(input, 'transition must not mutate source/host inputs').toEqual(inputBefore);
    if (result.kind === 'next') {
      expect(result.state.version, this.diagnostic()).toBe(before.version + 1);
      this.state = result.state;
    }
    return result;
  }
  next(event: Event, input = this.input()): Extract<Transition, {kind:'next'}> {
    const result = this.run(event, input);
    if (result.kind !== 'next') throw new Error(`Expected public next.\n${this.diagnostic()}`);
    return result;
  }
  reject(event: Event, kind: DomainError['kind'] = 'premiseChanged', input = this.input()): void {
    const result = this.run(event, input);
    expect(result.kind, this.diagnostic()).toBe('rejected');
    if (result.kind === 'rejected') expect(result.error.kind, this.diagnostic()).toBe(kind);
  }
  same(event: Event = { kind: 'observe' }, input = this.input()): Extract<Transition, {kind:'same'}> {
    const result = this.run(event, input);
    if (result.kind !== 'same') throw new Error(`Expected public same.\n${this.diagnostic()}`);
    return result;
  }
  member() { return required(this.state.units[0]?.members[0], 'original member'); }
  ticket(id: string): Ticket { return required(tickets(this.state, this.input()).find(item => item.id === id), `ticket ${id}`); }
  workTicket(): Ticket { return this.ticket(`work:${required(this.member().work, 'owner work').id}`); }
  reply(ticket: Ticket, payload: ProtocolReply, caller: Caller = this.host.main): Extract<Event, {kind:'reply'}> {
    return { kind: 'reply', caller, ticket: ticket.id, revision: ticket.revision, payload, acceptedAt: 1_000 };
  }
  decide(item: DecisionCase, decision: CaseDecision): Event {
    return this.reply(this.ticket(`case:${item.id}`), { kind: 'decision', decision });
  }
  bind(request: SeatRequest, agentId = `agent-${request.role}`, parked = false): Caller {
    const sessionId = `${agentId}-session`;
    this.host.seats = [...this.host.seats, { agentId, requestedName: request.name, parentId: this.host.main.agentId, sessionId, createdAt: 200, status: parked ? 'parked' : 'running', plan: 'disabled', streaming: !parked }];
    this.next(this.reply(this.ticket(`spawn:${request.id}`), { kind: 'spawned', agentId }));
    return { agentId, sessionId, parentId: this.host.main.agentId, runId: this.host.runId, kind: 'sub', depth: 1 };
  }
  owner(parked = false): Caller {
    return this.bind(required(this.state.requests.find(item => item.id === this.member().ownerRequestId), 'owner request'), 'owner-one', parked);
  }
  effect(kind: Action['kind']): Effect { return required(this.state.effects.find(item => item.action.kind === kind && item.state.kind !== 'cancelled'), `${kind} effect`); }
  byId(id: string): Effect { return required(this.state.effects.find(item => item.id === id), `effect ${id}`); }
  failure(id: string): DecisionCase {
    return required(this.state.cases.find(item => (item.subject.kind === 'effectFailure' || item.subject.kind === 'hostPrecondition') && item.subject.effectId === id && (item.state.kind === 'open' || item.state.kind === 'awaitingExternal')), `failure case for ${id}`);
  }
}
function execute(w: World, id: string): void {
  w.next({ kind: 'effectStarted', id, attempt: w.byId(id).attempt + 1, startedAt: 1_000 });
}
function fail(w: World, id: string, outcome: 'knownFailed' | 'uncertain', error: PortError = outcome === 'knownFailed' ? denied : lost): void {
  w.next({ kind: 'effectFailed', id, attempt: w.byId(id).attempt, outcome, error });
}
function createDraft(w: World): string {
  const gate = required(w.member().review, 'review gate');
  const reviewer = w.bind(required(w.state.requests.find(item => item.id === gate.requestId), 'review request'), 'reviewer');
  w.next(w.reply(w.ticket(`gate:${gate.id}`), { kind: 'verdict', ok: false, note: 'An unrelated defect must be recorded outside this agenda.' }, reviewer));
  const finding = required(w.state.cases.find(item => item.subject.kind === 'findings'), 'findings case');
  w.next(w.decide(finding, { kind: 'outOfScope', draft: { repo, title: 'Record unrelated defect', body: 'The unrelated defect remains separately owned.', target, designOnly: false } }));
  return w.effect('createIssue').id;
}
function publishing(adopt = false): World {
  const w = new World(adopt);
  if (adopt) {
    required(w.source.prs[0], 'adopted PR').mergeable = 'no';
    w.next({ kind: 'observe' });
  }
  const owner = w.owner();
  w.next(w.reply(w.workTicket(), submit, owner));
  return w;
}
function bodyReplacement(): World {
  const w = new World();
  const owner = w.owner();
  w.next(w.reply(w.workTicket(), question, owner));
  const item = required(w.state.cases.find(item => item.subject.kind === 'claim'), 'question case');
  w.next(w.decide(item, { kind: 'amend', amendment: { kind: 'acceptanceMethod', affected: [issue], bodyEdits: [{ issue, expectedHash: required(w.source.issues[0], 'issue').bodyHash, body: 'Keep the product outcome; verify it by the revised concrete method.' }], transfer: { kind: 'existing', entry: { issue: transfer, target, designOnly: false, adoptPr: null }, position: { kind: 'after', unitId: required(w.state.units[0], 'unit').id } } } }));
  return w;
}
function rerunning(): World {
  const w = new World(true);
  const pr = required(w.source.prs[0], 'PR');
  pr.checks = { kind: 'failing', required: [{ kind: 'actions', identity: { name: 'required-runtime', source: { kind: 'app', id: 44 } }, checkRunId: 71, workflowRunId: 72, jobId: 73, runAttempt: 1, head: h1 }] };
  w.source.checkAttempts.push({ repo, workflowRunId: 72, attempt: 1, head: h1 });
  w.next({ kind: 'observe' });
  const owner = w.owner();
  w.next(w.reply(w.workTicket(), submit, owner));
  const publication = w.effect('publishPr');
  execute(w, publication.id);
  const result = satisfySource(w, publication.id);
  w.next({ kind: 'effectConfirmed', id: publication.id, attempt: 1, result });
  w.next({ kind: 'observe' });
  const item = required(w.state.cases.find(item => item.subject.kind === 'checks'), 'same-attempt checks case');
  w.next(w.decide(item, { kind: 'rerun', runId: 72 }));
  return w;
}
function fixture(kind: Action['kind']): { w: World; id: string } {
  let w: World;
  switch (kind) {
    case 'publishPr': w = publishing(); break;
    case 'wake': w = new World(); w.owner(true); w.next({ kind: 'observe' }); break;
    case 'merge': {
      w = new World(true);
      for (const kind of ['review', 'accept'] as const) {
        const gate = required(w.member()[kind], `${kind} gate`);
        const caller = w.bind(required(w.state.requests.find(item => item.id === gate.requestId), `${kind} request`), `${kind}-seat`);
        w.next(w.reply(w.ticket(`gate:${gate.id}`), { kind: 'verdict', ok: true, note: `Independent ${kind} passed for the exact source.` }, caller));
      }
      w.next({ kind: 'observe' });
      break;
    }
    case 'createIssue': w = new World(true, true); createDraft(w); break;
    case 'attachChild': {
      w = new World(true, true);
      const id = createDraft(w);
      execute(w, id);
      const result = satisfySource(w, id);
      w.next({ kind: 'effectConfirmed', id, attempt: 1, result });
      w.next({ kind: 'observe' });
      break;
    }
    case 'replaceBody': w = bodyReplacement(); break;
    case 'setIssueState':
      w = new World();
      w.next({ kind: 'mainNoCode', caller: w.host.main, member: issue, bodyHash: required(w.source.issues[0], 'issue').bodyHash, reason: 'Source proves there is no implementation change to make.', acceptedAt: 1_000 });
      w.next({ kind: 'observe' });
      break;
    case 'rerunChecks': w = rerunning(); break;
  }
  return { w, id: w.effect(kind).id };
}
function satisfySource(w: World, id: string): EffectResult {
  const effect = w.byId(id);
  const action = effect.action;
  switch (action.kind) {
    case 'publishPr': {
      const pr: PrSnapshot = { ...pullRequest(), ...w.source.prs.find(item => item.ref.number === action.pr?.number), title: action.submission.payload.title, body: action.body, bodyHash: hash(action.body) };
      w.source.prs = [pr];
      w.source.links = [{ issue, pr: pr.ref }];
      w.source.maintenance = [{ pr: pr.ref, result: { kind: 'maintainable', basis: { headRepo: repo, headBranch: submit.branch, viewerPermission: 'WRITE', author: 'RiriAgent', maintainerCanModify: true, authorization: { kind: 'systemCreated', effectId: id } } } }];
      return { kind: 'published', pr: pr.ref };
    }
    case 'createIssue':
      w.source.issues.push(snapshot(created, action.spec.body));
      w.source.createdIssues.push({ issue: created, title: action.spec.title, body: action.spec.body, actor: action.actor, createdAt: 1_001 });
      return { kind: 'created', issue: created };
    case 'attachChild':
      required(w.source.issues.find(item => item.ref.number === action.parent.number), 'source parent').children.push(action.child);
      return { kind: 'attached', parent: action.parent, child: action.child };
    case 'replaceBody': {
      const current = required(w.source.issues.find(item => item.ref.number === action.edit.issue.number), 'body target');
      current.body = action.edit.body; current.bodyHash = hash(current.body);
      return { kind: 'bodyReplaced', issue: action.edit.issue, hash: current.bodyHash };
    }
    case 'setIssueState': {
      const current = required(w.source.issues.find(item => item.ref.number === action.issue.number), 'state target');
      const event = { id: action.open ? 'source-reopen' : 'source-close', at: 1_001 };
      current.state = action.open ? 'open' : 'closed';
      if (action.open) current.lastReopen = event; else current.lastClose = event;
      return { kind: 'issueState', issue: action.issue, open: action.open, event };
    }
    case 'rerunChecks':
      w.source.checkAttempts = [{ repo: action.repo, workflowRunId: action.workflowRunId, attempt: action.previousAttempt + 1, head: action.head }];
      return { kind: 'rerun', repo: action.repo, workflowRunId: action.workflowRunId, attempt: action.previousAttempt + 1 };
    case 'merge':
      required(w.source.prs.find(item => item.ref.number === action.pr.number), 'merge PR').state = { kind: 'merged', sha: merged, at: 1_001 };
      return { kind: 'merged', pr: action.pr, merge: { repo: action.target.repo, sha: merged }, at: 1_001 };
    case 'wake': return { kind: 'delivered', agentId: action.holder, messageId: `${id}:${effect.attempt}`, outcome: 'woken' };
  }
}
function invalidateSource(w: World, id: string): void {
  const action = w.byId(id).action;
  switch (action.kind) {
    case 'publishPr': w.source.branches = [{ repo, name: submit.branch, state: { kind: 'present', head: h2 } }]; break;
    case 'createIssue': w.source.repos = []; break;
    case 'attachChild': w.source.issues = w.source.issues.filter(item => item.ref.number !== action.child.number); break;
    case 'replaceBody': {
      const current = required(w.source.issues.find(item => item.ref.number === action.edit.issue.number), 'body target');
      current.body = 'A later independent human edit.'; current.bodyHash = hash(current.body); break;
    }
    case 'setIssueState': {
      const current = required(w.source.issues.find(item => item.ref.number === action.issue.number), 'state target');
      current.body = 'A new contract must not be closed under the old decision.'; current.bodyHash = hash(current.body); break;
    }
    case 'rerunChecks': w.source.checkAttempts = [{ repo, workflowRunId: action.workflowRunId, attempt: action.previousAttempt + 1, head: action.head }]; break;
    case 'merge': required(w.source.prs[0], 'merge PR').head = h2; break;
    case 'wake': w.host.seats = []; break;
  }
}
const actions: readonly Action['kind'][] = ['publishPr', 'createIssue', 'attachChild', 'replaceBody', 'setIssueState', 'rerunChecks', 'merge', 'wake'];

describe('independent public effect lifecycle matrix', () => {
  for (const kind of actions) {
    test(`${kind}: reachable fixture parses, attempts are exact, action-specific preflight rejects changes`, () => {
      const { w, id } = fixture(kind);
      expect(parseAgenda(w.state), `${kind}: production-created state must parse`).toMatchObject({ ok: true });
      w.reject({ kind: 'effectStarted', id, attempt: 2, startedAt: 1_000 });
      w.reject({ kind: 'effectConfirmed', id, attempt: 1, result: { kind: 'created', issue: created } });
      w.reject({ kind: 'effectFailed', id, attempt: 0, outcome: 'uncertain', error: lost });
      w.reject({ kind: 'effectFailed', id, attempt: 0, outcome: 'knownFailed', error: denied });
      invalidateSource(w, id);
      const expected = kind === 'createIssue' || kind === 'attachChild' ? 'sourceUnavailable' : 'premiseChanged';
      w.reject({ kind: 'effectStarted', id, attempt: 1, startedAt: 1_000 }, expected);
      expect(w.byId(id).state.kind).toBe('ready');
      expect(w.byId(id).attempt).toBe(0);
    });
    test(`${kind}: successful call requires exact attempt and authoritative completion`, () => {
      const { w, id } = fixture(kind);
      execute(w, id);
      w.reject({ kind: 'effectStarted', id, attempt: 2, startedAt: 1_001 });
      w.reject({ kind: 'effectFailed', id, attempt: 2, outcome: 'knownFailed', error: denied });
      w.reject({ kind: 'effectConfirmed', id, attempt: 1, result: { kind: 'created', issue: { repo, number: 999 } } });
      w.reject({ kind: 'effectCancelled', id, reason: 'preconditionChanged' });
      const result = satisfySource(w, id);
      w.reject({ kind: 'effectSatisfied', id, result });
      w.reject({ kind: 'effectConfirmed', id, attempt: 2, result });
      w.next({ kind: 'effectConfirmed', id, attempt: 1, result });
      expect(w.byId(id).state, w.diagnostic()).toEqual({ kind: 'confirmed', result });
      expect(w.byId(id).attempt).toBe(1);
      const before = structuredClone(w.state);
      w.same({ kind: 'effectCancelled', id, reason: 'superseded' });
      expect(w.state).toEqual(before);
    });
    test(`${kind}: explicit failure remains visible, is not timer retried, and same facts converge`, () => {
      const { w, id } = fixture(kind);
      execute(w, id); fail(w, id, 'knownFailed');
      expect(w.byId(id).state).toMatchObject({ kind: 'failed', attempt: 1, error: denied, wait: null });
      const item = w.failure(id);
      expect(w.ticket(`case:${item.id}`).runDisposition).toBe('mustRun');
      w.reject({ kind: 'effectStarted', id, attempt: 2, startedAt: 2_000 });
      // The first observation may expose newly actionable objects; after it,
      // changing only the read timestamp must not write another state/version.
      w.run({ kind: 'observe' });
      for (const observedAt of [2_000, 5_000, 9_000]) { w.observedAt = observedAt; w.same(); }
      expect(w.byId(id).state.kind).toBe('failed');
      expect(w.byId(id).attempt).toBe(1);
    });
    test(`${kind}: unknown execution cannot be blindly retried or cancelled while still applicable`, () => {
      const { w, id } = fixture(kind);
      execute(w, id); fail(w, id, 'uncertain');
      const item = w.failure(id);
      const decision: CaseDecision = { kind: 'retry', effectId: id, attempt: 1 };
      w.reject(w.decide(item, decision), 'invalidDecision');
      w.reject({ kind: 'effectStarted', id, attempt: 2, startedAt: 2_000 });
      w.reject({ kind: 'effectCancelled', id, reason: 'preconditionChanged' });
      w.run({ kind: 'observe' });
      w.observedAt = 10_000; w.same();
      expect(w.byId(id).state.kind, w.diagnostic()).toBe('uncertain');
      expect(w.byId(id).attempt).toBe(1);
    });
    test(`${kind}: ready cancellation is terminal without pretending a call occurred`, () => {
      const { w, id } = fixture(kind);
      w.next({ kind: 'effectCancelled', id, reason: 'targetBecameInapplicable' });
      expect(w.byId(id).state).toEqual({ kind: 'cancelled', reason: 'targetBecameInapplicable' });
      expect(w.byId(id).attempt).toBe(0);
      w.reject({ kind: 'effectStarted', id, attempt: 1, startedAt: 2_000 });
      w.same({ kind: 'effectCancelled', id, reason: 'superseded' });
    });
    test(`${kind}: query satisfaction never invents an execution attempt`, () => {
      const { w, id } = fixture(kind);
      const result = satisfySource(w, id);
      if (kind === 'wake' || kind === 'createIssue') {
        w.reject({ kind: 'effectSatisfied', id, result });
        expect(w.byId(id).attempt).toBe(0);
      } else {
        w.next({ kind: 'effectSatisfied', id, result });
        expect(w.byId(id).state).toEqual({ kind: 'confirmed', result });
        expect(w.byId(id).attempt).toBe(0);
      }
    });
    if (kind !== 'wake' && kind !== 'createIssue') test(`${kind}: unknown response can resolve from source but not with a different result`, () => {
      const { w, id } = fixture(kind);
      execute(w, id); fail(w, id, 'uncertain');
      w.reject({ kind: 'effectSatisfied', id, result: { kind: 'created', issue: created } });
      const result = satisfySource(w, id);
      w.next({ kind: 'effectSatisfied', id, result });
      expect(w.byId(id).state).toEqual({ kind: 'confirmed', result });
      expect(w.byId(id).attempt).toBe(1);
    });
    if (kind !== 'wake') test(`${kind}: explicit retry of a source-rejected call retains the intent and rechecks source before attempt two`, () => {
      const { w, id } = fixture(kind);
      execute(w, id); fail(w, id, 'knownFailed');
      w.reject(w.decide(w.failure(id), { kind: 'retry', effectId: id, attempt: 0 }), 'invalidDecision');
      w.next(w.decide(w.failure(id), { kind: 'retry', effectId: id, attempt: 1 }));
      expect(w.byId(id)).toMatchObject({ attempt: 1, authorization: 'retry', state: { kind: 'ready' } });
      const unchangedSource = structuredClone(w.source);
      invalidateSource(w, id);
      const expected = kind === 'createIssue' || kind === 'attachChild' ? 'sourceUnavailable' : 'premiseChanged';
      w.reject({ kind: 'effectStarted', id, attempt: 2, startedAt: 2_000 }, expected);
      expect(w.byId(id).attempt).toBe(1);
      w.source = unchangedSource;
      execute(w, id);
      expect(w.byId(id)).toMatchObject({ attempt: 2, state: { kind: 'executing', attempt: 2 } });
      const result = satisfySource(w, id);
      w.next({ kind: 'effectConfirmed', id, attempt: 2, result });
      expect(w.byId(id).state).toEqual({ kind: 'confirmed', result });
    });
  }
});

describe('creation ambiguity and explicit ownership', () => {
  function unknownCreation() {
    const trace = fixture('createIssue'); execute(trace.w, trace.id); fail(trace.w, trace.id, 'uncertain'); return trace;
  }
  test('zero candidates never authorizes automatic create; explicit absence retry preserves EffectId and increments only on call', () => {
    const { w, id } = unknownCreation();
    w.run({ kind: 'observe' }); w.observedAt = 4_000; w.same();
    expect(w.byId(id).state.kind).toBe('uncertain');
    w.next(w.decide(w.failure(id), { kind: 'retryAfterAbsence', effectId: id, attempt: 1 }));
    expect(w.byId(id)).toMatchObject({ attempt: 1, authorization: 'retryAfterAbsence', state: { kind: 'ready' } });
    execute(w, id);
    expect(w.byId(id)).toMatchObject({ attempt: 2, state: { kind: 'executing', attempt: 2 } });
  });
  test('candidate ambiguity stays uncertain; Main may adopt only the selected source-verified identity', () => {
    const { w, id } = unknownCreation();
    const result = satisfySource(w, id);
    const other = { repo, number: 14 };
    const first = required(w.source.createdIssues[0], 'creation candidate');
    w.source.createdIssues.push({ ...first, issue: other });
    w.source.issues.push(snapshot(other, first.body));
    w.run({ kind: 'observe' });
    expect(w.byId(id).state.kind).toBe('uncertain');
    w.reject(w.decide(w.failure(id), { kind: 'retryAfterAbsence', effectId: id, attempt: 1 }), 'invalidDecision');
    w.reject(w.decide(w.failure(id), { kind: 'adoptResult', effectId: id, result: { kind: 'issue', issue: { repo, number: 999 } } }), 'invalidDecision');
    w.next(w.decide(w.failure(id), { kind: 'adoptResult', effectId: id, result: { kind: 'issue', issue: created } }));
    expect(w.byId(id).state).toEqual({ kind: 'confirmed', result });
    expect(w.state.drafts[0]?.state.kind).toBe('proposed');
    w.next({ kind: 'observe' });
    expect(w.state.drafts[0]?.state).toEqual({ kind: 'registered', issue: created });
    expect(w.effect('attachChild').state.kind).toBe('ready');
  });
  test('even one creation candidate is not proof of original attempt identity', () => {
    const { w, id } = unknownCreation(); const result = satisfySource(w, id);
    w.reject({ kind: 'effectSatisfied', id, result });
    w.run({ kind: 'observe' });
    expect(w.byId(id).state.kind).toBe('uncertain');
    w.reject(w.decide(w.failure(id), { kind: 'retryAfterAbsence', effectId: id, attempt: 1 }), 'invalidDecision');
  });
  test('a title/body/actor match predating startedAt is not a creation candidate', () => {
    const { w, id } = unknownCreation(); satisfySource(w, id);
    required(w.source.createdIssues[0], 'candidate').createdAt = 999;
    w.reject(w.decide(w.failure(id), { kind: 'adoptResult', effectId: id, result: { kind: 'issue', issue: created } }), 'invalidDecision');
  });
  test('absence retry requires the fresh creation search in the available read scope', () => {
    const { w, id } = unknownCreation();
    const input = w.input();
    if (input.facts.kind !== 'available') throw new Error('own fixture must have available facts');
    input.facts.scope.creations = [];
    w.reject(w.decide(w.failure(id), { kind: 'retryAfterAbsence', effectId: id, attempt: 1 }), 'sourceUnavailable', input);
  });
  test('creation confirmation rejects contradictory actor/title/source body', () => {
    const { w, id } = fixture('createIssue'); execute(w, id);
    const result = satisfySource(w, id);
    required(w.source.createdIssues[0], 'candidate').actor = 'OtherActor';
    w.reject({ kind: 'effectConfirmed', id, attempt: 1, result });
    expect(w.byId(id).state.kind).toBe('executing');
  });
});

describe('rate limits and waits are not mutation authorization', () => {
  for (const outcome of ['knownFailed', 'uncertain'] as const) {
    test(`${outcome}: reset timestamp and source condition never automatically resend`, () => {
      const { w, id } = fixture('publishPr'); execute(w, id);
      fail(w, id, outcome, { kind: 'rateLimited', message: 'Source supplied a real reset.', resetAt: 8_000 });
      expect(w.byId(id).state).toMatchObject({ kind: outcome === 'knownFailed' ? 'failed' : 'uncertain', wait: { kind: 'rateLimitReset', resetAt: 8_000 } });
      w.run({ kind: 'observe' });
      for (const observedAt of [7_999, 8_000, 9_000]) { w.observedAt = observedAt; w.same(); }
      w.reject({ kind: 'effectStarted', id, attempt: 2, startedAt: 9_000 });
      expect(w.byId(id).attempt).toBe(1);
      w.next(w.decide(w.failure(id), { kind: 'waitExternal', condition: { kind: 'issueState', issue: transfer, open: false }, reason: 'Wait for an actual external source condition, not elapsed time.' }));
      const waiting = w.failure(id);
      expect(w.ticket(`case:${waiting.id}`).runDisposition).toBe('mayWait');
      required(w.source.issues.find(item => item.ref.number === transfer.number), 'transfer').state = 'closed';
      w.next({ kind: 'observe' });
      expect(w.byId(id).state).toMatchObject({ kind: outcome === 'knownFailed' ? 'failed' : 'uncertain', wait: null });
      expect(w.failure(id).contentVersion).toBe(waiting.contentVersion + 1);
      w.reject({ kind: 'effectStarted', id, attempt: 2, startedAt: 9_000 });
    });
  }
  test('Main cannot override a source rate-limit reset by authorizing mutation before it', () => {
    const { w, id } = fixture('publishPr'); execute(w, id);
    fail(w, id, 'knownFailed', { kind: 'rateLimited', message: 'Source reset applies until 8000.', resetAt: 8_000 });
    w.observedAt = 2_000;
    // Local authorization may be accepted in advance, but it cannot permit a
    // network mutation while the source's reset remains in force.
    const authorization = w.run(w.decide(w.failure(id), { kind: 'retry', effectId: id, attempt: 1 }));
    if (authorization.kind === 'rejected') expect(authorization.error.kind, w.diagnostic()).toBe('invalidDecision');
    else {
      expect(authorization.kind, w.diagnostic()).toBe('next');
      w.reject({ kind: 'effectStarted', id, attempt: 2, startedAt: 2_000 });
    }
  });
  test('an already-satisfied failed intent confirms after explicit retry without another attempt', () => {
    const { w, id } = fixture('publishPr'); execute(w, id); fail(w, id, 'knownFailed');
    const result = satisfySource(w, id);
    const attempts = w.byId(id).attempt; const failure = w.failure(id);
    w.next(w.decide(failure, { kind: 'retry', effectId: id, attempt: attempts }));
    w.reject({ kind: 'effectStarted', id, attempt: attempts + 1, startedAt: 2_000 }, 'premiseChanged');
    w.next({ kind: 'effectSatisfied', id, result }); w.run({ kind: 'observe' });
    expect(w.byId(id).attempt).toBe(attempts);
    expect(w.byId(id).state).toEqual({ kind: 'confirmed', result });
    expect(w.state.cases.find(item => item.id === failure.id)?.state.kind).toBe('resolved');
  });
});

describe('unsent body conflicts and precise rebase recovery', () => {
  for (const kind of ['publishPr', 'replaceBody'] as const) {
    function conflict(): {w:World;id:string} {
      const w = kind === 'publishPr' ? publishing(true) : bodyReplacement();
      const id = w.effect(kind).id;
      if (kind === 'publishPr') {
        const pr = required(w.source.prs[0], 'PR'); pr.body = 'Human-authored addition.\n\nCloses Audit/effect-recovery#11'; pr.bodyHash = hash(pr.body);
      } else invalidateSource(w, id);
      return { w, id };
    }
    test(`${kind}: known unsent conflict opens exact EffectId recovery, preserves accepted submission, and rebases without new intent`, () => {
      const { w, id } = conflict();
      const baseline = structuredClone(w.member().baseline);
      w.next({ kind: 'effectFailed', id, attempt: 0, outcome: 'knownFailed', error: { kind: 'precondition', message: 'Current body is neither expected nor target.' } });
      expect(w.byId(id)).toMatchObject({ attempt: 0, state: { kind: 'failed', attempt: 0 } });
      const currentHash = kind === 'publishPr' ? required(w.source.prs[0], 'PR').bodyHash : required(w.source.issues[0], 'issue').bodyHash;
      const body = 'Human-authored addition retained.\n\nCloses Audit/effect-recovery#11\n\nRebased evidence.';
      w.reject(w.decide(w.failure(id), { kind: 'rebaseEdit', effectId: id, expectedHash: hash('An obsolete body'), body }), 'invalidDecision');
      w.next(w.decide(w.failure(id), { kind: 'rebaseEdit', effectId: id, expectedHash: currentHash, body }));
      expect(w.byId(id)).toMatchObject({ attempt: 0, state: { kind: 'ready' } });
      expect(w.member().baseline).toEqual(baseline);
      const applying = required(w.state.cases.find(item => item.subject.kind === 'effectFailure' && item.subject.effectId === id), 'recovery case');
      expect(applying.state).toMatchObject({ kind: 'applying', required: [{ kind: 'effect', effectId: id }] });
      execute(w, id); const result = satisfySource(w, id);
      w.next({ kind: 'effectConfirmed', id, attempt: 1, result });
      w.next({ kind: 'observe' });
      expect(w.state.cases.find(item => item.id === applying.id)?.state.kind).toBe('resolved');
    });
    test(`${kind}: unsent conflict must match attempt zero`, () => {
      const { w, id } = conflict();
      w.reject({ kind: 'effectFailed', id, attempt: 27, outcome: 'knownFailed', error: { kind: 'precondition', message: 'Current body conflicts.' } });
    });
    test(`${kind}: missing source is not proof of a ready body conflict`, () => {
      const { w, id } = conflict();
      const input = w.input(); input.facts = { kind: 'unavailable', error: { kind: 'unavailable', message: 'Source read failed; body is unknown.' } };
      w.reject({ kind: 'effectFailed', id, attempt: 0, outcome: 'knownFailed', error: { kind: 'precondition', message: 'Caller labels an unavailable read a conflict.' } }, 'premiseChanged', input);
    });
    test(`${kind}: rebase cannot resend an uncertain write`, () => {
      const { w, id } = kind === 'publishPr' ? (() => { const w = publishing(true); return { w, id: w.effect(kind).id }; })() : fixture(kind);
      execute(w, id); fail(w, id, 'uncertain');
      const currentHash = kind === 'publishPr' ? required(w.source.prs[0], 'PR').bodyHash : required(w.source.issues[0], 'issue').bodyHash;
      w.reject(w.decide(w.failure(id), { kind: 'rebaseEdit', effectId: id, expectedHash: currentHash, body: 'Do not resend an unknown write.' }), 'invalidDecision');
    });
  }
  test('a branch/head mismatch alone is not the special ready publication body-conflict path', () => {
    const { w, id } = fixture('publishPr'); invalidateSource(w, id);
    w.reject({ kind: 'effectFailed', id, attempt: 0, outcome: 'knownFailed', error: { kind: 'precondition', message: 'Branch SHA changed, not a source body conflict.' } });
  });
});

describe('native delivery intent and explicit repeated-delivery risk', () => {
  for (const outcome of ['knownFailed', 'uncertain'] as const) test(`${outcome}: live registry is not delivery proof; retryHost explicitly authorizes exactly one further attempt`, () => {
    const { w, id } = fixture('wake'); execute(w, id); fail(w, id, outcome);
    const action = w.byId(id).action;
    if (action.kind !== 'wake') throw new Error('own wake fixture');
    const workId = w.member().work?.id;
    w.run({ kind: 'observe' }); w.same();
    w.reject({ kind: 'effectSatisfied', id, result: satisfySource(w, id) });
    expect(w.byId(id).state.kind).toBe(outcome === 'knownFailed' ? 'failed' : 'uncertain');
    expect(w.state.effects.filter(effect => effect.action.kind === 'wake')).toHaveLength(1);
    w.next(w.decide(w.failure(id), { kind: 'retryHost', requestId: action.requestId }));
    expect(w.byId(id)).toMatchObject({ attempt: 1, authorization: 'retryHost', state: { kind: 'ready' } });
    execute(w, id);
    const result = satisfySource(w, id);
    w.next({ kind: 'effectConfirmed', id, attempt: 2, result });
    expect(w.member().work?.id).toBe(workId);
    expect(w.member().work).not.toBeNull();
    w.next({ kind: 'observe' }); w.same();
    expect(w.state.effects.filter(effect => effect.action.kind === 'wake')).toHaveLength(1);
  });
  test('idle plan failure cannot be retried until the actual holder leaves plan mode', () => {
    const { w, id } = fixture('wake'); execute(w, id);
    const seat = required(w.host.seats[0], 'holder'); seat.plan = 'enabled'; seat.streaming = false;
    fail(w, id, 'knownFailed', { kind: 'precondition', message: 'ensureLive found an idle plan-mode session; deliver was not called.' });
    const action = w.byId(id).action; if (action.kind !== 'wake') throw new Error('own wake');
    w.reject(w.decide(w.failure(id), { kind: 'retryHost', requestId: action.requestId }), 'invalidDecision');
    seat.plan = 'disabled';
    w.next(w.decide(w.failure(id), { kind: 'retryHost', requestId: action.requestId }));
  });
  test('confirmed delivery needs exact post-delivery agent_end, not park/live status; nonresponse retry creates a new EffectId', () => {
    const { w, id } = fixture('wake'); execute(w, id);
    const action = w.byId(id).action; if (action.kind !== 'wake') throw new Error('own wake');
    const result = satisfySource(w, id);
    w.next({ kind: 'effectConfirmed', id, attempt: 1, result });
    w.same();
    expect(w.state.cases.filter(item => item.subject.kind === 'hostPrecondition')).toHaveLength(0);
    w.host.turnEnds = [{ agentId: action.holder, runId: 'wrong-run', messageId: `${id}:1` }, { agentId: action.holder, runId: action.runId, messageId: 'wrong-message' }];
    w.same();
    w.host.turnEnds = [{ agentId: action.holder, runId: action.runId, messageId: `${id}:1` }];
    w.next({ kind: 'observe' });
    const item = w.failure(id);
    expect(item.subject).toMatchObject({ kind: 'hostPrecondition', reason: 'seatNonresponse', effectId: id });
    w.next(w.decide(item, { kind: 'retryHost', requestId: action.requestId }));
    expect(w.byId(id).state).toEqual({ kind: 'confirmed', result });
    const next = required(w.state.effects.find(effect => effect.id !== id && effect.action.kind === 'wake'), 'new delivery intent');
    expect(next).toMatchObject({ attempt: 0, authorization: 'retryHost', state: { kind: 'ready' } });
    execute(w, next.id); const nextResult = satisfySource(w, next.id);
    w.next({ kind: 'effectConfirmed', id: next.id, attempt: 1, result: nextResult });
    w.next({ kind: 'observe' });
    w.same();
    expect(w.state.effects.filter(effect => effect.action.kind === 'wake')).toHaveLength(2);
    expect(w.state.cases.find(candidate => candidate.id === item.id)?.state.kind).toBe('resolved');
  });
  test('an unknown current-run wake is preserved when a claim consumes its actionable ticket', () => {
    const { w, id } = fixture('wake'); execute(w, id); fail(w, id, 'uncertain');
    const request = required(w.state.requests.find(item => item.id === w.member().ownerRequestId), 'owner request');
    const binding = request.binding; if (binding.kind !== 'bound') throw new Error('bound own fixture');
    const owner: Caller = { agentId: binding.agentId, sessionId: binding.sessionId, parentId: binding.parentId, runId: w.host.runId, kind: 'sub', depth: 1 };
    w.next(w.reply(w.workTicket(), question, owner));
    w.run({ kind: 'observe' }); w.same();
    expect(w.byId(id).state.kind).toBe('uncertain');
    expect(w.workTicket().runDisposition).toBe('mayWait');
    expect(w.state.effects.filter(effect => effect.action.kind === 'wake')).toHaveLength(1);
  });
  test('aborted binding source permits unknown cancellation; same holder still live does not', () => {
    const { w, id } = fixture('wake'); execute(w, id); fail(w, id, 'uncertain');
    w.reject({ kind: 'effectCancelled', id, reason: 'holderAbsent' });
    required(w.host.seats[0], 'holder').status = 'aborted';
    w.next({ kind: 'effectCancelled', id, reason: 'holderAbsent' });
    expect(w.byId(id).state).toEqual({ kind: 'cancelled', reason: 'holderAbsent' });
  });
  test('explicit new-run resume cancels old unknown delivery, preserves WorkId, and creates only a new binding request', () => {
    const { w, id } = fixture('wake'); execute(w, id); fail(w, id, 'uncertain');
    const workId = w.member().work?.id;
    const oldRequest = w.member().ownerRequestId;
    w.host = { ...w.host, runId: 'run-two', main: { ...main, runId: 'run-two', sessionId: 'main-session-two' }, seats: [], turnEnds: [] };
    w.reject({ kind: 'observe' }, 'ownershipBlocked');
    w.next({ kind: 'resume', runId: 'run-two', operatorConfirmedOriginalSessionEnded: true });
    expect(w.byId(id).state).toEqual({ kind: 'cancelled', reason: 'holderAbsent' });
    w.next({ kind: 'observe' });
    expect(w.member().work?.id).toBe(workId);
    expect(w.member().ownerRequestId).not.toBe(oldRequest);
    const request = required(w.state.requests.find(item => item.id === w.member().ownerRequestId), 'new request');
    expect(request).toMatchObject({ runId: 'run-two', binding: { kind: 'unbound' } });
    expect(w.ticket(`spawn:${request.id}`).holder).toEqual({ kind: 'main' });
    const owner = w.bind(request, 'owner-two', true);
    w.next({ kind: 'observe' });
    const fresh = w.effect('wake'); expect(fresh.id).not.toBe(id);
    expect(fresh.action).toMatchObject({ kind: 'wake', holder: owner.agentId, runId: 'run-two' });
    w.same();
  });
});

describe('exact receipt identity precedes replay and source access', () => {
  function submitted() {
    const w = new World(); const caller = w.owner(); const ticket = w.workTicket();
    const event = w.reply(ticket, submit, caller); const result = w.next(event);
    return { w, caller, ticket, event, receipt: result.reply };
  }
  test('same receipt returns its original ReplyResult even when the source is unavailable; a changed terminal payload conflicts', () => {
    const { w, event, receipt } = submitted();
    const input = w.input(); input.facts = { kind: 'unavailable', error: { kind: 'unavailable', message: 'Do not access GitHub to replay a local accepted result.' } };
    expect(w.same(event, input).reply).toEqual(receipt);
    w.reject({ ...event, payload: { ...submit, title: 'Different terminal payload' } }, 'replyConflict', input);
  });
  for (const mismatch of ['agent', 'session', 'parent', 'run', 'depth', 'main'] as const) test(`receipt auth rejects ${mismatch} mismatch before returning a replay or conflict`, () => {
    const { w, event, caller } = submitted();
    const invalid: Caller = { ...caller };
    switch (mismatch) {
      case 'agent': invalid.agentId = 'extra-agent'; break;
      case 'session': invalid.sessionId = 'different-session'; break;
      case 'parent': invalid.parentId = 'different-parent'; break;
      case 'run': invalid.runId = 'old-run'; break;
      case 'depth': invalid.depth = 2; break;
      case 'main': invalid.kind = 'main'; invalid.depth = 0; break;
    }
    const input = w.input(); input.facts = { kind: 'unavailable', error: lost };
    w.reject({ ...event, caller: invalid }, 'unauthorized', input);
    w.reject({ ...event, caller: invalid, payload: { ...submit, title: 'Attempt to bypass authentication using conflict lookup' } }, 'unauthorized', input);
  });
  test('a real successor holder can replay the previous member receipt; an old holder cannot', () => {
    const { w, caller: oldCaller, event, receipt } = submitted();
    const publication = w.effect('publishPr'); execute(w, publication.id);
    const result = satisfySource(w, publication.id);
    w.next({ kind: 'effectConfirmed', id: publication.id, attempt: 1, result });
    required(w.source.prs[0], 'PR').head = h2;
    w.source.branches = [{ repo, name: submit.branch, state: { kind: 'present', head: h2 } }];
    required(w.host.seats.find(seat => seat.agentId === oldCaller.agentId), 'old seat').status = 'aborted';
    w.next({ kind: 'observe' });
    const request = required(w.state.requests.find(item => item.id === w.member().ownerRequestId), 'successor request');
    const successor = w.bind(request, 'successor');
    const input = w.input(); input.facts = { kind: 'unavailable', error: lost };
    expect(w.same({ ...event, caller: successor }, input).reply).toEqual(receipt);
    w.reject({ ...event, caller: oldCaller }, 'unauthorized', input);
    w.reject({ ...event, caller: successor, payload: { ...submit, head: h2 } }, 'replyConflict', input);
  });
  test('old accepted wait payload replays while a changed payload cannot override the reopened newer revision', () => {
    const { w, id } = fixture('publishPr'); execute(w, id); fail(w, id, 'knownFailed');
    const item = w.failure(id);
    const wait = w.decide(item, { kind: 'waitExternal', condition: { kind: 'issueState', issue: transfer, open: false }, reason: 'Wait for verified external preparation.' });
    const accepted = w.next(wait).reply;
    const waitingRevision = w.failure(id).contentVersion;
    required(w.source.issues.find(item => item.ref.number === transfer.number), 'transfer').state = 'closed';
    w.next({ kind: 'observe' });
    expect(w.failure(id).contentVersion).toBe(waitingRevision + 1);
    expect(w.same(wait).reply).toEqual(accepted);
    if (wait.kind !== 'reply') throw new Error('own reply');
    w.reject({ ...wait, payload: { kind: 'decision', decision: { kind: 'retry', effectId: id, attempt: 1 } } }, 'replyConflict');
    w.reject({ ...wait, revision: waitingRevision, payload: { kind: 'decision', decision: { kind: 'retry', effectId: id, attempt: 1 } } }, 'staleRevision');
  });
  test('changing only available source generation/observedAt and repeated tickets is state inert', () => {
    const w = new World(); const before = structuredClone(w.state);
    const first = tickets(w.state, w.input());
    for (const n of [2, 3, 10]) {
      w.observedAt += n;
      const input = w.input(); if (input.facts.kind !== 'available') throw new Error('own available facts'); input.facts.generation = n;
      expect(tickets(w.state, input)).toEqual(first);
      w.same({ kind: 'observe' }, input);
    }
    expect(w.state).toEqual(before);
  });
});

describe('query result ambiguity and source-proven inapplicability', () => {
  test('two exact publish candidates cannot be inferred as one result; Main must select a source-verified PR', () => {
    const { w, id } = fixture('publishPr'); execute(w, id); fail(w, id, 'uncertain');
    satisfySource(w, id);
    const first = required(w.source.prs[0], 'matching publication');
    w.source.prs.push({ ...structuredClone(first), ref: { repo, number: 22 } });
    w.reject({ kind: 'effectSatisfied', id, result: { kind: 'published', pr: prRef } });
    w.run({ kind: 'observe' });
    expect(w.byId(id).state.kind).toBe('uncertain');
    w.next(w.decide(w.failure(id), { kind: 'adoptResult', effectId: id, result: { kind: 'pr', pr: prRef } }));
    expect(w.member().binding).toMatchObject({ kind: 'registered', pr: prRef });
    expect(w.byId(id).state).toEqual({ kind: 'confirmed', result: { kind: 'published', pr: prRef } });
  });
  test('closed-unmerged source proves an unknown merge inapplicable but does not invent merge or no-code', () => {
    const { w, id } = fixture('merge'); execute(w, id); fail(w, id, 'uncertain');
    required(w.source.prs[0], 'merge PR').state = { kind: 'closed' };
    w.next({ kind: 'effectCancelled', id, reason: 'targetBecameInapplicable' });
    w.next({ kind: 'observe' });
    expect(w.member().terminal.kind).toBe('pending');
    expect(w.state.cases.some(item => item.subject.kind === 'unexpectedSourceChange' && item.state.kind === 'open')).toBe(true);
    expect(w.byId(id).attempt).toBe(1);
  });
  test('satisfaction cannot be accepted against unavailable facts even if a caller supplies a plausible result', () => {
    const { w, id } = fixture('publishPr'); execute(w, id); fail(w, id, 'uncertain');
    const result = satisfySource(w, id);
    const input = w.input(); input.facts = { kind: 'unavailable', error: lost };
    w.reject({ kind: 'effectSatisfied', id, result }, 'premiseChanged', input);
    expect(w.byId(id).state.kind).toBe('uncertain');
  });
});
