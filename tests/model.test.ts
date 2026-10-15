import { describe, test } from 'bun:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createAgenda, transition, tickets } from '../src/domain/index.ts';
import type { Action, Agenda, Caller, CaseDecision, DecisionCase, Effect, EffectResult, Event, Facts, HostObservation, Inputs, IssueRef, IssueSnapshot, Member, PrSnapshot, ProtocolReply, Repo, SourceScope, Ticket, Transition } from '../src/domain/model.ts';

// Independent environment: no author fixtures, internal helpers, or fabricated Agenda.
// Reproduce a matrix trace: bun test tests/model.test.ts -t '^pairwise-0:'.
// Each thrown counterexample includes the public events and source/registry deltas.
const REPO: Repo = { owner: 'ModelEnvironment', name: 'roundtable' };
const issue = (number: number): IssueRef => ({ repo: REPO, number });
const refKey = (ref: IssueRef): string => `${ref.repo.owner}/${ref.repo.name}#${ref.number}`;
const sameRef = (left: IssueRef, right: IssueRef): boolean => refKey(left) === refKey(right);
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const sha = (n: number): string => n.toString(16).padStart(40, '0');
const MAIN: Caller = { agentId: 'main', sessionId: 'main-session', parentId: null, runId: 'model-run', kind: 'main', depth: 0 };
const ALL_ACTIONS = ['publishPr', 'createIssue', 'attachChild', 'replaceBody', 'setIssueState', 'rerunChecks', 'merge', 'wake'] as const satisfies readonly Action['kind'][];
const ACTION_CAP = 160;
const OBSERVE_CAP = 64;

type TraceStep = { label: string; event: Event | null; source: { facts: Facts; host: HostObservation } | null; result: string };
type Seed = { state: Agenda; facts: Facts; host: HostObservation; trace: readonly TraceStep[]; serial: number };
type Outcome = 'success' | 'failed' | 'unknown' | 'confirmLost';
type Scenario = { owner: 'submit' | 'claim' | 'silent'; push: 'stable' | 'changed'; gate: 'pass' | 'notOk'; effect: Outcome; seat: 'running' | 'parked' | 'aborted'; body: 'stable' | 'edited' };
type Recipe = 'ordinary' | 'correction' | 'amendment' | 'rerun' | 'orphan';

function snapshot(ref: IssueRef, body = 'Deliver the stated behavior through the real entry point.'): IssueSnapshot {
  return { ref, body, bodyHash: hash(body), updatedAt: 1, state: 'open', lastClose: null, lastReopen: null, children: [] };
}
function initialFacts(adopted = false): Facts {
  const parent = snapshot(issue(100), 'All child issues must satisfy their complete delivery contract.');
  parent.children = [issue(1), issue(2)];
  const facts: Facts = {
    viewer: 'ModelEnvironment',
    issues: [snapshot(issue(1)), snapshot(issue(2)), parent], prs: [], links: [],
    repos: [{ repo: REPO, defaultBranch: 'main', defaultHead: sha(1), bases: [
      { name: 'main', state: { kind: 'present', head: sha(1), isDefault: true, rules: { required: [], strict: false, upToDate: true, constraints: [] } } },
      { name: 'integration', state: { kind: 'present', head: sha(1), isDefault: false, rules: { required: [], strict: false, upToDate: true, constraints: [] } } },
    ] }], branches: [], maintenance: [], commits: [], checkAttempts: [], createdIssues: [],
  };
  if (adopted) {
    facts.prs.push(makePr(issue(201), 'adopted', sha(2), 'integration', issue(1), 'Adopted PR', 'Closes #1'));
    facts.links.push({ issue: issue(1), pr: issue(201) });
    facts.branches.push({ repo: REPO, name: 'adopted', state: { kind: 'present', head: sha(2) } });
    authorize(facts, facts.prs[0]!);
  }
  return facts;
}
function makePr(ref: IssueRef, branch: string, head: string, base: string, member: IssueRef, title: string, body: string): PrSnapshot {
  return { ref, headRepo: REPO, headBranch: branch, head, target: { repo: REPO, base }, title, body, bodyHash: hash(body), updatedAt: 1, state: { kind: 'open' }, closes: [member], mergeable: 'yes', checks: { kind: 'passing', required: [] } };
}
function authorize(facts: Facts, pr: PrSnapshot): void {
  facts.maintenance = facts.maintenance.filter(row => !sameRef(row.pr, pr.ref));
  facts.maintenance.push({ pr: pr.ref, result: { kind: 'maintainable', basis: { headRepo: pr.headRepo, headBranch: pr.headBranch, viewerPermission: 'ADMIN', author: 'ModelEnvironment', maintainerCanModify: true, authorization: { kind: 'actorIsAuthor', actor: 'ModelEnvironment' } } } });
}
function host(): HostObservation {
  return { runId: MAIN.runId, main: MAIN, seats: [], turnEnds: [], preflight: { ok: true, value: { asyncEnabled: true, isolationEnabled: true, asyncManager: true, gitCwd: '/tmp/roundtable-model-main', agents: [{ name: 'task:free', blocking: false }] } } };
}
function scope(facts: Facts): SourceScope {
  return { issues: facts.issues.map(row => row.ref), prs: facts.prs.map(row => row.ref), repos: facts.repos.map(snapshot => ({ repo: snapshot.repo, bases: snapshot.bases.map(base => base.name) })), branches: facts.branches.map(row => ({ repo: row.repo, name: row.name })), commits: facts.commits.map(row => ({ repo: row.repo, ancestor: row.ancestor, descendant: row.descendant })), checkRuns: facts.checkAttempts.map(row => ({ repo: row.repo, runId: row.workflowRunId })), creations: [] };
}
function publicSummary(state: Agenda): string {
  return JSON.stringify({ version: state.version, lifecycle: state.lifecycle, members: state.units.flatMap(unit => unit.members.map(member => ({ ref: refKey(member.ref), work: member.work?.id, revision: member.work?.contentVersion, terminal: member.terminal.kind }))), cases: state.cases.map(item => ({ id: item.id, subject: item.subject.kind, state: item.state.kind })), effects: state.effects.map(effect => ({ id: effect.id, action: effect.action.kind, state: effect.state.kind })) });
}

// Source proofs are independently derived from public Facts and Action fields.
// Local intent, candidate issue similarity and a live holder are never receipts.
function sourceCompletion(action: Action, facts: Facts): EffectResult | null {
  const sameRepo = (left: Repo, right: Repo): boolean => left.owner === right.owner && left.name === right.name;
  switch (action.kind) {
    case 'publishPr': {
      const matches = facts.prs.filter(pr =>
        pr.state.kind === 'open' && sameRepo(pr.ref.repo, action.target.repo) &&
        sameRepo(pr.headRepo, action.headRepo) && pr.headBranch === action.submission.payload.branch &&
        sameRepo(pr.target.repo, action.target.repo) && pr.target.base === action.target.base &&
        pr.head === action.submission.payload.head && pr.title === action.submission.payload.title &&
        pr.body === action.body);
      const registered = action.pr;
      const found = registered ? matches.find(pr => sameRef(pr.ref, registered)) : matches.length === 1 ? matches[0] : undefined;
      return found ? { kind: 'published', pr: found.ref } : null;
    }
    case 'attachChild': {
      const parent = facts.issues.find(row => sameRef(row.ref, action.parent));
      return parent?.children.some(child => sameRef(child, action.child)) ? { kind: 'attached', parent: action.parent, child: action.child } : null;
    }
    case 'replaceBody': {
      const target = facts.issues.find(row => sameRef(row.ref, action.edit.issue));
      const targetHash = hash(action.edit.body);
      return target?.bodyHash === targetHash ? { kind: 'bodyReplaced', issue: target.ref, hash: targetHash } : null;
    }
    case 'setIssueState': {
      const target = facts.issues.find(row => sameRef(row.ref, action.issue));
      if (!target || target.state !== (action.open ? 'open' : 'closed')) return null;
      const completion = action.open ? target.lastReopen : target.lastClose;
      const opposite = action.open ? target.lastClose : target.lastReopen;
      if (action.afterEvent && (!completion || completion.at <= action.afterEvent.at)) return null;
      if (opposite && (!completion || opposite.at > completion.at)) return null;
      return { kind: 'issueState', issue: target.ref, open: action.open, event: completion };
    }
    case 'rerunChecks': {
      const run = facts.checkAttempts.find(row => sameRepo(row.repo, action.repo) && row.workflowRunId === action.workflowRunId && row.head === action.head && row.attempt > action.previousAttempt);
      return run ? { kind: 'rerun', repo: run.repo, workflowRunId: run.workflowRunId, attempt: run.attempt } : null;
    }
    case 'merge': {
      const pr = facts.prs.find(row => sameRef(row.ref, action.pr));
      return pr?.state.kind === 'merged' && sameRepo(pr.target.repo, action.target.repo) && pr.target.base === action.target.base && pr.head === action.head
        ? { kind: 'merged', pr: pr.ref, merge: { repo: pr.target.repo, sha: pr.state.sha }, at: pr.state.at } : null;
    }
    case 'createIssue':
    case 'wake': return null;
  }
}

