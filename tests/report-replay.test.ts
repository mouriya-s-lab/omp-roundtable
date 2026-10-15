import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createAgenda,
  parseAgenda,
  tickets,
  transition,
  type Agenda,
  type Caller,
  type DomainError,
  type Event,
  type Facts,
  type Inputs,
  type ReplyResult,
  type Ticket,
} from '../src/domain/index.ts';

const repo = { owner: 'report-replay', name: 'independent-fixture' };
const member = { repo, number: 11 };
const body = 'Already satisfied: no implementation change is required.';
const bodyHash = createHash('sha256').update(body).digest('hex');
const originalMain: Caller = {
  agentId: 'main-original', sessionId: 'main-original-session',
  runId: 'original-run', parentId: null, kind: 'main', depth: 0,
};
const successorMain: Caller = {
  agentId: 'main-successor', sessionId: 'main-successor-session',
  runId: 'successor-run', parentId: null, kind: 'main', depth: 0,
};
const summary = 'The member was verified as no-code, closed at source, and independently accepted. No parent was convened.';

function inputs(facts: Facts, main: Caller = originalMain): Inputs {
  return {
    facts: {
      kind: 'available', generation: 1, observedAt: 100,
      scope: { issues: [member], prs: [], repos: [{ repo, bases: ['main'] }], branches: [], commits: [], checkRuns: [], creations: [] },
      facts,
    },
    host: {
      runId: main.runId, main, seats: [], turnEnds: [],
      preflight: { ok: true, value: {
        asyncEnabled: true, isolationEnabled: true, asyncManager: true,
        gitCwd: '/tmp/report-replay-fixture',
        agents: [{ name: 'task:free', blocking: false }],
      } },
    },
    policy: { text: 'Independent deterministic report-replay contract.', ownerAgent: 'task:free', gateAgent: 'task:free' },
  };
}

function unavailable(main: Caller): Inputs {
  const input = inputs({
    viewer: 'fixture-actor', issues: [], prs: [], links: [], repos: [], branches: [],
    maintenance: [], commits: [], checkAttempts: [], createdIssues: [],
  }, main);
  input.facts = { kind: 'unavailable', error: { kind: 'unavailable', message: 'Source deliberately unavailable during local receipt replay' } };
  return input;
}

function advance(state: Agenda, input: Inputs, event: Event): { state: Agenda; receipt: ReplyResult | null } {
  const before = JSON.stringify(state);
  const result = transition(state, input, event);
  expect(JSON.stringify(state)).toBe(before);
  if (result.kind !== 'next') throw new Error(`Legal completion step ${event.kind} did not advance: ${JSON.stringify(result)}`);
  expect(result.state.version).toBe(state.version + 1);
  return { state: result.state, receipt: result.reply };
}

function requireTicket(state: Agenda, input: Inputs, reply: Ticket['allowedReplies'][number]): Ticket {
  const ticket = tickets(state, input).find(candidate => candidate.allowedReplies.includes(reply));
  if (!ticket) throw new Error(`Missing legal ${reply} ticket: ${JSON.stringify(tickets(state, input))}`);
  return ticket;
}

