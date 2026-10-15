import { describe, expect, test } from 'bun:test';
import { createAgenda, tickets, transition } from '../src/domain/index.ts';
import type {
  Agenda, Caller, CaseDecision, DecisionCase, DraftSpec, Effect, EffectResult, Event,
  Facts, GateJob, HostObservation, Inputs, IssueRef, IssueSnapshot, PrSnapshot,
  ProtocolReply, Repo, SourceScope, Ticket,
} from '../src/domain/index.ts';

// Independent source fixtures: no production transition helpers, author fixtures,
// synthesized Agenda objects, or synthesized GateJobs are used here.
const repo: Repo = { owner: 'ancestry-acceptance', name: 'product' };
const otherRepo: Repo = { owner: 'ancestry-acceptance', name: 'unrelated' };
const sha = (digit: string): string => digit.repeat(40);
const hash = (digit: string): string => digit.repeat(64);
const initial = sha('1');
const firstMerge = sha('2');
const secondMerge = sha('3');
const integrated = sha('4');
const original: IssueRef = { repo, number: 11 };
const correction: IssueRef = { repo, number: 12 };
const furtherCorrection: IssueRef = { repo, number: 13 };
const parent: IssueRef = { repo, number: 10 };
const originalPr: IssueRef = { repo, number: 21 };
const correctionPr: IssueRef = { repo, number: 22 };
const main: Caller = {
  kind: 'main', agentId: 'main', sessionId: 'main-session', parentId: null,
  runId: 'ancestry-run', depth: 0,
};
const sameIssue = (left: IssueRef, right: IssueRef): boolean =>
  left.repo.owner === right.repo.owner && left.repo.name === right.repo.name && left.number === right.number;

function issue(ref: IssueRef, children: IssueRef[] = []): IssueSnapshot {
  return { ref, body: `Acceptance issue ${ref.number}`, bodyHash: hash('a'), updatedAt: 100,
    state: 'open', lastClose: null, lastReopen: null, children };
}

function pr(ref: IssueRef, member: IssueRef, base: string): PrSnapshot {
  return { ref, headRepo: repo, headBranch: `issue-${member.number}`, head: sha('a'),
    target: { repo, base }, title: `Deliver ${member.number}`, body: `Closes #${member.number}`,
    bodyHash: hash('b'), updatedAt: 100, state: { kind: 'open' }, closes: [member],
    mergeable: 'yes', checks: { kind: 'passing', required: [] } };
}

class PublicPath {
  state: Agenda;
  facts: Facts;
  host: HostObservation;
  readonly trace: string[] = [];
  readonly answeredJobIds = new Set<string>();
  private time = 110;

  constructor() {
    const pull = pr(originalPr, original, 'left');
    this.facts = {
      viewer: 'acceptance-actor', issues: [issue(parent, [original]), issue(original)],
      prs: [pull], links: [{ issue: original, pr: originalPr }],
      repos: [{ repo, defaultBranch: 'main', defaultHead: initial,
        bases: ['main', 'left', 'right'].map(name => ({ name, state: { kind: 'present',
          head: initial, isDefault: name === 'main',
          rules: { required: [], strict: false, upToDate: false, constraints: [] } } })) }],
      branches: [{ repo, name: pull.headBranch, state: { kind: 'present', head: pull.head } }],
      maintenance: [{ pr: originalPr, result: { kind: 'maintainable', basis: {
        headRepo: repo, headBranch: pull.headBranch, viewerPermission: 'ADMIN',
        author: 'acceptance-actor', maintainerCanModify: true,
        authorization: { kind: 'actorIsAuthor', actor: 'acceptance-actor' },
      } } }],
      commits: [], checkAttempts: [], createdIssues: [],
    };
    this.host = { runId: main.runId, main, seats: [], turnEnds: [], preflight: {
      ok: true, value: { asyncEnabled: true, isolationEnabled: true, asyncManager: true,
        gitCwd: '/tmp/verification-ancestry-acceptance', agents: [{ name: 'task:free', blocking: false }] },
    } };
    const made = createAgenda({ op: 'convene', mode: 'execute', parent,
      entries: [{ issue: original, target: { repo, base: 'left' }, designOnly: false, adoptPr: originalPr }],
    }, this.facts, 100, 'a3998ccc-36da-4f3b-92c9-2b82b2547671');
    if (!made.ok) throw new Error(`convene rejected: ${JSON.stringify(made.error)}`);
    this.state = made.value;
    this.event({ kind: 'resume', runId: main.runId, operatorConfirmedOriginalSessionEnded: true });
  }