class Driver {
  state: Agenda;
  facts: Facts;
  host: HostObservation;
  trace: TraceStep[];
  serial: number;
  sourceUnavailable = false;
  readonly seeds = new Map<Action['kind'], Seed>();
  constructor(readonly name: string, seed?: Seed, adopted = false) {
    if (seed) {
      this.state = structuredClone(seed.state); this.facts = structuredClone(seed.facts); this.host = structuredClone(seed.host); this.trace = [...seed.trace]; this.serial = seed.serial;
      return;
    }
    this.facts = initialFacts(adopted); this.host = host(); this.trace = []; this.serial = 10;
    const result = createAgenda({ op: 'convene', mode: 'execute', parent: issue(100), entries: [1, 2].map(number => ({ issue: issue(number), target: { repo: REPO, base: 'integration' }, designOnly: false, adoptPr: adopted && number === 1 ? issue(201) : null })) }, structuredClone(this.facts), 1, '17af6e4f-a366-4f64-b169-0e76ac321901');
    if (!result.ok) throw new Error(`${name}: createAgenda rejected: ${JSON.stringify(result.error)}`);
    this.state = result.value;
    this.record('public createAgenda with ordered entries and adopted flag', null, 'created');
    this.settle();
  }
  input(): Inputs {
    return { facts: this.sourceUnavailable ? { kind: 'unavailable', error: { kind: 'unavailable', message: 'Independent environment: source preflight could not be read' } } : { kind: 'available', generation: this.serial, observedAt: this.serial * 120_000, scope: scope(this.facts), facts: structuredClone(this.facts) }, host: structuredClone(this.host), policy: { text: 'Model policy: preserve the full issue contract, use independent real-entry validation, and report evidence.', ownerAgent: 'task:free', gateAgent: 'task:free' } };
  }
  projection(): readonly Ticket[] { return tickets(this.state, this.input()); }
  seed(): Seed { return { state: structuredClone(this.state), facts: structuredClone(this.facts), host: structuredClone(this.host), trace: [...this.trace], serial: this.serial }; }
  fail(message: string): never {
    throw new Error(`${this.name}: ${message}\nState: ${publicSummary(this.state)}\nReplay trace (breadth-first failures retain their shortest explored prefix):\n${JSON.stringify(this.trace, null, 2)}`);
  }
  record(label: string, event: Event | null, result: string): void {
    this.trace.push({ label, event: structuredClone(event), source: event === null ? { facts: structuredClone(this.facts), host: structuredClone(this.host) } : null, result });
  }
  environment(label: string, change: (facts: Facts, host: HostObservation) => void): void {
    change(this.facts, this.host); this.serial += 1; this.record(label, null, 'environment');
  }
  event(event: Event, allowRejected = false): Transition {
    const before = JSON.stringify(this.state);
    const version = this.state.version;
    const frozen = structuredClone(this.state);
    const result = transition(this.state, this.input(), event);
    assert.deepEqual(this.state, frozen, 'transition mutated its input Agenda');
    this.record(event.kind, event, result.kind === 'rejected' ? `rejected:${result.error.kind}` : result.kind);
    if (result.kind === 'rejected') {
      if (!allowRejected) this.fail(`Unexpected ${result.error.kind}: ${result.error.message}`);
      assert.equal(JSON.stringify(this.state), before);
      return result;
    }
    if (result.kind === 'next') {
      assert.equal(result.state.version, version + 1, 'Every next increments version exactly once');
      this.state = result.state;
    } else assert.equal(JSON.stringify(this.state), before, 'same must not mutate state');
    this.safety();
    for (const effect of this.state.effects) if (effect.state.kind === 'ready' && !this.seeds.has(effect.action.kind)) this.seeds.set(effect.action.kind, this.seed());
    return result;
  }
  settle(): void {
    const seen = new Set<string>();
    for (let i = 0; i < OBSERVE_CAP; i += 1) {
      const signature = JSON.stringify(this.state);
      if (seen.has(signature)) this.fail('observe claimed next while repeating a state');
      seen.add(signature);
      if (this.event({ kind: 'observe' }).kind === 'same') return;
    }
    this.fail(`observe reached cap ${OBSERVE_CAP}; pending trace is not a passing truncation`);
  }
  member(ref = issue(1)): Member {
    const member = this.state.units.flatMap(unit => unit.members).find(row => sameRef(row.ref, ref));
    if (!member) this.fail(`Missing member ${refKey(ref)}`);
    return member;
  }
  sourceIssue(ref: IssueRef): IssueSnapshot {
    const found = this.facts.issues.find(row => sameRef(row.ref, ref));
    if (!found) this.fail(`Missing source issue ${refKey(ref)}`);
    return found;
  }
  sourcePr(ref: IssueRef): PrSnapshot {
    const found = this.facts.prs.find(row => sameRef(row.ref, ref));
    if (!found) this.fail(`Missing source PR ${refKey(ref)}`);
    return found;
  }
  caller(ticket: Ticket): Caller {
    if (ticket.holder.kind === 'main') return this.host.main;
    const requestId = ticket.holder.requestId;
    const request = this.state.requests.find(row => row.id === requestId);
    if (!request || request.binding.kind !== 'bound') this.fail(`Reply has no bound holder: ${ticket.id}`);
    return { agentId: request.binding.agentId, sessionId: request.binding.sessionId, parentId: request.binding.parentId, runId: this.host.runId, kind: 'sub', depth: 1 };
  }
  reply(ticket: Ticket, payload: ProtocolReply, allowRejected = false): Transition {
    return this.event({ kind: 'reply', caller: this.caller(ticket), ticket: ticket.id, revision: ticket.revision, payload, acceptedAt: ++this.serial }, allowRejected);
  }
  bindOne(): boolean {
    const ticket = this.projection().find(row => row.id.startsWith('spawn:'));
    if (!ticket) return false;
    const request = this.state.requests.find(row => `spawn:${row.id}` === ticket.id);
    if (!request) this.fail('Spawn ticket has no SeatRequest');
    const agentId = `seat-${++this.serial}`;
    this.environment(`registry registers ${request.role} for exact requestedName`, (_facts, observation) => {
      observation.seats = [...observation.seats, { agentId, requestedName: request.name, parentId: observation.main.agentId, sessionId: `${agentId}-session`, createdAt: this.serial, status: 'running', plan: 'disabled', streaming: false }];
    });
    this.reply(ticket, { kind: 'spawned', agentId }); this.settle(); return true;
  }
  submit(ticket: Ticket): void {
    if (ticket.context.kind !== 'member') this.fail('Submit without member context');
    const member = this.member(ticket.context.member);
    const existing = member.binding.kind === 'registered' ? this.sourcePr(member.binding.pr) : null;
    const branch = existing?.headBranch ?? `member-${member.ref.number}`;
    const head = existing?.head ?? sha(1_000 + member.ref.number);
    this.environment('owner pushes explicit completion commit', facts => {
      facts.branches = facts.branches.filter(row => row.name !== branch);
      facts.branches.push({ repo: REPO, name: branch, state: { kind: 'present', head } });
      for (const required of member.work?.required ?? []) facts.commits.push({ repo: required.repo, ancestor: required.sha, descendant: head, result: 'contains' });
    });
    this.reply(ticket, { kind: 'submit', branch, head, title: `Deliver member ${member.ref.number}`, body: `## Scope\nFull contract delivery.\n\n## Evidence\nReal entry exercised.\n\nCloses #${member.ref.number}`, template: 'fourLayer', retryNote: null });
    const after = this.member(member.ref);
    assert.equal(after.work, null, 'accepted submit closes the exact OwnerWork');
    assert.equal(after.baseline.kind, 'submitted', 'accepted submit records a baseline, not a latest-source guess');
    assert.ok(this.state.effects.some(effect => effect.action.kind === 'publishPr' && sameRef(effect.action.member, member.ref) && effect.state.kind === 'ready'), 'publish intent must exist in the accepted reply transition');
    assert.ok(!this.projection().some(ticket => ticket.id.startsWith('gate:') && ticket.context.kind === 'member' && sameRef(ticket.context.member, member.ref)), 'No gate ticket is exposed for this member while publication remains unconfirmed');
  }
  result(effect: Effect): EffectResult {
    const action = effect.action;
    switch (action.kind) {
      case 'publishPr': return { kind: 'published', pr: action.pr ?? issue(500 + ++this.serial) };
      case 'createIssue': return { kind: 'created', issue: issue(1_000 + ++this.serial) };
      case 'attachChild': return { kind: 'attached', parent: action.parent, child: action.child };
      case 'replaceBody': return { kind: 'bodyReplaced', issue: action.edit.issue, hash: hash(action.edit.body) };
      case 'setIssueState': return { kind: 'issueState', issue: action.issue, open: action.open, event: { id: `lifecycle-${++this.serial}`, at: this.serial } };
      case 'rerunChecks': return { kind: 'rerun', repo: action.repo, workflowRunId: action.workflowRunId, attempt: action.previousAttempt + 1 };
      case 'merge': return { kind: 'merged', pr: action.pr, merge: { repo: action.target.repo, sha: sha(10_000 + ++this.serial) }, at: this.serial };
      case 'wake': return { kind: 'delivered', agentId: action.holder, messageId: `${effect.id}:${effect.attempt + 1}`, outcome: 'woken' };
    }
  }
  applySource(effect: Effect, result: EffectResult): void {
    const action = effect.action;
    this.environment(`source performs ${action.kind}`, facts => {
      switch (action.kind) {
        case 'publishPr': {
          if (result.kind !== 'published') this.fail('Mismatched publish result');
          const pr = makePr(result.pr, action.submission.payload.branch, action.submission.payload.head, action.target.base, action.member, action.submission.payload.title, action.body);
          const previous = facts.prs.find(row => sameRef(row.ref, result.pr));
          if (previous) { pr.checks = previous.checks; pr.mergeable = previous.mergeable; }
          facts.prs = [...facts.prs.filter(row => !sameRef(row.ref, result.pr)), pr];
          facts.links = [...facts.links.filter(row => !sameRef(row.issue, action.member)), { issue: action.member, pr: result.pr }];
          authorize(facts, pr); return;
        }
        case 'createIssue': {
          if (result.kind !== 'created') this.fail('Mismatched create result');
          facts.issues.push(snapshot(result.issue, action.spec.body));
          facts.createdIssues.push({ issue: result.issue, title: action.spec.title, body: action.spec.body, actor: action.actor, createdAt: this.serial }); return;
        }
        case 'attachChild': {
          const parent = this.sourceIssue(action.parent);
          if (!parent.children.some(ref => sameRef(ref, action.child))) parent.children.push(action.child); return;
        }
        case 'replaceBody': {
          const target = this.sourceIssue(action.edit.issue); target.body = action.edit.body; target.bodyHash = hash(action.edit.body); target.updatedAt = this.serial; return;
        }
        case 'setIssueState': {
          if (result.kind !== 'issueState') this.fail('Mismatched lifecycle result');
          const target = this.sourceIssue(action.issue); target.state = action.open ? 'open' : 'closed'; target.updatedAt = this.serial;
          if (action.open) target.lastReopen = result.event; else target.lastClose = result.event; return;
        }
        case 'rerunChecks': {
          facts.checkAttempts = facts.checkAttempts.filter(row => row.workflowRunId !== action.workflowRunId);
          facts.checkAttempts.push({ repo: action.repo, workflowRunId: action.workflowRunId, attempt: action.previousAttempt + 1, head: action.head });
          this.sourcePr(action.pr).checks = { kind: 'passing', required: [] }; return;
        }
        case 'merge': {
          if (result.kind !== 'merged') this.fail('Mismatched merge result');
          const pr = this.sourcePr(action.pr); pr.state = { kind: 'merged', sha: result.merge.sha, at: result.at };
          for (const repo of facts.repos) if (repo.repo.owner === action.target.repo.owner && repo.repo.name === action.target.repo.name) {
            const base = repo.bases.find(row => row.name === action.target.base);
            if (base?.state.kind === 'present') {
              // This successful source merge is built on the current target tip;
              // a base rewrite is a separate environment event, not this edge.
              const previousBase = base.state.head;
              const baseAncestors = facts.commits.filter(observation => observation.result === 'contains' && observation.descendant === previousBase && observation.repo.owner === repo.repo.owner && observation.repo.name === repo.repo.name);
              facts.commits.push({ repo: repo.repo, ancestor: previousBase, descendant: result.merge.sha, result: 'contains' });
              for (const observation of baseAncestors) facts.commits.push({ repo: observation.repo, ancestor: observation.ancestor, descendant: result.merge.sha, result: 'contains' });
              base.state.head = result.merge.sha;
            }
            facts.commits.push({ repo: repo.repo, ancestor: action.head, descendant: result.merge.sha, result: 'contains' });
            const carried = facts.commits.filter(observation => observation.result === 'contains' && observation.descendant === action.head && observation.repo.owner === action.target.repo.owner && observation.repo.name === action.target.repo.name);
            for (const observation of carried) facts.commits.push({ repo: observation.repo, ancestor: observation.ancestor, descendant: result.merge.sha, result: 'contains' });
            const previousDefault = repo.defaultHead;
            const defaultAncestors = facts.commits.filter(observation => observation.result === 'contains' && (observation.descendant === previousDefault || observation.descendant === result.merge.sha) && observation.repo.owner === repo.repo.owner && observation.repo.name === repo.repo.name);
            repo.defaultHead = sha(100_000 + ++this.serial);
            const defaultBase = repo.bases.find(row => row.name === repo.defaultBranch);
            if (defaultBase?.state.kind === 'present') defaultBase.state.head = repo.defaultHead;
            facts.commits.push({ repo: repo.repo, ancestor: previousDefault, descendant: repo.defaultHead, result: 'contains' });
            // The environment explicitly advances default by integrating the nondefault result.
            // This is a new source event, not an inference from the target-base merge.
            for (const merged of facts.prs) if (merged.state.kind === 'merged' && merged.target.repo.owner === repo.repo.owner && merged.target.repo.name === repo.repo.name) facts.commits.push({ repo: repo.repo, ancestor: merged.state.sha, descendant: repo.defaultHead, result: 'contains' });
            // Supply exact source-query results inherited from these modeled Git parents.
            for (const observation of defaultAncestors) facts.commits.push({ repo: observation.repo, ancestor: observation.ancestor, descendant: repo.defaultHead, result: 'contains' });
          }
          return;
        }
        case 'wake': return; // Delivery has no source-query proof; only the Host receipt can confirm it.
      }
    });
  }
  execute(effect: Effect, outcome: Outcome = 'success'): EffectResult | null {
    const source = this.input().facts;
    if (source.kind === 'unavailable') {
      const rejected = this.event({ kind: 'effectStarted', id: effect.id, attempt: effect.attempt + 1, startedAt: ++this.serial }, true);
      assert.equal(rejected.kind, 'rejected', 'Unavailable preflight must not start an attempt');
      if (rejected.kind === 'rejected') assert.equal(rejected.error.kind, 'sourceUnavailable');
      return null;
    }
    const satisfied = sourceCompletion(effect.action, source.facts);
    if (satisfied) {
      this.event({ kind: 'effectSatisfied', id: effect.id, result: satisfied });
      this.settle(); return satisfied;
    }
    const result = this.result(effect);
    const attempt = effect.attempt + 1;
    this.event({ kind: 'effectStarted', id: effect.id, attempt, startedAt: ++this.serial });
    if (outcome === 'success') {
      this.applySource(effect, result);
      this.event({ kind: 'effectConfirmed', id: effect.id, attempt, result });
    } else {
      if (outcome === 'confirmLost') this.applySource(effect, result);
      this.event({ kind: 'effectFailed', id: effect.id, attempt, error: outcome === 'failed' ? { kind: 'permission', message: 'Independent environment: source rejected before mutation' } : { kind: 'uncertainOutcome', message: 'Independent environment: response or confirmation lost' }, outcome: outcome === 'failed' ? 'knownFailed' : 'uncertain' });
    }
    this.settle(); return result;
  }
  safety(): void {
    const allMembers = this.state.units.flatMap(unit => unit.members);
    for (const effect of this.state.effects) {
      if (effect.action.kind !== 'merge' || effect.state.kind !== 'ready') continue;
      const action = effect.action;
      const member = allMembers.find(row => sameRef(row.ref, action.member));
      assert.ok(member, 'Merge target must be an exact member');
      assert.equal(member.work, null, 'No merge with an open owner obligation');
      assert.equal(member.binding.kind, 'registered', 'No merge with unconfirmed publication');
      assert.ok(member.baseline.kind !== 'none', 'Merge requires explicit adopted or accepted baseline');
      const acceptedHead = member.baseline.kind === 'submitted' ? member.baseline.submission.payload.head : member.baseline.kind === 'adopted' ? member.baseline.acceptedHead : null;
      assert.equal(action.head, acceptedHead, 'Merge head must have been explicitly accepted, not copied from source');
      const pr = this.sourcePr(action.pr);
      assert.equal(pr.head, acceptedHead, 'New source push cannot reuse old authorization');
      assert.equal(pr.checks.kind, 'passing', 'Required checks cannot be bypassed');
      assert.equal(pr.mergeable, 'yes', 'Unknown/conflicting mergeability is not a pass');
      assert.equal(member.review?.status.kind, 'answered'); assert.equal(member.accept?.status.kind, 'answered');
      assert.ok(member.review?.status.kind === 'answered' && member.review.status.ok);
      assert.ok(member.accept?.status.kind === 'answered' && member.accept.status.ok);
      assert.deepEqual(action.review, member.review?.stamp); assert.deepEqual(action.accept, member.accept?.stamp);
      assert.ok(!this.state.effects.some(candidate => candidate.action.kind === 'publishPr' && sameRef(candidate.action.member, member.ref) && !['confirmed', 'cancelled'].includes(candidate.state.kind)), 'No merge before publication source confirmation');
    }
    if (this.state.lifecycle === 'completed') {
      assert.equal(this.state.report?.state.kind, 'reported', 'Completion requires an actual Main report');
      assert.ok(this.state.effects.every(effect => effect.state.kind === 'confirmed' || effect.state.kind === 'cancelled'), 'Failed/unknown effects cannot disappear into completion');
      assert.ok(this.state.cases.every(item => item.state.kind === 'resolved' || item.state.kind === 'cancelled'));
      assert.ok(this.state.units.every(unit => unit.postMerge?.status.kind === 'answered' && unit.postMerge.status.ok && unit.members.every(member => member.terminal.kind !== 'pending' && member.work === null)));
    }
    const firstIncomplete = this.state.units.findIndex(unit => unit.members.some(member => member.terminal.kind === 'pending') || unit.postMerge?.status.kind !== 'answered' || !unit.postMerge.status.ok);
    if (firstIncomplete >= 0) for (const later of this.state.units.slice(firstIncomplete + 1)) {
      // Existing later work may be retained after reopen, but must carry a dependency.
      for (const member of later.members) if (member.work) assert.ok(member.work.holds.some(hold => hold.kind === 'dependency'), 'Later units must not run before the preceding unit is accepted');
    }
  }
  observable(): void {
    if (this.state.lifecycle === 'completed') return;
    const available = this.projection();
    const actionable = this.state.effects.some(effect => effect.state.kind === 'ready' || effect.state.kind === 'executing') || available.some(ticket => ticket.runDisposition === 'mustRun' || ticket.attentionRequired);
    const waiting = this.state.cases.some(item => item.state.kind === 'awaitingExternal') || this.state.effects.some(effect => (effect.state.kind === 'failed' || effect.state.kind === 'uncertain') && effect.state.wait !== null) || this.facts.prs.some(pr => pr.state.kind === 'open' && (pr.checks.kind === 'pending' || pr.checks.kind === 'unknown' || pr.mergeable === 'unknown'));
    if (!actionable && !waiting) this.fail('Active obligations have no program action, deliverable/claimable ticket, or explicit source waiting/attention');
    if (this.state.cases.some(item => item.subject.kind === 'stall' && item.state.kind === 'open')) this.fail('Real no-exit stall is a counterexample, not a progress whitelist');
  }
}