function completeLegally(): { state: Agenda; report: Ticket; receipt: ReplyResult; closeEffectId: string } {
  const facts: Facts = {
    viewer: 'fixture-actor',
    issues: [{ ref: member, body, bodyHash, updatedAt: 100, state: 'open', lastClose: null, lastReopen: null, children: [] }],
    prs: [], links: [], branches: [], maintenance: [], commits: [], checkAttempts: [], createdIssues: [],
    repos: [{ repo, defaultBranch: 'main', defaultHead: 'a'.repeat(40), bases: [{
      name: 'main', state: { kind: 'present', head: 'a'.repeat(40), isDefault: true,
        rules: { required: [], strict: false, upToDate: true, constraints: [] } },
    }] }],
  };
  const input = inputs(facts);
  const created = createAgenda({
    op: 'convene', mode: 'execute', parent: null,
    entries: [{ issue: member, target: { repo, base: 'main' }, designOnly: false, adoptPr: null }],
  }, facts, 100, '4b82b810-67cc-4d17-91bd-eaab383a69f6');
  if (!created.ok) throw new Error(`Convene failed: ${JSON.stringify(created.error)}`);
  let state = advance(created.value, input, { kind: 'observe' }).state;
  state = advance(state, input, {
    kind: 'mainNoCode', caller: originalMain, member, bodyHash,
    reason: 'The issue explicitly describes an already-satisfied requirement; no code or design change is needed.', acceptedAt: 110,
  }).state;
  state = advance(state, input, { kind: 'observe' }).state;
  const close = state.effects.find(effect => effect.action.kind === 'setIssueState' && !effect.action.open);
  if (!close) throw new Error('No-code must produce an actual close intention before completion');
  expect(close.state.kind).toBe('ready');

  // Only the external source changes here; no Agenda field or receipt is manufactured.
  const closed = { id: 'source-close-11', at: 120 };
  facts.issues = [{ ref: member, body, bodyHash, updatedAt: 120, state: 'closed', lastClose: closed, lastReopen: null, children: [] }];
  state = advance(state, input, {
    kind: 'effectSatisfied', id: close.id,
    result: { kind: 'issueState', issue: member, open: false, event: closed },
  }).state;
  state = advance(state, input, { kind: 'observe' }).state;
  const gate = requireTicket(state, input, 'verdict');
  expect(gate.context.kind).toBe('unit');
  if (gate.holder.kind !== 'seat') throw new Error('Post-merge acceptance requires an independent seat');
  const request = state.requests.find(candidate => gate.holder.kind === 'seat' && candidate.id === gate.holder.requestId)
  if (!request) throw new Error('The public gate must reference a real SeatRequest');
  expect(request.role).toBe('postMerge');
  const seat: Caller = {
    agentId: 'independent-post-merge-seat', sessionId: 'independent-post-merge-session',
    parentId: originalMain.agentId, runId: originalMain.runId, kind: 'sub', depth: 1,
  };
  input.host.seats = [{
    agentId: seat.agentId, sessionId: seat.sessionId, parentId: seat.parentId,
    requestedName: request.name, createdAt: 130, status: 'running', plan: 'disabled', streaming: true,
  }];
  const spawn = requireTicket(state, input, 'spawned');
  state = advance(state, input, {
    kind: 'reply', caller: originalMain, ticket: spawn.id, revision: spawn.revision,
    payload: { kind: 'spawned', agentId: seat.agentId }, acceptedAt: 131,
  }).state;
  state = advance(state, input, {
    kind: 'reply', caller: seat, ticket: gate.id, revision: gate.revision,
    payload: { kind: 'verdict', ok: true, note: 'Independently checked the unchanged requirement, no-code basis, and actual issue closure.' }, acceptedAt: 140,
  }).state;
  state = advance(state, input, { kind: 'observe' }).state;
  const report = requireTicket(state, input, 'report');
  expect(report.holder).toEqual({ kind: 'main' });
  expect(state.lifecycle).toBe('active');
  const completed = advance(state, input, {
    kind: 'reply', caller: originalMain, ticket: report.id, revision: report.revision,
    payload: { kind: 'report', summary }, acceptedAt: 150,
  });
  state = completed.state;
  if (!completed.receipt) throw new Error('Accepting the final report must return its durable receipt');
  expect(completed.receipt.outcome).toBe('reported');
  expect(completed.receipt.acceptedVersion).toBe(state.version);
  expect(state.lifecycle).toBe('completed');
  expect(state.report?.state.kind).toBe('reported');
  expect(state.effects.every(effect => effect.state.kind === 'confirmed' || effect.state.kind === 'cancelled')).toBe(true);
  expect(tickets(state, input)).toEqual([]);
  expect(parseAgenda(JSON.parse(JSON.stringify(state))).ok).toBe(true);
  return { state, report, receipt: completed.receipt, closeEffectId: close.id };
}

function reportEvent(report: Ticket, caller: Caller, reportSummary = summary): Event {
  return {
    kind: 'reply', caller, ticket: report.id, revision: report.revision,
    payload: { kind: 'report', summary: reportSummary }, acceptedAt: 999,
  };
}

function expectRejectedUnchanged(state: Agenda, input: Inputs, event: Event, kind?: DomainError['kind']): void {
  const before = JSON.stringify(state);
  const result = transition(state, input, event);
  expect(result.kind).toBe('rejected');
  if (result.kind !== 'rejected') throw new Error(`Completed mutation was accepted: ${JSON.stringify(result)}`);
  if (kind) expect(result.error.kind).toBe(kind);
  expect(JSON.stringify(state)).toBe(before);
  expect(tickets(state, input)).toEqual([]);
}