  input(): Inputs {
    const scope: SourceScope = {
      issues: this.facts.issues.map(item => item.ref), prs: this.facts.prs.map(item => item.ref),
      repos: this.facts.repos.map(item => ({ repo: item.repo, bases: item.bases.map(base => base.name) })),
      branches: this.facts.branches.map(item => ({ repo: item.repo, name: item.name })),
      commits: this.facts.commits.map(({ repo, ancestor, descendant }) => ({ repo, ancestor, descendant })),
      checkRuns: [], creations: [],
    };
    return { facts: { kind: 'available', generation: 1, scope, observedAt: this.time, facts: this.facts },
      host: this.host, policy: { text: 'Independent ancestry acceptance policy', ownerAgent: 'task:free', gateAgent: 'task:free' } };
  }

  event(event: Event): void {
    const before = this.state.version;
    const result = transition(this.state, this.input(), event);
    this.trace.push(`${event.kind}${event.kind === 'reply' ? ` ${event.ticket} ${event.payload.kind}` : ''}: ${result.kind}`);
    if (result.kind === 'rejected') throw new Error(`${JSON.stringify(result.error)}\n${this.trace.join('\n')}`);
    if (result.kind === 'next') {
      expect(result.state.version, this.trace.join('\n')).toBe(before + 1);
      this.state = result.state;
    }
  }

  observe(): void {
    this.trace.push(`source ancestry: ${JSON.stringify(this.facts.commits)}`);
    // A convergence guard fails rather than accepting a truncated execution.
    for (let iteration = 0; iteration < 40; iteration++) {
      const version = this.state.version;
      this.event({ kind: 'observe' });
      if (this.state.version === version) return;
    }
    throw new Error(`observe did not converge\n${this.trace.join('\n')}`);
  }

  ticket(id: string): Ticket {
    const result = tickets(this.state, this.input()).find(item => item.id === id);
    if (!result) throw new Error(`Missing public ticket ${id}\n${this.trace.join('\n')}`);
    return result;
  }

  reply(ticket: Ticket, payload: ProtocolReply, caller: Caller = main): void {
    this.event({ kind: 'reply', caller, ticket: ticket.id, revision: ticket.revision, payload, acceptedAt: ++this.time });
  }

  verdict(job: GateJob, ok: boolean): void {
    const request = this.state.requests.find(item => item.id === job.requestId);
    if (!request) throw new Error(`Missing gate request ${job.requestId}`);
    const agentId = `seat-${request.id}`;
    const sessionId = `session-${request.id}`;
    this.host = { ...this.host, seats: [...this.host.seats, {
      agentId, sessionId, requestedName: request.name, parentId: main.agentId, createdAt: ++this.time,
      status: 'running', plan: 'disabled', streaming: false,
    }] };
    this.reply(this.ticket(`spawn:${request.id}`), { kind: 'spawned', agentId });
    this.reply(this.ticket(`gate:${job.id}`), { kind: 'verdict', ok,
      note: ok ? 'Independently exercised the exact source commit.' : 'Source integration requires a correction.' },
    { kind: 'sub', agentId, sessionId, parentId: main.agentId, runId: main.runId, depth: 1 });
    this.answeredJobIds.add(job.id);
    this.observe();
  }

  decide(item: DecisionCase, decision: CaseDecision): void {
    this.reply(this.ticket(`case:${item.id}`), { kind: 'decision', decision });
    this.observe();
  }

  rejectUnchangedReverify(item: DecisionCase): void {
    const ticket = this.ticket(`case:${item.id}`);
    const before = JSON.stringify(this.state);
    const result = transition(this.state, this.input(), {
      kind: 'reply', caller: main, ticket: ticket.id, revision: ticket.revision,
      payload: { kind: 'decision', decision: { kind: 'reverify', basis: 'Recheck unchanged explicit negative source evidence.' } },
      acceptedAt: ++this.time,
    });
    this.trace.push(`unchanged reverify ${ticket.id}: ${result.kind}`);
    expect(result.kind, this.trace.join('\n')).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('Unchanged ancestry reverify was not rejected');
    expect(result.error.kind).toBe('invalidDecision');
    expect(JSON.stringify(this.state)).toBe(before);
    this.observe();
    expect(this.state.cases.find(value => value.id === item.id)?.contentVersion).toBe(item.contentVersion);
    expect(this.state.cases.find(value => value.id === item.id)?.state.kind).toBe('open');
  }