function question(): ProtocolReply {
  return { kind: 'claim', claim: { kind: 'question', reproduction: 'The entry point permits two interpretations of the required result.', readings: ['Preserve result A', 'Preserve result B'], earliestGap: 'Expected observable result is not disambiguated.', proposal: 'Main should identify the governing expected result without deleting either obligation.' } };
}
function draftSpec() {
  return { repo: REPO, title: 'Independent model correction', body: 'Repair the original observable contract and validate through the actual entry point.', target: { repo: REPO, base: 'integration' }, designOnly: false };
}
function caseTicket(driver: Driver, item: DecisionCase): Ticket {
  const ticket = driver.projection().find(row => row.id === `case:${item.id}`);
  if (!ticket) driver.fail(`Open case ${item.subject.kind} has no ticket`);
  return ticket;
}
function decision(driver: Driver, item: DecisionCase, value: CaseDecision): void {
  noReplyLoop(driver, `Main ${item.subject.kind} decision never replies`);
  driver.reply(caseTicket(driver, item), { kind: 'decision', decision: value }); driver.settle();
}

// This deliberately finite environment chooses to cooperate only in EF witnesses.
// Silence is separately an enabled self-loop for EVERY role, including Main.
function cooperativeStep(driver: Driver, recipe: Recipe, used: Set<string>): boolean {
  driver.settle();
  if (driver.state.lifecycle === 'completed') return false;
  if (driver.bindOne()) return true;
  const ready = driver.state.effects.find(effect => effect.state.kind === 'ready');
  if (ready) { driver.execute(ready); return true; }
  const ticket = driver.projection().find(row => row.runDisposition === 'mustRun');
  if (!ticket) { driver.observable(); return false; }
  if (ticket.id.startsWith('case:')) {
    const item = driver.state.cases.find(row => `case:${row.id}` === ticket.id);
    if (!item) driver.fail('Case ticket has no subject');
    switch (item.subject.kind) {
      case 'claim': {
        if ((recipe === 'amendment' || recipe === 'orphan') && !used.has('amended')) {
          used.add('amended');
          const member = driver.member();
          decision(driver, item, { kind: 'amend', amendment: { kind: 'designGap', affected: [member.ref], bodyEdits: [{ issue: member.ref, expectedHash: driver.sourceIssue(member.ref).bodyHash, body: 'Clarified contract: retain complete observable outcome and design requirement.' }], route: recipe === 'orphan' ? { kind: 'future', carrier: issue(2) } : { kind: 'withPr', member: member.ref } } });
        } else decision(driver, item, { kind: 'answer', basis: 'The complete original observable contract remains required; reading A governs this implementation.' });
        return true;
      }
      case 'findings': decision(driver, item, { kind: 'upholdOwner', basis: 'The independently observed defect belongs to the current member implementation.' }); return true;
      case 'checks': {
        const failure = item.subject.failures[0];
        if (!failure) return driver.fail('Checks case has no failed check to rerun');
        if (failure.kind !== 'actions') return driver.fail('Status checks have no legal rerun edge');
        decision(driver, item, { kind: 'rerun', runId: failure.workflowRunId }); return true;
      }
      case 'postMerge':
      case 'closure': {
        const unit = driver.state.units.find(row => row.members.some(member => sameRef(member.ref, issue(1))))!;
        decision(driver, item, { kind: 'correct', insertion: { kind: 'draft', draft: draftSpec(), position: { kind: 'correctionOf', unitId: unit.id } } }); return true;
      }
      case 'closed': decision(driver, item, { kind: 'reopen', eventId: item.subject.event?.id ?? 'missing-close-event' }); return true;
      case 'reopened': decision(driver, item, { kind: 'revokeNoCode', eventId: item.subject.event.id }); return true;
      case 'orphanDesign': decision(driver, item, { kind: 'assignCarrier', commit: item.subject.requirement.commit, carrier: { ...draftSpec(), designOnly: true } }); return true;
      case 'unexpectedSourceChange': decision(driver, item, { kind: 'keepWork', basis: 'The same member obligation remains; source repair is explicitly assigned.' }); return true;
      case 'agendaGap': decision(driver, item, { kind: 'includeExisting', issue: item.subject.issue, position: { kind: 'after', unitId: driver.state.units.at(-1)!.id } }); return true;
      case 'effectFailure':
      case 'hostPrecondition':
      case 'migration':
      case 'stall': driver.fail(`Cooperative recipe reached unplanned ${item.subject.kind}; do not invent an automatic Main recovery/fairness edge`);
    }
  }
  if (ticket.allowedReplies.includes('designCommit')) {
    const work = driver.state.designWorks.find(row => `work:${row.id}` === ticket.id);
    if (!work) driver.fail('Design ticket has no public DesignWork');
    noReplyLoop(driver, 'Main design work never replies');
    const commit = { repo: REPO, sha: sha(90_000) };
    driver.environment('remote source contains accepted design commit', facts => {
      facts.commits.push({ repo: REPO, ancestor: commit.sha, descendant: commit.sha, result: 'contains' });
      facts.commits.push({ repo: REPO, ancestor: commit.sha, descendant: facts.repos[0]!.defaultHead, result: recipe === 'orphan' ? 'notContained' : 'contains' });
    });
    driver.reply(ticket, { kind: 'designCommit', commit }); return true;
  }
  if (ticket.allowedReplies.includes('submit')) {
    if ((recipe === 'amendment' || recipe === 'orphan') && !used.has('claim')) { used.add('claim'); driver.reply(ticket, question()); return true; }
    if (recipe === 'rerun' && !used.has('failing-check')) {
      const member = driver.member(ticket.context.kind === 'member' ? ticket.context.member : issue(1));
      if (member.binding.kind === 'registered') {
        used.add('failing-check'); driver.environment('required Actions workflow fails', facts => {
          const pr = driver.sourcePr(member.binding.kind === 'registered' ? member.binding.pr : issue(-1));
          pr.checks = { kind: 'failing', required: [{ kind: 'actions', identity: { name: 'required-model-check', source: { kind: 'app', id: 9 } }, checkRunId: 99, workflowRunId: 77, jobId: 88, runAttempt: 1, head: pr.head }] };
          facts.checkAttempts.push({ repo: REPO, workflowRunId: 77, attempt: 1, head: pr.head });
        }); driver.settle(); return true;
      }
    }
    driver.submit(ticket); return true;
  }
  if (ticket.allowedReplies.includes('verdict')) {
    const postMerge = ticket.context.kind === 'unit';
    const reject = recipe === 'correction' && postMerge && !used.has('correction');
    if (reject) used.add('correction');
    driver.reply(ticket, { kind: 'verdict', ok: !reject, note: reject ? 'Actual original expected result is still missing; correction must be delivered within this unit.' : 'Independent observable contract verified at the exact assigned source baseline.' }); return true;
  }
  if (ticket.allowedReplies.includes('report')) { driver.reply(ticket, { kind: 'report', summary: 'All member, correction, post-merge and parent closure outcomes have been reported.' }); return true; }
  driver.fail(`No declared cooperative reply for ${ticket.id}`);
}
function finish(driver: Driver, recipe: Recipe = 'ordinary', used = new Set<string>()): void {
  for (let i = 0; i < ACTION_CAP; i += 1) {
    if (driver.state.lifecycle === 'completed') return;
    if (!cooperativeStep(driver, recipe, used)) driver.fail('EF cooperative witness stopped without completion');
  }
  driver.fail(`Exploration cap ${ACTION_CAP} reached; shortest pending trace retained, not accepted as proof`);
}