describe('legally completed report receipt replay', () => {
  test('original Main exact replay uses no available facts and preserves the accepted receipt', () => {
    const { state, report, receipt } = completeLegally();
    const before = JSON.stringify(state);
    const input = unavailable(originalMain);
    for (let repeat = 0; repeat < 3; repeat++) {
      const result = transition(state, input, reportEvent(report, originalMain));
      expect(result).toEqual({ kind: 'same', reply: receipt });
      expect(JSON.stringify(state)).toBe(before);
      expect(tickets(state, input)).toEqual([]);
    }
  });

  test('new-run actual Main replays the original immutable report without resume or source', () => {
    const { state, report, receipt } = completeLegally();
    const before = JSON.stringify(state);
    const input = unavailable(successorMain);
    expect(state.run).toEqual({
      kind: 'attached', id: originalMain.runId,
      mainAgentId: originalMain.agentId, mainSessionId: originalMain.sessionId,
    });
    for (let repeat = 0; repeat < 3; repeat++) {
      const result = transition(state, input, reportEvent(report, successorMain));
      expect(result).toEqual({ kind: 'same', reply: receipt });
      expect(JSON.stringify(state)).toBe(before);
      expect(tickets(state, input)).toEqual([]);
    }
  });

  for (const [label, main] of [['original run', originalMain], ['successor run', successorMain]] as const) {
    test(`${label} actual Main changed report conflicts with the accepted receipt`, () => {
      const { state, report } = completeLegally();
      expectRejectedUnchanged(state, unavailable(main), reportEvent(report, main, `${summary} Changed after acceptance.`), 'replyConflict');
    });
  }

  const unauthorized: readonly { label: string; caller: Caller }[] = [
    { label: 'old Main from the original run', caller: originalMain },
    { label: 'different agent claiming Main', caller: { ...successorMain, agentId: 'impostor' } },
    { label: 'same agent with old session', caller: { ...successorMain, sessionId: originalMain.sessionId } },
    { label: 'same agent with old run', caller: { ...successorMain, runId: originalMain.runId } },
    { label: 'same identity claiming sub role', caller: { ...successorMain, kind: 'sub' } },
    { label: 'same identity at child depth', caller: { ...successorMain, depth: 1 } },
  ];
  for (const { label, caller } of unauthorized) {
    test(`rejects ${label} before disclosing or conflicting with the report receipt`, () => {
      const { state, report } = completeLegally();
      const input = unavailable(successorMain);
      expectRejectedUnchanged(state, input, reportEvent(report, caller), 'unauthorized');
      expectRejectedUnchanged(state, input, reportEvent(report, caller, 'Unauthorized changed summary'), 'unauthorized');
    });
  }

  test('completed observation remains read-only and exposes no further work even in a new run', () => {
    const { state } = completeLegally();
    const before = JSON.stringify(state);
    const input = unavailable(successorMain);
    expect(transition(state, input, { kind: 'observe' })).toEqual({ kind: 'same', reply: null });
    expect(JSON.stringify(state)).toBe(before);
    expect(tickets(state, input)).toEqual([]);
  });

  test('no other event can mutate completed state or reactivate gates and delivery intentions', () => {
    const { state, report, closeEffectId } = completeLegally();
    const input = unavailable(successorMain);
    const events: readonly Event[] = [
      { kind: 'resume', runId: successorMain.runId, operatorConfirmedOriginalSessionEnded: true },
      { kind: 'mainNoCode', caller: successorMain, member, bodyHash, reason: 'Attempted post-completion change', acceptedAt: 1000 },
      { kind: 'effectStarted', id: closeEffectId, attempt: 1, startedAt: 1000 },
      { kind: 'effectSatisfied', id: closeEffectId, result: { kind: 'issueState', issue: member, open: false, event: { id: 'late-close', at: 1000 } } },
      { kind: 'effectConfirmed', id: closeEffectId, attempt: 1, result: { kind: 'issueState', issue: member, open: false, event: null } },
      { kind: 'effectFailed', id: closeEffectId, attempt: 1, error: { kind: 'unavailable', message: 'Late failure' }, outcome: 'uncertain' },
      { kind: 'effectCancelled', id: closeEffectId, reason: 'superseded' },
      { kind: 'reply', caller: successorMain, ticket: report.id, revision: report.revision + 1, payload: { kind: 'report', summary }, acceptedAt: 1000 },
      { kind: 'reply', caller: successorMain, ticket: `work:${state.id}/work/nonexistent`, revision: 1, payload: { kind: 'report', summary }, acceptedAt: 1000 },
      { kind: 'reply', caller: successorMain, ticket: report.id, revision: report.revision, payload: { kind: 'claim', claim: { kind: 'noCode', evidence: 'No new claim may reopen completion' } }, acceptedAt: 1000 },
    ];
    for (const event of events) expectRejectedUnchanged(state, input, event);
  });
});