  sourceMerge(member: IssueRef, pullRef: IssueRef, base: string, merge: string, at: number): void {
    this.trace.push(`source merged ${member.repo.owner}/${member.repo.name}#${member.number} into ${base}: ${merge} at ${at}`);
    const oldPull = this.facts.prs.find(item => sameIssue(item.ref, pullRef));
    const pull = oldPull ?? pr(pullRef, member, base);
    this.facts = { ...this.facts,
      issues: this.facts.issues.map(item => sameIssue(item.ref, member)
        ? { ...item, state: 'closed', updatedAt: at, lastClose: { id: `merged-${member.number}`, at } } : item),
      prs: [...this.facts.prs.filter(item => !sameIssue(item.ref, pullRef)),
        { ...pull, state: { kind: 'merged', sha: merge, at }, updatedAt: at }],
      links: [...this.facts.links.filter(item => !sameIssue(item.issue, member)), { issue: member, pr: pullRef }],
      repos: this.facts.repos.map(item => ({ ...item,
        defaultHead: base === item.defaultBranch ? merge : item.defaultHead,
        bases: item.bases.map(value => value.name === base && value.state.kind === 'present'
          ? { ...value, state: { ...value.state, head: merge } } : value) })),
    };
    this.observe();
  }

  effect(effect: Effect, result: EffectResult, mutateSource: () => void): void {
    this.event({ kind: 'effectStarted', id: effect.id, attempt: effect.attempt + 1, startedAt: ++this.time });
    mutateSource();
    this.event({ kind: 'effectConfirmed', id: effect.id, attempt: effect.attempt + 1, result });
    this.observe();
  }

  correctWithDraft(item: DecisionCase, member: IssueRef, base: string): void {
    const unit = this.state.units[0];
    if (!unit) throw new Error('Original unit absent');
    const spec: DraftSpec = { repo, title: `Integrate correction ${member.number}`,
      body: 'Integrate the exact previously delivered changes onto a common source commit.',
      target: { repo, base }, designOnly: false };
    this.decide(item, { kind: 'correct', insertion: { kind: 'draft', draft: spec,
      position: { kind: 'correctionOf', unitId: unit.id } } });
    const draft = this.state.drafts.find(value => value.caseId === item.id);
    if (!draft) throw new Error(`Correction draft absent\n${this.trace.join('\n')}`);
    expect(this.state.cases.find(value => value.id === item.id)?.state.kind).toBe('applying');
    const create = this.state.effects.find(value => value.action.kind === 'createIssue' && value.action.draftId === draft.id);
    if (!create) throw new Error('Correction has no real createIssue intent');
    this.effect(create, { kind: 'created', issue: member }, () => {
      this.facts = { ...this.facts, issues: [...this.facts.issues, {
        ...issue(member), body: spec.body, bodyHash: hash('c'),
      }], createdIssues: [...this.facts.createdIssues, {
        issue: member, title: spec.title, body: spec.body, actor: 'acceptance-actor', createdAt: this.time,
      }] };
    });
    expect(this.state.units.flatMap(value => value.members).some(value => sameIssue(value.ref, member))).toBe(false);
    expect(this.state.cases.find(value => value.id === item.id)?.state.kind).toBe('applying');
    const attach = this.state.effects.find(value => value.action.kind === 'attachChild' && sameIssue(value.action.child, member));
    if (!attach || attach.action.kind !== 'attachChild') throw new Error('Correction has no real attachChild intent');
    expect(attach.action.owner).toEqual({ kind: 'draft', draftId: draft.id });
    expect(attach.action.parent).toEqual(parent);
    this.effect(attach, { kind: 'attached', parent, child: member }, () => {
      this.facts = { ...this.facts, issues: this.facts.issues.map(value => sameIssue(value.ref, parent)
        ? { ...value, children: [...value.children, member] } : value) };
    });
    expect(this.state.drafts.find(value => value.id === draft.id)?.state).toEqual({ kind: 'placed', member });
    expect(this.state.units[0]?.members.some(value => sameIssue(value.ref, member))).toBe(true);
    expect(this.state.cases.find(value => value.id === item.id)?.state.kind).toBe('resolved');
  }
}

function requirePostMerge(path: PublicPath): GateJob {
  const job = path.state.units[0]?.postMerge;
  if (!job || job.status.kind !== 'requested') throw new Error(`No actual requested postMerge job\n${path.trace.join('\n')}`);
  return job;
}