function noReplyLoop(driver: Driver, label: string): void {
  driver.settle(); driver.observable();
  const before = JSON.stringify(driver.state);
  const original = driver.projection();
  const result = driver.event({ kind: 'observe' });
  assert.equal(result.kind, 'same', `${label}: settled no-response observation must be a stuttering edge`);
  assert.equal(JSON.stringify(driver.state), before);
  assert.equal(driver.state.lifecycle, 'active', `${label}: silence cannot satisfy delivery`);
  assert.deepEqual(driver.projection(), original);
  driver.record(`${label}: infinite no-response self-loop remains enabled; AF completion is false`, null, 'same');
}

function stableWorkAfterPush(driver: Driver): void {
  const before = driver.member();
  const workId = before.work?.id;
  const revision = before.work?.contentVersion;
  const baseline = structuredClone(before.baseline);
  driver.environment('source push changes HEAD without an owner submission', facts => {
    const member = driver.member();
    if (member.binding.kind !== 'registered') driver.fail('Push scenario requires a registered adopted/published PR');
    const pr = driver.sourcePr(member.binding.pr); pr.head = sha(70_000 + ++driver.serial); pr.updatedAt = driver.serial;
    facts.branches = facts.branches.filter(row => row.name !== pr.headBranch);
    facts.branches.push({ repo: pr.headRepo, name: pr.headBranch, state: { kind: 'present', head: pr.head } });
    pr.checks = { kind: 'passing', required: [] };
  }); driver.settle();
  const after = driver.member();
  if (workId) { assert.equal(after.work?.id, workId); assert.equal(after.work?.contentVersion, revision); }
  else assert.ok(after.work, 'Unsubmitted source push must create an owner obligation');
  assert.deepEqual(after.baseline, baseline, 'Source observation must not refresh accepted baseline');
  assert.ok(!driver.state.effects.some(effect => effect.action.kind === 'merge' && effect.state.kind === 'ready'));
}

function pairwiseRows(): Scenario[] {
  const axes = [['submit', 'claim', 'silent'], ['stable', 'changed'], ['pass', 'notOk'], ['success', 'failed', 'unknown', 'confirmLost'], ['running', 'parked', 'aborted'], ['stable', 'edited']] as const;
  const candidates: number[][] = [];
  const product = (prefix: number[]): void => { if (prefix.length === axes.length) { candidates.push(prefix); return; } for (let n = 0; n < axes[prefix.length]!.length; n += 1) product([...prefix, n]); };
  product([]);
  const pairs = (row: number[]): string[] => row.flatMap((value, i) => row.slice(i + 1).map((other, delta) => `${i}:${value}/${i + delta + 1}:${other}`));
  const uncovered = new Set(candidates.flatMap(pairs));
  const chosen: number[][] = [];
  while (uncovered.size) {
    let best: number[] | undefined;
    let score = 0;
    for (const candidate of candidates) { const count = pairs(candidate).filter(pair => uncovered.has(pair)).length; if (count > score) { best = candidate; score = count; } }
    if (!best) throw new Error('Covering-array construction cannot make progress');
    chosen.push(best); for (const pair of pairs(best)) uncovered.delete(pair);
  }
  return chosen.map(row => ({ owner: axes[0][row[0]!]!, push: axes[1][row[1]!]!, gate: axes[2][row[2]!]!, effect: axes[3][row[3]!]!, seat: axes[4][row[4]!]!, body: axes[5][row[5]!]! }));
}

function until(driver: Driver, predicate: () => boolean, recipe: Recipe = 'ordinary', used = new Set<string>()): void {
  for (let i = 0; i < ACTION_CAP; i += 1) { if (predicate()) return; if (!cooperativeStep(driver, recipe, used)) driver.fail('Required reachable state was not reached'); }
  driver.fail(`Reachability cap ${ACTION_CAP} exceeded before predicate; shortest pending trace retained`);
}

function matrixRun(row: Scenario, index: number): void {
  const driver = new Driver(`pairwise-${index}:${JSON.stringify(row)}`, undefined, true);
  const used = new Set<string>();
  // Adopted+push+failure is exercised here without manufacturing an initial submit.
  driver.environment('adopted PR requires real owner repair', () => { driver.sourcePr(issue(201)).mergeable = 'no'; }); driver.settle();
  until(driver, () => driver.projection().some(ticket => ticket.allowedReplies.includes('submit') && ticket.holder.kind === 'seat' && ticket.holder.agentId !== null));
  const original = driver.member().work!;
  if (row.push === 'changed') stableWorkAfterPush(driver);
  driver.environment('base integration conflict source repaired', () => { driver.sourcePr(issue(201)).mergeable = 'yes'; }); driver.settle();
  if (row.owner === 'silent') noReplyLoop(driver, 'owner never replies (finite prefix before a separate cooperative branch)');
  if (row.owner === 'claim') {
    const ticket = driver.projection().find(ticket => ticket.allowedReplies.includes('submit'))!;
    driver.reply(ticket, question()); driver.settle();
    const held = driver.projection().find(ticket => ticket.id === `work:${original.id}`)!;
    assert.equal(held.runDisposition, 'mayWait');
    const wakeCount = driver.state.effects.filter(effect => effect.action.kind === 'wake').length;
    driver.environment('claim holder parks before repeated timer observation', (_facts, observation) => { observation.seats = observation.seats.map(seat => ({ ...seat, status: 'parked' })); });
    driver.settle(); noReplyLoop(driver, 'claim+park+timer');
    assert.equal(driver.state.effects.filter(effect => effect.action.kind === 'wake').length, wakeCount, 'Waiting claimant cannot receive an automatic wake');
    const item = driver.state.cases.find(item => item.subject.kind === 'claim' && item.state.kind === 'open')!;
    decision(driver, item, { kind: 'answer', basis: 'The original complete expected result governs; continue the same owner obligation.' });
    assert.equal(driver.member().work?.id, original.id);
    assert.ok(driver.member().work!.contentVersion > original.contentVersion);
  }
  if (row.seat !== 'running') {
    const request = driver.state.requests.find(request => request.role === 'owner')!;
    driver.environment(`owner registry status becomes ${row.seat}`, (_facts, observation) => { observation.seats = observation.seats.map(seat => seat.requestedName === request.name ? { ...seat, status: row.seat === 'parked' ? 'parked' : 'aborted' } : seat); }); driver.settle();
    if (row.seat === 'aborted') {
      assert.equal(driver.member().work?.id, original.id, 'Abort must not consume the owner obligation');
      until(driver, () => driver.projection().some(ticket => ticket.allowedReplies.includes('submit') && ticket.holder.kind === 'seat' && ticket.holder.agentId !== null));
    }
  }
  until(driver, () => driver.state.effects.some(effect => effect.action.kind === 'publishPr' && effect.state.kind === 'ready'), 'ordinary', used);
  const publication = driver.state.effects.find(effect => effect.action.kind === 'publishPr' && effect.state.kind === 'ready')!;
  if (row.effect !== 'success') {
    const result = driver.execute(publication, row.effect);
    assert.ok(result, 'The available source permits this unsatisfied publication attempt');
    const failed = driver.state.effects.find(effect => effect.id === publication.id)!;
    assert.equal(failed.state.kind, row.effect === 'failed' ? 'failed' : 'uncertain');
    noReplyLoop(driver, 'Main may never decide an effect failure');
    if (row.effect === 'confirmLost') {
      driver.event({ kind: 'effectSatisfied', id: failed.id, result }); driver.settle();
    } else if (row.effect === 'unknown') {
      driver.observable();
      driver.applySource(publication, result);
      driver.event({ kind: 'effectSatisfied', id: failed.id, result }); driver.settle();
    } else {
      const item = driver.state.cases.find(item => item.subject.kind === 'effectFailure' && item.subject.effectId === failed.id && item.state.kind === 'open')!;
      decision(driver, item, { kind: 'retry', effectId: failed.id, attempt: failed.attempt });
    }
  }
  until(driver, () => driver.projection().some(ticket => ticket.id === `gate:${driver.member().review?.id}` && ticket.holder.kind === 'seat' && ticket.holder.agentId !== null));
  if (row.body === 'edited') {
    const stale = driver.projection().find(ticket => ticket.id === `gate:${driver.member().review?.id}`)!;
    driver.environment('human edits PR evidence at the same HEAD', () => { const pr = driver.sourcePr(issue(201)); pr.body += '\nHuman evidence retained.'; pr.bodyHash = hash(pr.body); pr.updatedAt = ++driver.serial; }); driver.settle();
    const response = driver.reply(stale, { kind: 'verdict', ok: true, note: 'Stale inputs must not authorize a merge.' }, true);
    assert.equal(response.kind, 'rejected', 'Body-only source change must reject the old review verdict');
  }
  if (row.gate === 'notOk') {
    until(driver, () => driver.projection().some(ticket => ticket.id.startsWith('gate:') && ticket.context.kind === 'member' && ticket.holder.kind === 'seat' && ticket.holder.agentId !== null));
    const gate = driver.projection().find(ticket => ticket.id.startsWith('gate:') && ticket.context.kind === 'member' && ticket.holder.kind === 'seat' && ticket.holder.agentId !== null)!;
    driver.reply(gate, { kind: 'verdict', ok: false, note: 'The required observable behavior has a concrete independent defect.' }); driver.settle();
    assert.ok(driver.state.cases.some(item => item.subject.kind === 'findings' && item.state.kind === 'open'), 'not-ok must retain a decision obligation');
    noReplyLoop(driver, 'Main findings decision never arrives');
  }
  finish(driver);
}