function requireAncestry(path: PublicPath, kind: 'postMerge' | 'closure'): DecisionCase {
  const item = path.state.cases.find(value => value.subject.kind === kind && value.subject.cause.kind === 'ancestry'
    && value.state.kind === 'open');
  if (!item) throw new Error(`No open ${kind} ancestry case\n${JSON.stringify(path.state.cases)}\n${path.trace.join('\n')}`);
  return item;
}

function expectBlocked(path: PublicPath, kind: 'postMerge' | 'closure'): void {
  const job = kind === 'closure' ? path.state.closure : path.state.units[0]?.postMerge;
  expect(job?.status.kind === 'requested', path.trace.join('\n')).toBe(false);
  expect(job?.status.kind === 'answered' && job.status.ok, path.trace.join('\n')).toBe(false);
  if (job?.status.kind === 'answered') expect(path.answeredJobIds.has(job.id), 'No fabricated answered GateJob').toBe(true);
  expect(path.state.lifecycle).toBe('active');
  expect(path.state.report).toBeNull();
}

function incomparablePath(result: 'notContained' | 'missing' | 'absent' = 'notContained'): PublicPath {
  const path = new PublicPath();
  path.sourceMerge(original, originalPr, 'left', firstMerge, 200);
  const realJob = requirePostMerge(path);
  path.verdict(realJob, false);
  const finding = path.state.cases.find(item => item.subject.kind === 'postMerge' && item.subject.cause.kind === 'verdict'
    && item.subject.cause.jobId === realJob.id && item.state.kind === 'open');
  if (!finding) throw new Error(`Real failed postMerge did not open its case\n${path.trace.join('\n')}`);
  path.correctWithDraft(finding, correction, 'right');
  path.facts = { ...path.facts, commits: result === 'absent' ? [] : [
    { repo, ancestor: firstMerge, descendant: secondMerge, result },
    { repo, ancestor: secondMerge, descendant: firstMerge, result },
  ] };
  path.sourceMerge(correction, correctionPr, 'right', secondMerge, 300);
  expect(path.state.units).toHaveLength(1);
  expect(path.state.units[0]?.members).toHaveLength(2);
  return path;
}

function closurePath(result: 'notContained' | 'missing' | 'absent' = 'notContained'): PublicPath {
  const path = new PublicPath();
  path.facts = { ...path.facts, commits: result === 'absent' ? [] : [
    { repo, ancestor: firstMerge, descendant: initial, result },
  ] };
  path.sourceMerge(original, originalPr, 'left', firstMerge, 200);
  path.verdict(requirePostMerge(path), true);
  return path;
}

function positiveDefault(path: PublicPath, merges: string[]): void {
  path.facts = { ...path.facts,
    repos: path.facts.repos.map(item => ({ ...item, defaultHead: integrated,
      bases: item.bases.map(base => base.name === 'main' && base.state.kind === 'present'
        ? { ...base, state: { ...base.state, head: integrated } } : base) })),
    commits: [...path.facts.commits.filter(item => item.descendant !== integrated),
      ...merges.map(ancestor => ({ repo, ancestor, descendant: integrated, result: 'contains' as const }))],
  };
  path.observe();
}

describe('public verification ancestry obligations', () => {
  test('incomparable same-repo correction opens an exact source case, not a fabricated failed GateJob', () => {
    const path = incomparablePath();
    expectBlocked(path, 'postMerge');
    const item = requireAncestry(path, 'postMerge');
    const unit=path.state.units[0];if(!unit)throw new Error('Original unit absent');
    expect(item.context).toEqual({kind:'unit',unitId:unit.id});
    expect(item.subject).toEqual({ kind: 'postMerge', cause: { kind: 'ancestry', comparisons: [
      { ancestor: { repo, sha: firstMerge }, descendant: { repo, sha: secondMerge } },
    ] } });
    if (item.subject.kind !== 'postMerge') throw new Error('Wrong ancestry subject');
    expect('jobId' in item.subject.cause).toBe(false);
    expect(path.ticket(`case:${item.id}`).allowedReplies).toContain('decision');
    // The source failure itself is actionable through the normal real draft lifecycle.
    path.correctWithDraft(item, furtherCorrection, 'main');
    expect(path.state.units[0]?.members).toHaveLength(3);
    expect(path.state.units[0]?.members.find(member => sameIssue(member.ref, furtherCorrection))?.work).not.toBeNull();
  });

  test('postMerge reverify cannot erase the source obligation; real common containment permits a fresh gate', () => {
    const path = incomparablePath();
    const item = requireAncestry(path, 'postMerge');
    path.rejectUnchangedReverify(item);
    expectBlocked(path, 'postMerge');
    requireAncestry(path, 'postMerge');
    path.correctWithDraft(item, furtherCorrection, 'main');
    expectBlocked(path, 'postMerge');
    // A pending, real correction is the owner obligation; timers must not reopen
    // the old source gap while that correction is still being delivered.
    path.observe();
    path.observe();
    expect(path.state.cases.some(value => value.subject.kind === 'postMerge'
      && value.subject.cause.kind === 'ancestry' && value.state.kind === 'open')).toBe(false);
    path.facts = { ...path.facts, commits: [...path.facts.commits,
      { repo, ancestor: firstMerge, descendant: integrated, result: 'contains' },
      { repo, ancestor: secondMerge, descendant: integrated, result: 'contains' },
    ] };
    path.sourceMerge(furtherCorrection, { repo, number: 23 }, 'main', integrated, 400);
    const fresh = requirePostMerge(path);
    expect(fresh.stamp.kind).toBe('postMerge');
    if (fresh.stamp.kind !== 'postMerge') throw new Error('Wrong public stamp kind');
    expect(fresh.stamp.repos).toEqual([{ repo, commit: integrated, merges: [firstMerge, secondMerge, integrated] }]);
    expect(fresh.status).toEqual({ kind: 'requested' });
    expect(path.answeredJobIds.has(fresh.id), 'Recovery must issue a fresh job, not revive an answered one').toBe(false);
  });

  test('same SHA containment from a different repo cannot satisfy common postMerge ancestry', () => {
    const path = incomparablePath();
    path.facts = { ...path.facts, commits: [...path.facts.commits,
      { repo: otherRepo, ancestor: firstMerge, descendant: secondMerge, result: 'contains' }] };
    path.observe();
    expectBlocked(path, 'postMerge');
    const item = requireAncestry(path, 'postMerge');
    expect(item.subject.kind === 'postMerge' && item.subject.cause.kind === 'ancestry'
      && item.subject.cause.comparisons.every(pair => pair.ancestor.repo.name === repo.name && pair.descendant.repo.name === repo.name)).toBe(true);
  });

  test.each(['missing', 'absent'] as const)('postMerge %s comparison is unavailable evidence, not explicit negative source proof', result => {
    const path = incomparablePath(result);
    expectBlocked(path, 'postMerge');
    expect(path.state.cases.some(item => item.subject.kind === 'postMerge' && item.subject.cause.kind === 'ancestry'
      && item.state.kind === 'open')).toBe(false);
  });

  test('closure preserves exact default ancestry failure after ordinary postMerge passed', () => {
    const path = closurePath();
    expect(path.state.units[0]?.postMerge?.status).toMatchObject({ kind: 'answered', ok: true });
    expectBlocked(path, 'closure');
    const item = requireAncestry(path, 'closure');
    expect(item.context).toEqual({ kind: 'agenda' });
    expect(item.subject).toEqual({ kind: 'closure', cause: { kind: 'ancestry', comparisons: [
      { ancestor: { repo, sha: firstMerge }, descendant: { repo, sha: initial } },
    ] } });
    path.rejectUnchangedReverify(item);
    expectBlocked(path, 'closure');
    requireAncestry(path, 'closure');
    positiveDefault(path, [firstMerge]);
    const gate = path.state.closure;
    expect(gate?.status).toEqual({ kind: 'requested' });
    if (!gate || gate.stamp.kind !== 'closure') throw new Error(`No fresh closure gate\n${path.trace.join('\n')}`);
    expect(gate.stamp.repos).toEqual([{ repo, commit: integrated, merges: [firstMerge] }]);
    expect(gate.receipt).toBeNull();
    expect(path.state.cases.find(value => value.id === item.id)?.state).toEqual({
      kind: 'cancelled', reason: 'sourceEventSuperseded',
    });
  });

  test('wrong-repo same-SHA proof does not satisfy closure default ancestry', () => {
    const path = closurePath();
    path.facts = { ...path.facts, commits: [...path.facts.commits,
      { repo: otherRepo, ancestor: firstMerge, descendant: initial, result: 'contains' }] };
    path.observe();
    expectBlocked(path, 'closure');
    requireAncestry(path, 'closure');
  });

  test.each(['missing', 'absent'] as const)('closure %s comparison never becomes a fabricated negative case or pass', result => {
    const path = closurePath(result);
    expectBlocked(path, 'closure');
    expect(path.state.cases.some(item => item.subject.kind === 'closure' && item.subject.cause.kind === 'ancestry'
      && item.state.kind === 'open')).toBe(false);
  });
});