describe('independent bounded production transition model', () => {
  const rows = pairwiseRows();
  for (const [index, row] of rows.entries()) {
    const name = `pairwise-${index}`;
    if (process.env.RT_MODEL_CASE && process.env.RT_MODEL_CASE !== name) continue;
    test(`${name}: ${JSON.stringify(row)}`, () => matrixRun(row, index));
  }

  test('all four owner claim kinds retain the work through park/timer and resume once', () => {
    const claims: ProtocolReply[] = [
      question(),
      { kind: 'claim', claim: { kind: 'noCode', evidence: 'The current source appears to satisfy the complete required result.' } },
      { kind: 'claim', claim: { kind: 'split', proposal: 'A separately owned prerequisite may need a distinct member without deleting this obligation.' } },
      { kind: 'claim', claim: { kind: 'blocked', category: 'external dependency', attempts: 'Queried the authoritative dependency and retained the exact unresolved requirement.' } },
    ];
    for (const payload of claims) {
      if (payload.kind !== 'claim') throw new Error('Claim fixture must use the public claim variant');
      const driver = new Driver(`owner-claim:${payload.claim.kind}`);
      until(driver, () => driver.projection().some(ticket => ticket.allowedReplies.includes('submit') && ticket.holder.kind === 'seat' && ticket.holder.agentId !== null));
      const original = structuredClone(driver.member().work!);
      const ticket = driver.projection().find(row => row.id === `work:${original.id}`)!;
      const accepted = driver.reply(ticket, payload);
      const replay = driver.reply(ticket, payload);
      assert.equal(replay.kind, 'same', 'Identical intermediate claim replays its exact result');
      if (accepted.kind !== 'rejected') assert.deepEqual(replay.reply, accepted.reply);
      driver.settle();
      driver.environment('claim owner parks while Main may never answer', (_facts, observation) => { observation.seats = observation.seats.map(seat => ({ ...seat, status: 'parked' })); });
      driver.settle();
      assert.equal(driver.projection().find(row => row.id === ticket.id)?.runDisposition, 'mayWait');
      assert.ok(!driver.state.effects.some(effect => effect.action.kind === 'wake' && effect.state.kind === 'ready'), 'Any unresolved personal claim blocks wake');
      noReplyLoop(driver, `${payload.claim.kind}+park+timer`);
      const pending = driver.state.cases.find(item => item.subject.kind === 'claim' && item.state.kind === 'open')!;
      decision(driver, pending, payload.claim.kind === 'question' ? { kind: 'answer', basis: 'The complete original expected result remains the owner obligation.' } : { kind: 'refute', basis: 'Source evidence does not support removing or pausing the original implementation obligation.' });
      assert.equal(driver.member().work?.id, original.id);
      assert.equal(driver.member().work?.contentVersion, original.contentVersion + 1, 'The final hold release advances the same work exactly once');
      const deliveries = driver.state.effects.filter(effect => effect.action.kind === 'wake' && effect.action.ticket === ticket.id);
      assert.equal(deliveries.length, 1, 'A resumed parked content version receives one automatic delivery intent, without retryHost');
      driver.settle();
      assert.equal(driver.state.effects.filter(effect => effect.action.kind === 'wake' && effect.action.ticket === ticket.id).length, 1, 'Repeated timer cannot invent another parked epoch delivery');
    }
  });

  test('gate claim cancels the old obligation and answers are carried into a fresh holder', () => {
    const driver = new Driver('gate-question:fresh-job', undefined, true);
    until(driver, () => driver.projection().some(ticket => ticket.id === `gate:${driver.member().review?.id}` && ticket.holder.kind === 'seat' && ticket.holder.agentId !== null));
    const original = structuredClone(driver.member().review!);
    const ticket = driver.projection().find(row => row.id === `gate:${original.id}`)!;
    driver.reply(ticket, question()); driver.settle();
    assert.equal(driver.member().review?.status.kind, 'cancelled');
    const pending = driver.state.cases.find(item => item.subject.kind === 'claim' && item.state.kind === 'open')!;
    decision(driver, pending, { kind: 'outOfDomain', basis: 'This question concerns a separately owned implementation; the original review obligation and complete contract remain.' });
    until(driver, () => driver.member().review !== null && driver.member().review!.id !== original.id && driver.projection().some(row => row.id === `gate:${driver.member().review?.id}` && row.holder.kind === 'seat' && row.holder.agentId !== null));
    const fresh = driver.member().review!;
    assert.notEqual(fresh.requestId, original.requestId, 'A question-answer cycle cannot reuse the previous reviewer');
    assert.equal(fresh.stamp.kind, 'review');
    if (fresh.stamp.kind === 'review') assert.ok(fresh.stamp.rulings.some(ruling => ruling.kind === 'questionAnswered' && ruling.classification === 'outOfDomain'), 'Fresh source stamp must retain the exact current answer');
    const freshTicket = driver.projection().find(row => row.id === `gate:${fresh.id}`)!;
    assert.ok(freshTicket.brief.includes('separately owned implementation'), 'New reviewer receives the Main answer even without body edits');
    const rejected = driver.reply(ticket, { kind: 'verdict', ok: true, note: 'This old reviewer can no longer discharge the fresh obligation.' }, true);
    assert.equal(rejected.kind, 'rejected');
    if (rejected.kind === 'rejected') assert.equal(rejected.error.kind, 'superseded');
    driver.observable();
  });

  test('EF has a cooperative completion witness but every role can stutter forever', () => {
    const driver = new Driver('EF versus guaranteed completion');
    const seen = new Set<string>();
    const visitedRoles = new Set<string>();
    for (let step = 0; step < ACTION_CAP; step += 1) {
      driver.settle();
      for (const ticket of driver.projection()) {
        const role = ticket.id.startsWith('spawn:') ? 'main-spawn' : ticket.id.startsWith('case:') ? 'main-case' : ticket.allowedReplies.includes('report') ? 'main-report' : ticket.holder.kind === 'main' ? 'main-design' : driver.state.requests.find(request => ticket.holder.kind === 'seat' && request.id === ticket.holder.requestId)?.role;
        if (role && !visitedRoles.has(role)) { visitedRoles.add(role); noReplyLoop(driver, `${role} never replies`); }
      }
      if (driver.state.lifecycle === 'completed') break;
      if (!cooperativeStep(driver, 'ordinary', seen)) driver.fail('Cooperative path has no completion edge');
    }
    assert.equal(driver.state.lifecycle, 'completed', 'EF completion must be witnessed, not inferred from ticket existence');
    for (const role of ['owner', 'review', 'accept', 'postMerge', 'closure', 'main-spawn', 'main-report']) assert.ok(visitedRoles.has(role), `No-response self-loop not reached for ${role}`);
  });

  test('all public Action kinds have reachable success/rejection/unknown/confirmation-loss branches', () => {
    const seeds = new Map<Action['kind'], Seed>();
    for (const recipe of ['ordinary', 'correction', 'amendment', 'rerun'] as const) {
      const driver = new Driver(`action-seed:${recipe}`, undefined, recipe === 'rerun');
      const used = new Set<string>();
      if (recipe === 'ordinary') {
        until(driver, () => driver.host.seats.length > 0);
        driver.environment('runnable owner parks before first delivery', (_facts, observation) => { observation.seats = observation.seats.map(seat => ({ ...seat, status: 'parked' })); });
        driver.settle();
      }
      if (recipe === 'rerun') {
        driver.environment('adopted required workflow fails before repair', facts => {
          const pr = driver.sourcePr(issue(201)); pr.checks = { kind: 'failing', required: [{ kind: 'actions', identity: { name: 'model-check', source: { kind: 'app', id: 9 } }, checkRunId: 99, workflowRunId: 77, jobId: 88, runAttempt: 1, head: pr.head }] };
          facts.checkAttempts.push({ repo: REPO, workflowRunId: 77, attempt: 1, head: pr.head });
        }); driver.settle(); used.add('failing-check');
      }
      finish(driver, recipe, used);
      for (const [kind, seed] of driver.seeds) if (!seeds.has(kind)) seeds.set(kind, seed);
    }
    assert.deepEqual([...seeds.keys()].sort(), [...ALL_ACTIONS].sort(), 'A missing Action seed is uncovered behavior, never a skipped passing case');
    let satisfiedScenarios = 0;
    for (const kind of ALL_ACTIONS) {
      const seed = seeds.get(kind)!;
      for (const outcome of ['success', 'failed', 'unknown', 'confirmLost'] as const) {
        const driver = new Driver(`action:${kind}/${outcome}`, seed);
        const effect = driver.state.effects.find(effect => effect.action.kind === kind && effect.state.kind === 'ready')!;
        assert.equal(sourceCompletion(effect.action, driver.facts), null, 'Every Action/outcome seed must be genuinely unsatisfied');
        const beforeMembers = driver.state.units.flatMap(unit => unit.members).map(member => ({ ref: member.ref, workId: member.work?.id }));
        const result = driver.execute(effect, outcome);
        assert.ok(result, 'An available unsatisfied seed must preserve the original execution outcome');
        const after = driver.state.effects.find(row => row.id === effect.id);
        if (outcome === 'success') assert.ok(!after || after.state.kind === 'confirmed', 'Only the real source/host result can confirm');
        else {
          assert.ok(after && after.state.kind === (outcome === 'failed' ? 'failed' : 'uncertain'), 'Failure outcome must remain an unclosed obligation');
          const attempts = after.attempt;
          driver.settle(); noReplyLoop(driver, `${kind}/${outcome}: Main never answers`);
          assert.equal(driver.state.effects.find(row => row.id === effect.id)?.attempt, attempts, 'Timer cannot auto-retry a failed/unknown mutation');
          assert.ok(driver.state.cases.some(item => (item.subject.kind === 'effectFailure' && item.subject.effectId === effect.id) || (item.subject.kind === 'hostPrecondition' && item.subject.effectId === effect.id)), 'Every failed/unknown Action must retain an exact Main recovery entry');
          if (outcome === 'confirmLost') {
            const confirmation = driver.event({ kind: 'effectSatisfied', id: effect.id, result }, kind === 'wake' || kind === 'createIssue');
            if (kind === 'wake' || kind === 'createIssue') assert.equal(confirmation.kind, 'rejected', 'No invented proof from live registry or create candidates');
            else assert.notEqual(confirmation.kind, 'rejected', 'Queryable source success can reconcile without mutation retry');
          }
        }
        if (kind === 'wake') for (const before of beforeMembers) if (before.workId) assert.equal(driver.member(before.ref).work?.id, before.workId, 'Delivery/failure is never an owner completion');
        driver.safety();
      }
      // A crash after durable start but before the call is distinct from an
      // applied write whose response/confirmation was lost above.
      const crash = new Driver(`action:${kind}/start-with-no-call-crash`, seed);
      const pending = crash.state.effects.find(effect => effect.action.kind === kind && effect.state.kind === 'ready')!;
      const originalFacts = structuredClone(crash.facts);
      const attempt = pending.attempt + 1;
      const startedAt = ++crash.serial;
      const crashTrace = crash.trace.length;
      crash.event({ kind: 'effectStarted', id: pending.id, attempt, startedAt });
      const recovered = new Driver(`action:${kind}/recovered-unsent-executing`, crash.seed());
      recovered.event({ kind: 'effectFailed', id: pending.id, attempt, error: { kind: 'uncertainOutcome', message: 'Process exited after durable start, before any external call; recovery cannot infer absence from local memory' }, outcome: 'uncertain' });
      recovered.settle();
      assert.deepEqual(recovered.facts, originalFacts, 'A start-with-no-call crash cannot apply a source mutation');
      assert.equal(recovered.state.effects.find(effect => effect.id === pending.id)?.state.kind, 'uncertain');
      assert.equal(recovered.trace.slice(crashTrace).filter(step => step.label === `source performs ${kind}`).length, 0);
      noReplyLoop(recovered, `${kind}: no fairness edge resolves a recovered unknown call`);

      if (kind === 'createIssue' || kind === 'wake') {
        const negative = new Driver(`action:${kind}/false-source-proof`, seed);
        const effect = negative.state.effects.find(effect => effect.action.kind === kind && effect.state.kind === 'ready')!;
        const result = negative.result(effect);
        if (kind === 'createIssue') negative.applySource(effect, result); // Even one exact actor/title/body candidate is not identity.
        else negative.environment('holder is live but delivery has no queryable receipt', (_facts, observation) => {
          observation.seats = observation.seats.map(seat => seat.agentId === (effect.action.kind === 'wake' ? effect.action.holder : '') ? { ...seat, status: 'running' } : seat);
        });
        assert.equal(sourceCompletion(effect.action, negative.facts), null);
        const before = JSON.stringify(negative.state);
        assert.equal(negative.event({ kind: 'effectSatisfied', id: effect.id, result }, true).kind, 'rejected', 'Candidate/live observations cannot satisfy a ready action');
        assert.equal(JSON.stringify(negative.state), before);
        const traceStart = negative.trace.length;
        negative.execute(effect, 'failed');
        assert.equal(negative.trace.slice(traceStart).filter(step => step.event?.kind === 'effectStarted' && step.result === 'next').length, 1, 'False proofs must retain the unsatisfied execution path');
        continue;
      }

      for (const outcome of ['success', 'failed', 'unknown', 'confirmLost'] as const) {
        const satisfied:Driver = new Driver(`action:${kind}/already-satisfied/${outcome}`, seed);
        const effect:Effect = satisfied.state.effects.find(effect => effect.action.kind === kind && effect.state.kind === 'ready')!;
        const sourceResult:EffectResult = satisfied.result(effect);
        satisfied.applySource(effect, sourceResult); // Independent source change before this executor turn, not this turn's call.
        assert.deepEqual(sourceCompletion(effect.action, satisfied.facts), sourceResult, 'The exact source fields must independently prove the completed target');
        const factsBefore = structuredClone(satisfied.facts);
        const serialBefore = satisfied.serial;
        const traceStart = satisfied.trace.length;
        assert.deepEqual(satisfied.execute(effect, outcome), sourceResult);
        const execution = satisfied.trace.slice(traceStart);
        assert.equal(execution[0]?.event?.kind, 'effectSatisfied', 'Source proof must precede any attempt or outcome generation');
        assert.ok(!execution.some(step => step.event?.kind === 'effectStarted'), 'Already-satisfied targets have zero new executing attempts');
        assert.ok(!execution.some(step => step.label.startsWith('source performs ')), 'Already-satisfied targets have zero mutations');
        assert.equal(satisfied.state.effects.find(row => row.id === effect.id)?.attempt ?? effect.attempt, effect.attempt);
        assert.equal(satisfied.serial, serialBefore, 'Preflight must not even generate/consume the hypothetical call outcome');
        assert.deepEqual(satisfied.facts, factsBefore);
        satisfiedScenarios += 1;

        if (outcome === 'success') {
          const nearMiss = structuredClone(satisfied.facts);
          const action = effect.action;
          switch (action.kind) {
            case 'publishPr': nearMiss.prs.find(pr => sameRef(pr.ref, sourceResult.kind === 'published' ? sourceResult.pr : issue(-1)))!.title += ' different'; break;
            case 'attachChild': nearMiss.issues.find(row => sameRef(row.ref, action.parent))!.children = []; break;
            case 'replaceBody': nearMiss.issues.find(row => sameRef(row.ref, action.edit.issue))!.bodyHash = hash('Different source body'); break;
            case 'setIssueState': {
              const target = nearMiss.issues.find(row => sameRef(row.ref, action.issue))!;
              const later = { id: 'later-opposite-event', at: satisfied.serial + 1 };
              if (action.open) target.lastClose = later; else target.lastReopen = later;
              break;
            }
            case 'rerunChecks': nearMiss.checkAttempts = nearMiss.checkAttempts.map(run => ({ ...run, head: sha(999_999) })); break;
            case 'merge': nearMiss.prs.find(pr => sameRef(pr.ref, action.pr))!.target.base = 'different-base'; break;
            case 'createIssue':
            case 'wake': assert.fail('Nonqueryable actions must not enter the satisfied scenario');
          }
          assert.equal(sourceCompletion(action, nearMiss), null, 'A one-field source near miss is not a completion proof');
          if (action.kind === 'publishPr' && sourceResult.kind === 'published') {
            const exact = satisfied.facts.prs.find(pr => sameRef(pr.ref, sourceResult.pr))!;
            const mismatches: readonly ((pr: PrSnapshot) => void)[] = [
              pr => { pr.ref.repo = { ...REPO, name: 'other-repository' }; },
              pr => { pr.headRepo = { ...REPO, owner: 'foreign-fork' }; },
              pr => { pr.headBranch += '-other'; },
              pr => { pr.target.repo = { ...REPO, name: 'other-base-repository' }; },
              pr => { pr.target.base += '-other'; },
              pr => { pr.head = sha(999_998); },
              pr => { pr.body += '\nDifferent evidence'; pr.bodyHash = hash(pr.body); },
              pr => { pr.state = { kind: 'closed' }; },
            ];
            for (const mismatch of mismatches) {
              const partial = structuredClone(satisfied.facts);
              mismatch(partial.prs.find(pr => sameRef(pr.ref, exact.ref))!);
              assert.equal(sourceCompletion(action, partial), null, 'Every publish identity/content field is required');
            }
            const ambiguous = structuredClone(satisfied.facts);
            ambiguous.prs.push({ ...structuredClone(exact), ref: issue(999_997) });
            assert.equal(sourceCompletion({ ...action, pr: null }, ambiguous), null, 'Two exact OPEN candidates do not establish an unregistered PR identity');
            assert.deepEqual(sourceCompletion({ ...action, pr: exact.ref }, ambiguous), sourceResult, 'An exact registered identity disambiguates the otherwise identical candidates');
            assert.equal(sourceCompletion({ ...action, pr: issue(999_996) }, satisfied.facts), null, 'Registration cannot invent a source PR');
          }
          if (action.kind === 'setIssueState') {
            assert.equal(sourceCompletion({ ...action, afterEvent: { id: 'newer-decision-basis', at: satisfied.serial + 1 } }, satisfied.facts), null, 'A target state predating the deciding lifecycle event is not completion');
          }
          if (action.kind === 'rerunChecks') {
            assert.equal(sourceCompletion(action, { ...satisfied.facts, checkAttempts: satisfied.facts.checkAttempts.map(run => ({ ...run, attempt: action.previousAttempt })) }), null, 'An unchanged run attempt is not a completed rerun');
          }
        }
      }

      const unavailable = new Driver(`action:${kind}/source-preflight-unavailable`, seed);
      const unavailableEffect = unavailable.state.effects.find(effect => effect.action.kind === kind && effect.state.kind === 'ready')!;
      const unavailableState = structuredClone(unavailable.state);
      const unavailableTrace = unavailable.trace.length;
      unavailable.sourceUnavailable = true;
      assert.equal(unavailable.execute(unavailableEffect), null);
      assert.deepEqual(unavailable.state, unavailableState, 'Source failure cannot start or consume an intent');
      assert.ok(!unavailable.trace.slice(unavailableTrace).some(step => step.event?.kind === 'effectStarted' && step.result === 'next'));
      assert.ok(!unavailable.trace.slice(unavailableTrace).some(step => step.label.startsWith('source performs ')));

      if (kind === 'replaceBody') {
        for (const timing of ['beforeStart', 'afterStart'] as const) {
          const changed = new Driver(`action:replaceBody/external-change-${timing}`, seed);
          const effect = changed.state.effects.find(effect => effect.action.kind === 'replaceBody' && effect.state.kind === 'ready')!;
          if (effect.action.kind !== 'replaceBody') assert.fail('Exact replaceBody seed required');
          const targetRef = effect.action.edit.issue;
          const attempt = effect.attempt + (timing === 'afterStart' ? 1 : 0);
          const startedAt = ++changed.serial;
          if (timing === 'afterStart') changed.event({ kind: 'effectStarted', id: effect.id, attempt, startedAt });
          changed.environment('another client changes the authoritative body independently', () => {
            const target = changed.sourceIssue(targetRef); target.body = 'Concurrent human edit, not this effect target'; target.bodyHash = hash(target.body); target.updatedAt = ++changed.serial;
          });
          if (timing === 'beforeStart') assert.equal(changed.event({ kind: 'effectStarted', id: effect.id, attempt: attempt + 1, startedAt: ++changed.serial }, true).kind, 'rejected', 'Unsent changed preconditions cannot start a mutation');
          changed.event({ kind: 'effectFailed', id: effect.id, attempt, error: { kind: 'precondition', message: 'Authoritative body no longer matches the expected hash' }, outcome: 'knownFailed' });
          const failed = changed.state.effects.find(row => row.id === effect.id)!;
          assert.equal(failed.attempt, attempt);
          assert.equal(failed.state.kind, 'failed');
          if (failed.state.kind === 'failed') {
            assert.equal(failed.state.provenance.kind, timing === 'beforeStart' ? 'preflight' : 'call', 'A post-start rejection must retain actual call provenance');
            if (failed.state.provenance.kind === 'call') assert.equal(failed.state.provenance.startedAt, startedAt);
          }
          changed.settle(); noReplyLoop(changed, `replaceBody/${timing}: explicit failure remains visible without retry fairness`);
        }
      }
    }
    assert.equal(satisfiedScenarios, 6 * 4, 'Every queryable Action has an explicit satisfied seed for every hypothetical outcome');
  });

  test('contract+close+orphan retains the exact design obligation after its carrier is noCode', () => {
    const driver = new Driver('explicit:contract+close+orphan');
    const used = new Set<string>();
    until(driver, () => driver.member(issue(2)).contract.requirements.length > 0, 'orphan', used);
    const requirement = structuredClone(driver.member(issue(2)).contract.requirements[0]!);
    const design = driver.state.designWorks.find(work => work.result?.sha === requirement.commit.sha)!;
    assert.ok(design, 'The design requirement must come from an accepted real DesignWork reply');
    noReplyLoop(driver, 'Main design/case roles are never fair by assumption');
    until(driver, () => driver.state.units[0]!.postMerge?.status.kind === 'answered' && driver.state.units[0]!.postMerge.status.ok, 'orphan', used);
    driver.environment('source closes the future design carrier without merge', () => {
      const source = driver.sourceIssue(issue(2)); source.state = 'closed'; source.lastClose = { id: 'carrier-manual-close', at: ++driver.serial }; source.updatedAt = driver.serial;
    }); driver.settle();
    const closed = driver.state.cases.find(item => item.subject.kind === 'closed' && item.context.kind === 'member' && sameRef(item.context.member, issue(2)) && item.state.kind === 'open');
    if (!closed) return driver.fail('Carrier close lost its exact closed classification entry');
    decision(driver, closed, { kind: 'confirmNoCode', bodyHash: driver.sourceIssue(issue(2)).bodyHash, reason: 'This carrier contains no implementation change; the unlanded design must not be discarded.' });
    const orphan = driver.state.cases.find(item => item.subject.kind === 'orphanDesign' && item.subject.requirement.commit.sha === requirement.commit.sha && item.state.kind === 'open');
    if (!orphan) return driver.fail('No-code carrier silently discarded an unlanded design commit');
    assert.equal(orphan.subject.kind, 'orphanDesign');
    if (orphan.subject.kind === 'orphanDesign') assert.deepEqual(orphan.subject.requirement.commit, requirement.commit);
    driver.observable();
  });

  test('breadth-first bounded interleavings preserve safety and fail rather than truncate at a cap', () => {
    const root = new Driver('BFS root', undefined, true);
    root.environment('source requires repair of adopted PR', () => { root.sourcePr(issue(201)).mergeable = 'no'; }); root.settle();
    until(root, () => root.projection().some(ticket => ticket.allowedReplies.includes('submit') && ticket.holder.kind === 'seat' && ticket.holder.agentId !== null));
    type Node = { seed: Seed; remaining: readonly ('push' | 'claim' | 'park' | 'abort' | 'body' | 'close')[] };
    const queue: Node[] = [{ seed: root.seed(), remaining: ['push', 'claim', 'park', 'abort', 'body', 'close'] }];
    const seen = new Set<string>();
    const cap = 2_500;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      if (cursor >= cap) new Driver('BFS shortest pending cap trace', queue[cursor]!.seed).fail(`BFS cap ${cap} reached with unexplored legal interleavings`);
      const node = queue[cursor]!;
      const driver = new Driver('BFS independent environment', node.seed);
      driver.safety(); driver.observable();
      // No role reply is required: a settled stuttering path is checked at every node.
      noReplyLoop(driver, 'all enabled roles remain silent');
      for (const stimulus of node.remaining) {
        const child = new Driver(`BFS:${stimulus}`, node.seed);
        if (stimulus === 'push') stableWorkAfterPush(child);
        if (stimulus === 'claim') {
          const ticket = child.projection().find(row => row.allowedReplies.includes('submit') && row.runDisposition === 'mustRun' && row.holder.kind === 'seat' && row.holder.agentId !== null);
          if (!ticket) continue; // The public state has no legal owner claim edge here.
          child.reply(ticket, question()); child.settle();
        }
        if (stimulus === 'park' || stimulus === 'abort') {
          child.environment(`registry ${stimulus}`, (_facts, observation) => { observation.seats = observation.seats.map(row => ({ ...row, status: stimulus === 'park' ? 'parked' : 'aborted' })); }); child.settle();
        }
        if (stimulus === 'body') {
          child.environment('source edits issue body', () => { const target = child.sourceIssue(issue(1)); target.body += '\nAdditional clarified requirement.'; target.bodyHash = hash(target.body); target.updatedAt = ++child.serial; }); child.settle();
        }
        if (stimulus === 'close') {
          child.environment('source closes member without merge', () => { const target = child.sourceIssue(issue(1)); target.state = 'closed'; target.lastClose = { id: 'bfs-close', at: ++child.serial }; }); child.settle();
        }
        const remaining = node.remaining.filter(value => value !== stimulus);
        const key = JSON.stringify({ state: child.state, facts: child.facts, host: child.host, remaining });
        if (!seen.has(key)) { seen.add(key); queue.push({ seed: child.seed(), remaining }); }
      }
    }
    assert.ok(queue.some(node => node.remaining.length === 0), 'The full bounded environment frontier, not merely its initial state, must be explored');
  }, 30_000);
});
