import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAgenda, parseAgenda, parsePortInput, tickets, transition } from '../../src/domain/index.ts';
import type { Agenda, Caller, CaseDecision, Claim, ConveneInput, DecisionCase, Effect, EffectResult, Entry, Event, Facts, GateJob, GateKind, HostSeat, Inputs, IssueRef, IssueSnapshot, Member, OwnerWork, PrSnapshot, PrSubmit, ProtocolReply, Repo, Ticket, Transition } from '../../src/domain/model.ts';

// Independent environment: no author fixtures, allocation helpers, or private transitions.
export const repo: Repo = { owner: 'Verifier', name: 'roundtable' };
export const otherRepo: Repo = { owner: 'Verifier', name: 'other' };
export const sha = (digit: string): string => digit.repeat(40);
export const h1 = sha('1');
export const h2 = sha('2');
export const baseHead = sha('a');
export const designHead = sha('d');
export const hash = (body: string): string => createHash('sha256').update(body).digest('hex');
export const issue = (number: number, inRepo: Repo = repo): IssueRef => ({ repo: inRepo, number });
export const equalRef = (left: IssueRef, right: IssueRef): boolean => left.number === right.number && left.repo.owner === right.repo.owner && left.repo.name === right.repo.name;
export const main: Caller = { agentId: 'Main', sessionId: 'main-session', parentId: null, runId: 'run-one', kind: 'main', depth: 0 };
export const checkIdentity = { name: 'required-verification', source: { kind: 'app' as const, id: 12 } };
export const checkFailure = { kind: 'actions' as const, identity: checkIdentity, checkRunId: 71, workflowRunId: 72, jobId: 73, runAttempt: 1, head: h1 };
export function entry(number: number, adopt = false, inRepo: Repo = repo): Entry {
  return { issue: issue(number, inRepo), target: { repo: inRepo, base: 'main' }, designOnly: false, adoptPr: adopt ? issue(number + 100, inRepo) : null };
}
export function sourceIssue(ref: IssueRef): IssueSnapshot {
  const body = `Deliver issue ${ref.number}: concrete behavior and independent runtime evidence.`;
  return { ref, body, bodyHash: hash(body), updatedAt: 100, state: 'open', lastClose: null, lastReopen: null, children: [] };
}
export function sourcePr(item: Entry): PrSnapshot {
  const body = `Independent adopted implementation.\n\nCloses ${item.issue.repo.owner}/${item.issue.repo.name}#${item.issue.number}`;
  return { ref: item.adoptPr ?? issue(item.issue.number + 100, item.issue.repo), headRepo: item.issue.repo, headBranch: `deliver-${item.issue.number}`, head: h1, target: item.target, title: `Deliver ${item.issue.number}`, body, bodyHash: hash(body), updatedAt: 100, state: { kind: 'open' }, closes: [item.issue], mergeable: 'yes', checks: { kind: 'passing', required: [checkIdentity] } };
}
export function sourceFacts(entries: readonly Entry[], parent: IssueRef | null = null): Facts {
  const repos: Repo[] = [];
  for (const item of entries) if (!repos.some(value => value.owner === item.target.repo.owner && value.name === item.target.repo.name)) repos.push(item.target.repo);
  const prs = entries.filter(item => item.adoptPr !== null).map(sourcePr);
  return {
    viewer: 'Verifier',
    issues: [...entries.map(item => sourceIssue(item.issue)), ...(parent ? [{ ...sourceIssue(parent), children: entries.map(item => item.issue) }] : [])],
    prs, links: prs.flatMap(pr => pr.closes.map(member => ({ issue: member, pr: pr.ref }))),
    repos: repos.map(value => ({ repo: value, defaultBranch: 'main', defaultHead: baseHead, bases: [{ name: 'main', state: { kind: 'present', head: baseHead, isDefault: true, rules: { required: [checkIdentity], strict: false, upToDate: true, constraints: [] } } }] })),
    branches: [...repos.map(value => ({ repo: value, name: 'main', state: { kind: 'present' as const, head: baseHead } })), ...prs.map(pr => ({ repo: pr.headRepo, name: pr.headBranch, state: { kind: 'present' as const, head: pr.head } }))],
    maintenance: prs.map(pr => ({ pr: pr.ref, result: { kind: 'maintainable', basis: { headRepo: pr.headRepo, headBranch: pr.headBranch, viewerPermission: 'ADMIN', author: 'Verifier', maintainerCanModify: true, authorization: { kind: 'actorIsAuthor', actor: 'Verifier' } } } })),
    commits: [], checkAttempts: prs.map(pr => ({ repo: pr.ref.repo, workflowRunId: 72, attempt: 1, head: pr.head })), createdIssues: [],
  };
}
export type TraceSink = (record: unknown) => void;
export class Scene {
  state: Agenda;
  facts: Facts;
  readonly events: Event[] = [];
  readonly trace: unknown[] = [];
  seats: HostSeat[] = [];
  observedAt = 100;
  constructor(readonly name: string, entries: readonly Entry[] = [entry(1, true)], parent: IssueRef | null = null, amendSource: (facts: Facts) => Facts = facts => facts, private readonly sink: TraceSink = () => {}) {
    this.facts = amendSource(sourceFacts(entries, parent));
    const request: ConveneInput = { op: 'convene', mode: 'execute', parent, entries: [...entries] };
    const created = createAgenda(request, this.facts, 100, '00000000-0000-4000-8000-000000000186');
    if (!created.ok) throw new Error(created.error.message);
    assert.equal(created.ok, true, `${name}: createAgenda must accept complete source: ${JSON.stringify(created)}`);
    this.state = created.value;
    this.record('convene', request, { kind: 'created', version: this.state.version });
    this.observe();
  }
  inputs(): Inputs {
    return { facts: { kind: 'available', generation: 1, observedAt: this.observedAt, facts: this.facts, scope: { issues: this.facts.issues.map(value => value.ref), prs: this.facts.prs.map(value => value.ref), repos: this.facts.repos.map(value => ({ repo: value.repo, bases: value.bases.map(base => base.name) })), branches: this.facts.branches.map(value => ({ repo: value.repo, name: value.name })), commits: this.facts.commits.map(({ repo: value, ancestor, descendant }) => ({ repo: value, ancestor, descendant })), checkRuns: this.facts.checkAttempts.map(value => ({ repo: value.repo, runId: value.workflowRunId })), creations: [] } }, host: { runId: main.runId, main, seats: this.seats, turnEnds: [], preflight: { ok: true, value: { asyncEnabled: true, isolationEnabled: true, asyncManager: true, gitCwd: '/tmp/roundtable-independent-fixture', agents: [{ name: 'task:free', blocking: false }] } } }, policy: { text: 'Independent acceptance: preserve all obligations; implement and verify real behavior.', ownerAgent: 'task:free', gateAgent: 'task:free' } };
  }
  record(operation: string, input: unknown, result: unknown): void {
    const record = {
      scene: this.name, operation, input, result, version: this.state.version,
      source: {
        issues: this.facts.issues.map(value => ({ ref: value.ref, state: value.state, bodyHash: value.bodyHash, lastClose: value.lastClose, lastReopen: value.lastReopen, children: value.children })),
        prs: this.facts.prs.map(value => ({ ref: value.ref, head: value.head, branch: value.headBranch, target: value.target, bodyHash: value.bodyHash, state: value.state, mergeable: value.mergeable, checks: value.checks })),
        branches: this.facts.branches, commits: this.facts.commits,
      },
      stableWork: this.state.units.flatMap(unit => unit.members.flatMap(member => member.work ? [{ member: member.ref, id: member.work.id, revision: member.work.contentVersion, holds: member.work.holds }] : [])),
      open: {
        cases: this.state.cases.filter(value => value.state.kind !== 'resolved' && value.state.kind !== 'cancelled').map(value => ({ id: value.id, subject: value.subject.kind, revision: value.contentVersion, state: value.state })),
        designs: this.state.designWorks.filter(value => value.result === null).map(value => ({ id: value.id, parent: value.parentCaseId, holds: value.holds })),
        drafts: this.state.drafts.map(value => ({ id: value.id, state: value.state })),
        gates: this.gates().map(value => ({ id: value.id, kind: value.kind, status: value.status })),
      },
      effects: this.state.effects.map(value => ({ id: value.id, action: value.action.kind, attempt: value.attempt, state: value.state })),
    };
    this.trace.push(record); this.sink(record);
  }
  send(event: Event): Transition {
    const before = JSON.stringify(this.state);
    const version = this.state.version;
    const result = transition(this.state, this.inputs(), event);
    assert.equal(JSON.stringify(this.state), before, `${this.name}: transition mutates its input`);
    if (result.kind === 'next') {
      assert.equal(result.state.version, version + 1, `${this.name}: next must increment version exactly once`);
      const parsed = parseAgenda(result.state);
      assert.equal(parsed.ok, true, `${this.name}: every emitted Agenda must parse: ${JSON.stringify(parsed)}`);
      this.state = result.state;
    }
    this.events.push(event);
    this.record(event.kind, event, result.kind === 'rejected' ? { kind: result.kind, error: result.error } : { kind: result.kind, reply: result.reply });
    return result;
  }
  accept(event: Event): Transition {
    const result = this.send(event);
    assert.notEqual(result.kind, 'rejected', `${this.name}: expected accepted event: ${JSON.stringify(result)}`);
    return result;
  }
  observe(): void {
    for (let turns = 0; turns < 100; turns++) {
      const result = this.accept({ kind: 'observe' });
      if (result.kind === 'same') return;
    }
    assert.fail(`${this.name}: observe did not converge; shortest recorded sequence is in trace`);
  }
  member(ref: IssueRef = issue(1)): Member {
    const member = this.state.units.flatMap(unit => unit.members).find(value => equalRef(value.ref, ref));
    assert.ok(member, `${this.name}: member ${JSON.stringify(ref)} missing`); return member;
  }
  work(ref: IssueRef = issue(1)): OwnerWork { const work = this.member(ref).work; assert.ok(work, `${this.name}: owner obligation disappeared`); return work; }
  gates(): GateJob[] { return [...this.state.units.flatMap(unit => [...unit.members.flatMap(member => [member.review, member.accept]), unit.postMerge]), this.state.closure].filter((value): value is GateJob => value !== null); }
  gate(kind: GateKind, ref?: IssueRef): GateJob {
    const gate = this.gates().find(value => value.kind === kind && value.status.kind === 'requested' && (!ref || value.context.kind === 'member' && equalRef(value.context.member, ref)));
    assert.ok(gate, `${this.name}: expected requested ${kind} gate`); return gate;
  }
  ticket(id: string): Ticket { const ticket = tickets(this.state, this.inputs()).find(value => value.id === id); assert.ok(ticket, `${this.name}: missing ticket ${id}`); return ticket; }
  case(subject: DecisionCase['subject']['kind'] = 'claim'): DecisionCase { const item = this.state.cases.find(value => value.subject.kind === subject && value.state.kind === 'open'); assert.ok(item, `${this.name}: missing open ${subject} case`); return item; }
  bind(requestId: string): Caller {
    const request = this.state.requests.find(value => value.id === requestId); assert.ok(request, 'Expected public seat request');
    if (request.binding.kind === 'bound') return { agentId: request.binding.agentId, sessionId: request.binding.sessionId, parentId: request.binding.parentId, runId: main.runId, kind: 'sub', depth: 1 };
    const id = `Seat${this.seats.length + 1}`;
    this.seats.push({ agentId: id, requestedName: request.name, parentId: main.agentId, sessionId: `${id}-session`, createdAt: 200 + this.seats.length, status: 'running', plan: 'disabled', streaming: false });
    const spawn = this.ticket(`spawn:${requestId}`);
    this.reply(spawn, { kind: 'spawned', agentId: id }, main);
    return { agentId: id, sessionId: `${id}-session`, parentId: main.agentId, runId: main.runId, kind: 'sub', depth: 1 };
  }
  caller(ticket: Ticket): Caller { return ticket.holder.kind === 'main' ? main : this.bind(ticket.holder.requestId); }
  reply(ticket: Ticket, payload: ProtocolReply, caller = this.caller(ticket)): Transition {
    const event: Event = { kind: 'reply', caller, ticket: ticket.id, revision: ticket.revision, payload, acceptedAt: 300 };
    return this.accept(event);
  }
  reject(ticket: Ticket, payload: ProtocolReply, error: string, caller = this.caller(ticket)): void {
    const result = this.send({ kind: 'reply', caller, ticket: ticket.id, revision: ticket.revision, payload, acceptedAt: 300 });
    assert.equal(result.kind, 'rejected', `${this.name}: expected ${error}`);
    if (result.kind === 'rejected') assert.equal(result.error.kind, error);
  }
  decide(item: DecisionCase, decision: CaseDecision): void { this.reply(this.ticket(`case:${item.id}`), { kind: 'decision', decision }, main); this.observe(); }
  push(head: string, ref: IssueRef = issue(1)): void {
    const member = this.member(ref); const pr = this.facts.prs.find(value => member.binding.kind === 'registered' && equalRef(value.ref, member.binding.pr)); assert.ok(pr, 'Push requires registered PR');
    this.facts = { ...this.facts, prs: this.facts.prs.map(value => equalRef(value.ref, pr.ref) ? { ...value, head, updatedAt: value.updatedAt + 1 } : value), branches: this.facts.branches.map(value => value.name === pr.headBranch && value.repo.owner === pr.headRepo.owner && value.repo.name === pr.headRepo.name ? { ...value, state: { kind: 'present', head } } : value) };
    this.observe();
  }
  submit(ref: IssueRef = issue(1), head = h2): PrSubmit {
    const member = this.member(ref);
    const binding = member.binding;
    const registered = binding.kind === 'registered' ? this.facts.prs.find(value => equalRef(value.ref, binding.pr)) : undefined;
    return { kind: 'submit', branch: registered?.headBranch ?? `deliver-${ref.number}`, head, title: `Deliver ${ref.number}`, body: `## Implementation\nReal implementation.\n\n## Checks\nIndependent validation.\n\nCloses ${ref.repo.owner}/${ref.repo.name}#${ref.number}`, template: member.designOnly ? 'docOnly' : 'fourLayer', retryNote: 'Independent evidence for this accepted repair.' };
  }
  addBranch(name: string, head: string, inRepo: Repo = repo): void { this.facts = { ...this.facts, branches: [...this.facts.branches.filter(value => !(value.repo.owner === inRepo.owner && value.repo.name === inRepo.name && value.name === name)), { repo: inRepo, name, state: { kind: 'present', head } }] }; }
  start(effect: Effect): void {
    assert.equal(effect.state.kind, 'ready', 'Only an actual ready effect can begin a call');
    this.accept({ kind: 'effectStarted', id: effect.id, attempt: effect.attempt + 1, startedAt: 400 });
  }
  confirm(effect: Effect, result: EffectResult): void {
    const executing = this.state.effects.find(current => current.id === effect.id);
    assert.equal(executing?.state.kind, 'executing', 'The call must start before the simulated source mutation');
    assert.ok(executing);
    this.accept({ kind: 'effectConfirmed', id: effect.id, attempt: executing.attempt, result });
    this.observe();
  }
  ready(kind: Effect['action']['kind']): Effect { const effect = this.state.effects.find(value => value.action.kind === kind && value.state.kind === 'ready'); assert.ok(effect, `${this.name}: missing ready ${kind} effect`); return effect; }
  publish(ref: IssueRef = issue(1)): void {
    const effect = this.ready('publishPr'); assert.equal(effect.action.kind, 'publishPr'); if (effect.action.kind !== 'publishPr') return;
    const action = effect.action; assert.ok(equalRef(action.member, ref));
    const prRef = action.pr ?? issue(ref.number + 100, ref.repo);
    const pr: PrSnapshot = { ref: prRef, headRepo: action.headRepo, headBranch: action.submission.payload.branch, head: action.submission.payload.head, target: action.target, title: action.submission.payload.title, body: action.body, bodyHash: hash(action.body), updatedAt: 400, state: { kind: 'open' }, closes: [ref], mergeable: 'yes', checks: { kind: 'passing', required: [checkIdentity] } };
    this.start(effect);
    this.facts = { ...this.facts, prs: [...this.facts.prs.filter(value => !equalRef(value.ref, prRef)), pr], links: [...this.facts.links.filter(value => !equalRef(value.pr, prRef)), { issue: ref, pr: prRef }], maintenance: [...this.facts.maintenance.filter(value => !equalRef(value.pr, prRef)), { pr: prRef, result: { kind: 'maintainable', basis: { headRepo: pr.headRepo, headBranch: pr.headBranch, viewerPermission: 'ADMIN', author: 'Verifier', maintainerCanModify: true, authorization: { kind: 'actorIsAuthor', actor: 'Verifier' } } } }] };
    this.confirm(effect, { kind: 'published', pr: prRef });
  }
  verdict(kind: GateKind, ok = true, ref?: IssueRef): GateJob { const gate = this.gate(kind, ref); this.reply(this.ticket(`gate:${gate.id}`), { kind: 'verdict', ok, note: ok ? 'Independent exact-scope verification passed.' : 'Concrete implementation fails the agreed requirement.' }); this.observe(); return gate; }
  patchIssue(ref: IssueRef, patch: Partial<Omit<IssueSnapshot, 'ref'>>): void { this.facts = { ...this.facts, issues: this.facts.issues.map(value => equalRef(value.ref, ref) ? { ...value, ...patch } : value) }; }
  closeEffects(): void {
    for (const effect of this.state.effects.filter(value => value.action.kind === 'setIssueState' && value.state.kind === 'ready')) {
      if (effect.action.kind !== 'setIssueState') continue;
      const action = effect.action; const event = { id: `source-${effect.id}`, at: 500 };
      this.start(effect);
      this.patchIssue(action.issue, action.open ? { state: 'open', lastReopen: event } : { state: 'closed', lastClose: event });
      this.confirm(effect, { kind: 'issueState', issue: action.issue, open: action.open, event });
    }
  }
  noMerge(): void { assert.ok(!this.state.effects.some(value => value.action.kind === 'merge' && (value.state.kind === 'ready' || value.state.kind === 'executing')), `${this.name}: unresolved obligations must forbid merge`); }
  noGates(ref: IssueRef = issue(1)): void {
    const exposed = tickets(this.state, this.inputs()).filter(ticket => ticket.id.startsWith('gate:') && ticket.context.kind === 'member' && equalRef(ticket.context.member, ref));
    assert.equal(exposed.length, 0, `${this.name}: unresolved work or materialization must not expose member gate tickets`);
    this.noMerge();
  }
}

export type PublicScene = { name: string; run: (sink?: TraceSink) => void };
const repairScene = (cause: 'conflict' | 'checks'): PublicScene => ({ name: `adopted-${cause}-push-submit-replay`, run(sink) {
  const scene = new Scene(`adopted-${cause}`, [entry(1, true)], null, facts => ({ ...facts, prs: facts.prs.map(pr => cause === 'conflict' ? { ...pr, mergeable: 'no' } : { ...pr, checks: { kind: 'failing', required: [checkFailure] } }) }), sink);
  assert.equal(scene.member().baseline.kind, 'adopted');
  const work = scene.work(); const original = { id: work.id, revision: work.contentVersion };
  scene.push(h2);
  scene.facts = { ...scene.facts, prs: scene.facts.prs.map(pr => ({ ...pr, checks: { kind: 'passing', required: [checkIdentity] }, mergeable: 'yes' })) };
  scene.observe(); assert.equal(scene.work().id, original.id); assert.equal(scene.work().contentVersion, original.revision); scene.noGates();
  const ticket = scene.ticket(`work:${work.id}`); const owner = scene.caller(ticket);
  scene.reject(ticket, scene.submit(issue(1), h1), 'premiseChanged', owner);
  const payload = scene.submit(); const accepted = scene.reply(ticket, payload, owner);
  assert.ok(accepted.kind === 'next' && accepted.reply?.outcome === 'accepted');
  assert.equal(scene.member().work, null); assert.equal(scene.member().baseline.kind, 'submitted'); scene.noGates();
  scene.ready('publishPr');
  const unavailable = scene.inputs(); unavailable.facts = { kind: 'unavailable', error: { kind: 'unavailable', message: 'Source deliberately unavailable during exact receipt replay.' } };
  const before = JSON.stringify(scene.state);
  const replay = transition(scene.state, unavailable, { kind: 'reply', caller: owner, ticket: ticket.id, revision: ticket.revision, payload, acceptedAt: 301 });
  assert.equal(replay.kind, 'same'); assert.deepEqual(replay.reply, accepted.reply);
  assert.equal(JSON.stringify(scene.state), before);
  scene.record('receipt-replay-source-unavailable', { ticket: ticket.id, revision: ticket.revision }, replay);
  scene.reject(ticket, { ...payload, title: 'Conflicting terminal payload' }, 'replyConflict', owner);
  scene.publish(); scene.gate('review'); scene.gate('accept');
} });

const claimScene = (claim: Claim): PublicScene => ({ name: `owner-${claim.kind}-hold-resume`, run(sink) {
  const scene = new Scene(`owner-${claim.kind}`, [entry(1)], null, facts => facts, sink);
  const work = scene.work(); const ticket = scene.ticket(`work:${work.id}`); const owner = scene.caller(ticket);
  const payload: ProtocolReply = { kind: 'claim', claim };
  scene.reply(ticket, payload, owner);
  const item = scene.case(); assert.equal(scene.work().id, work.id); assert.equal(scene.ticket(ticket.id).runDisposition, 'mayWait');
  assert.ok(scene.work().holds.some(hold => hold.kind === 'case' && hold.caseId === item.id));
  const repeated = scene.reply(ticket, payload, owner); assert.equal(repeated.kind, 'same');
  scene.reject(ticket, { kind: 'claim', claim: { kind: 'blocked', category: 'different claim', attempts: 'A distinct pending claim must not overwrite the first.' } }, 'pendingClaim', owner);
  for (let index = 0; index < 3; index++) {
    scene.seats = scene.seats.map(seat => ({ ...seat, status: 'parked' })); scene.observedAt++;
    scene.observe();
    assert.ok(!scene.state.effects.some(effect => effect.action.kind === 'wake' && effect.action.ticket === ticket.id && effect.state.kind === 'ready'), 'Held work must not wake on repeated parked observations');
  }
  scene.addBranch(`deliver-1`, h2);
  const decision: CaseDecision = claim.kind === 'question' ? { kind: 'answer', basis: 'Use the original concrete requirement; this explicitly answers the ambiguity.' } : { kind: 'refute', basis: 'Source and agreed contract require this implementation; claim is refuted.' };
  scene.decide(item, decision);
  assert.equal(scene.work().id, work.id); assert.equal(scene.work().contentVersion, work.contentVersion + 1);
  const resumed = scene.ticket(ticket.id); assert.equal(resumed.runDisposition, 'mustRun'); assert.match(resumed.brief, /answer|refut|original concrete|Source and agreed/i);
  const wakes = scene.state.effects.filter(effect => effect.action.kind === 'wake' && effect.action.ticket === ticket.id && effect.action.revision === resumed.revision && effect.state.kind === 'ready');
  assert.equal(wakes.length, 1, 'Last hold release creates exactly one delivery for the new content version');
  scene.observe(); assert.equal(scene.state.effects.filter(effect => effect.action.kind === 'wake' && effect.action.ticket === ticket.id && effect.action.revision === resumed.revision).length, 1);
  scene.reject(ticket, scene.submit(), 'staleRevision', owner);
} });

export const publicScenes: readonly PublicScene[] = [
  repairScene('conflict'), repairScene('checks'),
  { name: 'submitted-pr-same-head-evidence-repair', run(sink) {
    const scene = new Scene('same-head-repair', [entry(1)], null, facts => facts, sink);
    const initial = scene.work(); scene.addBranch('deliver-1', h1);
    scene.reply(scene.ticket(`work:${initial.id}`), scene.submit(issue(1), h1)); scene.publish();
    scene.verdict('review', false);
    scene.decide(scene.case('findings'), { kind: 'upholdOwner', basis: 'Evidence is missing although code at this head is correct.' });
    const repair = scene.work(); assert.notEqual(repair.id, initial.id);
    const payload = { ...scene.submit(issue(1), h1), body: `${scene.submit(issue(1), h1).body}\n\nAdditional exact-head runtime evidence.` };
    scene.reply(scene.ticket(`work:${repair.id}`), payload);
    const baseline = scene.member().baseline;
    assert.ok(baseline.kind === 'submitted' && baseline.submission.workId === repair.id && baseline.submission.payload.head === h1);
    scene.noGates(); scene.publish(); scene.gate('review');
  } },
  { name: 'source-push-supersedes-gates-without-accepting-new-head', run(sink) {
    const scene = new Scene('push-invalidates-gates', [entry(1, true)], null, facts => facts, sink);
    const old = scene.gate('accept'); const ticket = scene.ticket(`gate:${old.id}`); const holder = scene.caller(ticket);
    scene.push(h2); const work = scene.work();
    const baseline = scene.member().baseline;
    assert.ok(baseline.kind === 'adopted' && baseline.acceptedHead === h1);
    assert.ok(work.reasons.some(reason => reason.kind === 'unsubmittedPush' && reason.acceptedHead === h1));
    scene.noGates(); scene.reject(ticket, { kind: 'verdict', ok: true, note: 'Late verdict for old source head.' }, 'superseded', holder);
  } },
  { name: 'reject-finding-requires-fresh-gate-not-fabricated-pass', run(sink) {
    const scene = new Scene('reject-finding', [entry(1, true)], null, facts => facts, sink);
    const old = scene.verdict('review', false);
    scene.decide(scene.case('findings'), { kind: 'reject', basis: 'Concrete source disproves this finding; independently review the remaining contract.' });
    const fresh = scene.gate('review'); assert.notEqual(fresh.id, old.id); assert.equal(fresh.status.kind, 'requested');
    assert.ok(fresh.stamp.kind === 'review' && fresh.stamp.rulings.some(ruling => ruling.kind === 'findingRejected'));
    scene.noMerge();
  } },
  { name: 'owner-no-code-confirmation-requires-current-body', run(sink) {
    const scene = new Scene('claim-no-code-confirm', [entry(1)], null, facts => facts, sink);
    const work = scene.work(); scene.reply(scene.ticket(`work:${work.id}`), { kind: 'claim', claim: { kind: 'noCode', evidence: 'Existing implementation and runtime output satisfy every expectation.' } });
    const item = scene.case(); const ticket = scene.ticket(`case:${item.id}`);
    scene.reject(ticket, { kind: 'decision', decision: { kind: 'confirmNoCode', bodyHash: hash('not the current source body'), reason: 'Stale body must not be accepted.' } }, 'premiseChanged', main);
    assert.equal(scene.work().id, work.id);
    scene.decide(item, { kind: 'confirmNoCode', bodyHash: scene.member().contract.bodyHash, reason: 'Verified complete current contract against source/runtime evidence.' });
    assert.equal(scene.member().work, null); assert.equal(scene.member().terminal.kind, 'noCode'); assert.equal(scene.member().ownerTerminal?.kind, 'noCode');
    scene.closeEffects(); scene.gate('postMerge');
  } },
  ...([
    { kind: 'question', reproduction: 'One observed behavior permits two readings.', readings: ['Return exact result.', 'Return aggregate result.'], earliestGap: 'Result shape is ambiguous.', proposal: 'Choose exact result.' },
    { kind: 'noCode', evidence: 'Claimed pre-existing behavior needs Main classification.' },
    { kind: 'split', proposal: 'Claimed separate concern needs explicit Main classification.' },
    { kind: 'blocked', category: 'external source', attempts: 'Queried remote and captured unavailable dependency.' },
  ] satisfies Claim[]).map(claimScene),
  { name: 'immutable-observe-read-projections-and-parsers', run(sink) {
    const scene = new Scene('immutable-observe', [entry(1, true)], null, facts => facts, sink);
    scene.bind(scene.gate('review').requestId); scene.bind(scene.gate('accept').requestId); scene.observe();
    const before = JSON.stringify(scene.state); scene.observedAt = 999_999;
    const unchanged = scene.send({ kind: 'observe' }); assert.equal(unchanged.kind, 'same');
    tickets(scene.state, scene.inputs()); tickets(scene.state, scene.inputs());
    assert.equal(JSON.stringify(scene.state), before);
    assert.equal(parseAgenda(JSON.parse(before)).ok, true);
    assert.equal(parsePortInput({ op: 'reply', ticket: 'gate:public', revision: 1, reply: { kind: 'verdict', ok: true, note: 'Exact contract', head: h1 } }).ok, false, 'Gate payload must reject model-authored source pins');
    assert.equal(parsePortInput({ op: 'resume', agenda: scene.state.id, operatorConfirmedOriginalSessionEnded: false }).ok, false);
    assert.equal(parseAgenda({ ...scene.state, nextId: 1 }).ok, false);
  } },
  { name: 'fresh-gate-after-question-preserves-main-answer', run(sink) {
    const scene = new Scene('fresh-gate-question', [entry(1, true)], null, facts => facts, sink);
    const gate = scene.gate('review'); const ticket = scene.ticket(`gate:${gate.id}`); const reviewer = scene.caller(ticket);
    scene.reply(ticket, { kind: 'claim', claim: { kind: 'question', reproduction: 'Review requires a precise boundary.', readings: ['Inside contract', 'Outside contract'], earliestGap: 'Boundary text', proposal: 'Classify outside domain.' } }, reviewer);
    assert.equal(scene.member().review?.status.kind, 'cancelled');
    const answer = 'This exact boundary is outside the component domain; do not repeatedly require it.';
    scene.decide(scene.case(), { kind: 'outOfDomain', basis: answer });
    const fresh = scene.gate('review'); assert.notEqual(fresh.id, gate.id); assert.notEqual(fresh.requestId, gate.requestId);
    assert.ok(fresh.stamp.kind === 'review' && fresh.stamp.rulings.some(ruling => ruling.kind === 'questionAnswered' && ruling.basis === answer && ruling.classification === 'outOfDomain'));
    assert.ok(scene.ticket(`gate:${fresh.id}`).brief.includes(answer));
    scene.reject(ticket, { kind: 'verdict', ok: true, note: 'Late old reviewer response.' }, 'superseded', reviewer);
  } },
  { name: 'body-only-invalidates-review-not-accept', run(sink) {
    const scene = new Scene('body-only', [entry(1, true)], null, facts => facts, sink);
    const review = scene.gate('review'); const accept = scene.gate('accept'); const caller = scene.caller(scene.ticket(`gate:${review.id}`));
    scene.facts = { ...scene.facts, prs: scene.facts.prs.map(pr => ({ ...pr, body: `${pr.body}\nHuman evidence`, bodyHash: hash(`${pr.body}\nHuman evidence`) })) }; scene.observe();
    assert.notEqual(scene.gate('review').id, review.id); assert.equal(scene.gate('accept').id, accept.id);
    assert.ok(!scene.state.effects.some(effect => effect.action.kind === 'publishPr' && effect.state.kind === 'ready'), 'Human body-only edit must not be overwritten without a new submit');
    scene.reject({ ...scene.ticket(`gate:${scene.gate('review').id}`), id: `gate:${review.id}` }, { kind: 'verdict', ok: true, note: 'Stale body review.' }, 'superseded', caller);
  } },
  { name: 'not-ok-uphold-owner-push-does-not-discharge-work', run(sink) {
    const scene = new Scene('uphold-owner', [entry(1, true)], null, facts => facts, sink);
    scene.verdict('review', false); const finding = scene.case('findings');
    scene.decide(finding, { kind: 'upholdOwner', basis: 'Implementation misses the exact required result.' });
    const work = scene.work(); scene.push(h2);
    assert.equal(scene.work().id, work.id); assert.equal(scene.work().contentVersion, work.contentVersion); scene.noGates();
    scene.push(h1); assert.equal(scene.work().id, work.id, 'Returning to accepted head does not silently complete an open repair');
  } },
  { name: 'design-applying-body-confirmation-missing-and-qualified-commit', run(sink) {
    const scene = new Scene('design-applying', [entry(1, true), entry(2, false, otherRepo)], null, facts => facts, sink);
    scene.verdict('review', false); const finding = scene.case('findings');
    const originalBody = scene.facts.issues[0]; assert.ok(originalBody);
    const targetBody = `${originalBody.body}\nDesign requires an exact typed result.`;
    scene.decide(finding, { kind: 'amend', amendment: { kind: 'designGap', affected: [issue(1)], bodyEdits: [{ issue: issue(1), expectedHash: originalBody.bodyHash, body: targetBody }], route: { kind: 'withPr', member: issue(1) } } });
    const applying = scene.state.cases.find(value => value.id === finding.id); assert.equal(applying?.state.kind, 'applying');
    assert.ok(applying?.state.kind === 'applying' && applying.state.required.length === 1 && applying.state.required[0]?.kind === 'amendment', 'Applying case names only its direct Amendment child');
    assert.ok(!tickets(scene.state, scene.inputs()).some(ticket => ticket.id === `case:${finding.id}`), 'Applying decision cannot be overwritten through a new case reply');
    const design = scene.state.designWorks.find(value => value.parentCaseId === finding.id); assert.ok(design);
    const heldWork = scene.work(); const heldOwner = scene.caller(scene.ticket(`work:${heldWork.id}`));
    scene.seats = scene.seats.map(seat => seat.agentId === heldOwner.agentId ? { ...seat, status: 'parked' } : seat);
    assert.ok(!design.holds.some(hold => hold.kind === 'case' && hold.caseId === finding.id), 'Design must not wait on its applying parent');
    scene.facts = { ...scene.facts, commits: [{ repo: otherRepo, ancestor: designHead, descendant: designHead, result: 'contains' }] };
    scene.reject(scene.ticket(`work:${design.id}`), { kind: 'designCommit', commit: { repo, sha: designHead } }, 'missingDesignCommit', main);
    scene.facts = { ...scene.facts, commits: [...scene.facts.commits, { repo, ancestor: designHead, descendant: designHead, result: 'contains' }] };
    scene.reply(scene.ticket(`work:${design.id}`), { kind: 'designCommit', commit: { repo, sha: designHead } }, main); scene.observe();
    assert.equal(scene.state.cases.find(value => value.id === finding.id)?.state.kind, 'applying', 'Design success alone cannot hide pending body publication');
    assert.equal(scene.member().contract.bodyHash, originalBody.bodyHash);
    const bodyEffect = scene.ready('replaceBody'); scene.start(bodyEffect); scene.patchIssue(issue(1), { body: targetBody, bodyHash: hash(targetBody), updatedAt: 500 });
    scene.confirm(bodyEffect, { kind: 'bodyReplaced', issue: issue(1), hash: hash(targetBody) });
    assert.equal(scene.state.cases.find(value => value.id === finding.id)?.state.kind, 'resolved');
    assert.equal(scene.member().contract.revision, 2); assert.ok(scene.work().required.some(commit => commit.sha === designHead && commit.repo.name === repo.name));
    assert.equal(scene.work().id, heldWork.id, 'Applying design never replaces the original owner obligation');
    assert.equal(scene.state.effects.filter(effect => effect.action.kind === 'wake' && effect.action.ticket === `work:${heldWork.id}` && effect.action.revision === scene.work().contentVersion).length, 1, 'Effective design/body amendment resumes the parked owner once without Main retryHost');
    assert.equal(scene.member(issue(2, otherRepo)).contract.requirements.length, 0, 'Identical SHA in a different repo never inherits design responsibility');
    const work = scene.work(); scene.push(h2); assert.equal(scene.work().id, work.id); scene.noGates();
    const ticket = scene.ticket(`work:${work.id}`); const owner = scene.caller(ticket);
    scene.facts = { ...scene.facts, commits: [...scene.facts.commits, { repo, ancestor: designHead, descendant: h2, result: 'notContained' }] };
    scene.reject(ticket, scene.submit(), 'missingDesignCommit', owner);
    scene.facts = { ...scene.facts, commits: scene.facts.commits.map(value => value.repo.name === repo.name && value.ancestor === designHead && value.descendant === h2 ? { ...value, result: 'contains' } : value) };
    scene.reply(ticket, scene.submit(), owner); scene.noGates(); scene.publish();
  } },
  { name: 'uphold-main-design-survives-pr-close', run(sink) {
    const scene = new Scene('main-design-close', [entry(1, true)], null, facts => facts, sink);
    scene.verdict('accept', false); const finding = scene.case('findings'); scene.decide(finding, { kind: 'upholdMain', basis: 'Main must supply the missing design contract before owner continues.' });
    const design = scene.state.designWorks.find(value => value.parentCaseId === finding.id); assert.ok(design);
    const work = scene.work(); scene.facts = { ...scene.facts, prs: scene.facts.prs.map(pr => ({ ...pr, state: { kind: 'closed' } })) }; scene.observe();
    assert.equal(scene.work().id, work.id); assert.ok(scene.state.designWorks.some(value => value.id === design.id && value.result === null));
    assert.equal(scene.state.cases.find(value => value.id === finding.id)?.state.kind, 'applying');
    assert.ok(tickets(scene.state, scene.inputs()).some(ticket => ticket.id === `work:${design.id}`)); scene.noMerge();
  } },
  ...(['noCode', 'split', 'blocked'] as const).map((kind): PublicScene => ({ name: `gate-${kind}-claim-fresh-holder`, run(sink) {
    const scene = new Scene(`gate-${kind}`, [entry(1, true)], null, facts => facts, sink);
    const old = scene.gate('accept'); const ticket = scene.ticket(`gate:${old.id}`); const holder = scene.caller(ticket);
    const claim: Claim = kind === 'noCode' ? { kind, evidence: 'Gate raises a noCode claim requiring classification.' } : kind === 'split' ? { kind, proposal: 'Gate proposes a scope split requiring classification.' } : { kind, category: 'source', attempts: 'Gate observed a possible external blocker.' };
    scene.reply(ticket, { kind: 'claim', claim }, holder);
    scene.decide(scene.case(), { kind: 'refute', basis: 'Concrete source and contract refute this claim; independently re-evaluate the whole gate.' });
    const fresh = scene.gate('accept'); assert.notEqual(fresh.id, old.id); assert.notEqual(fresh.requestId, old.requestId);
    const freshHolder = scene.bind(fresh.requestId); assert.notEqual(freshHolder.agentId, holder.agentId);
    scene.reject(ticket, { kind: 'verdict', ok: true, note: 'Old holder is superseded.' }, 'superseded', holder);
  } })),
  { name: 'main-release-wait-remains-explicitly-releasable', run(sink) {
    const scene = new Scene('main-release', [entry(1)], null, facts => facts, sink);
    const work = scene.work(); scene.reply(scene.ticket(`work:${work.id}`), { kind: 'claim', claim: { kind: 'blocked', category: 'external authorization', attempts: 'No machine-readable resolution exists.' } });
    scene.decide(scene.case(), { kind: 'waitExternal', condition: { kind: 'mainRelease', reason: 'Main must explicitly revisit the evidence.' }, reason: 'Preserve a visible, revisable wait.' });
    const item = scene.state.cases.find(value => value.state.kind === 'awaitingExternal'); assert.ok(item);
    const ticket = scene.ticket(`case:${item.id}`); assert.equal(ticket.runDisposition, 'mayWait');
    scene.observedAt += 1_000_000; scene.observe();
    assert.equal(scene.state.cases.find(value => value.id === item.id)?.state.kind, 'awaitingExternal', 'Elapsed observation time never authorizes a retry');
    scene.reply(ticket, { kind: 'decision', decision: { kind: 'refute', basis: 'Main explicitly releases the wait after reviewing the external source.' } }, main); scene.observe();
    assert.equal(scene.work().id, work.id); assert.equal(scene.ticket(`work:${work.id}`).runDisposition, 'mustRun');
  } },
  { name: 'applying-draft-create-and-attach-have-distinct-confirmations', run(sink) {
    const parent = issue(99); const scene = new Scene('draft-applying', [entry(1, true)], parent, facts => facts, sink);
    scene.verdict('review', false); const finding = scene.case('findings');
    const spec = { repo, title: 'Independent out-of-scope concern', body: 'Preserve the discovered obligation without claiming it is repaired.', target: { repo, base: 'main' }, designOnly: false };
    scene.decide(finding, { kind: 'outOfScope', draft: spec });
    const draft = scene.state.drafts.find(value => value.caseId === finding.id); assert.ok(draft); assert.equal(draft.state.kind, 'proposed');
    assert.equal(scene.state.cases.find(value => value.id === finding.id)?.state.kind, 'applying');
    const create = scene.ready('createIssue'); assert.equal(create.action.kind, 'createIssue'); if (create.action.kind !== 'createIssue') return;
    const created = issue(4);
    scene.start(create);
    scene.facts = { ...scene.facts, issues: [...scene.facts.issues, { ...sourceIssue(created), body: spec.body, bodyHash: hash(spec.body) }], createdIssues: [{ issue: created, title: spec.title, body: spec.body, actor: create.action.actor, createdAt: 400 }] };
    scene.confirm(create, { kind: 'created', issue: created });
    const attachment = scene.state.effects.find(value => value.action.kind === 'attachChild' && value.state.kind === 'ready');
    assert.ok(attachment, 'Required parent attachment is an independent durable intention');
    assert.equal(scene.state.cases.find(value => value.id === finding.id)?.state.kind, 'applying', 'Creating the issue does not confirm parent attachment');
    if (attachment.action.kind !== 'attachChild') throw new Error('Expected exact attachChild action');
    const action = attachment.action; assert.ok(action.owner.kind === 'draft' && action.owner.draftId === draft.id, 'Attachment ownership must remain tied to the accepted draft'); const sourceParent = scene.facts.issues.find(value => equalRef(value.ref, action.parent)); assert.ok(sourceParent);
    scene.start(attachment);
    scene.patchIssue(action.parent, { children: [...sourceParent.children, action.child] });
    scene.confirm(attachment, { kind: 'attached', parent: action.parent, child: action.child });
    assert.equal(scene.state.cases.find(value => value.id === finding.id)?.state.kind, 'resolved');
    assert.ok(!scene.state.units.flatMap(unit => unit.members).some(member => equalRef(member.ref, created)), 'An outsideAgenda issue is not silently an agenda member');
    const fresh = scene.gate('review'); assert.notEqual(fresh.id, finding.subject.kind === 'findings' ? finding.subject.jobId : '');
  } },
  { name: 'external-wait-revision-reopens-without-authorizing-write', run(sink) {
    const scene = new Scene('external-wait', [entry(1)], null, facts => facts, sink);
    const work = scene.work(); scene.reply(scene.ticket(`work:${work.id}`), { kind: 'claim', claim: { kind: 'blocked', category: 'source', attempts: 'Need issue source update.' } });
    const item = scene.case(); const oldTicket = scene.ticket(`case:${item.id}`);
    const waitDecision: CaseDecision = { kind: 'waitExternal', condition: { kind: 'bodyChanged', issue: issue(1), fromHash: scene.member().contract.bodyHash }, reason: 'Wait for a source-confirmed contract correction.' };
    scene.decide(item, waitDecision);
    const waiting = scene.state.cases.find(value => value.id === item.id); assert.ok(waiting); assert.equal(waiting.state.kind, 'awaitingExternal'); assert.equal(waiting.contentVersion, item.contentVersion + 1);
    const body = `${scene.member().contract.body}\nSource clarification.`; scene.patchIssue(issue(1), { body, bodyHash: hash(body), updatedAt: 600 }); scene.observe();
    const reopened = scene.state.cases.find(value => value.id === item.id); assert.equal(reopened?.state.kind, 'open'); assert.equal(reopened?.contentVersion, item.contentVersion + 2);
    const unchanged = JSON.stringify(scene.state); const unchangedVersion = scene.state.version;
    scene.reject(oldTicket, { kind: 'decision', decision: { kind: 'refute', basis: 'Old accepted revision cannot replace its retained terminal receipt.' } }, 'replyConflict', main);
    const replay = scene.reply(oldTicket, { kind: 'decision', decision: waitDecision }, main);
    assert.equal(replay.kind, 'same', 'The exact old wait receipt replays without reversing the reopened state');
    scene.reject({ ...oldTicket, revision: waiting.contentVersion }, { kind: 'decision', decision: { kind: 'refute', basis: 'This unreceipted intermediate revision cannot overwrite the current case.' } }, 'staleRevision', main);
    assert.equal(scene.state.version, unchangedVersion); assert.equal(JSON.stringify(scene.state), unchanged);
    assert.equal(scene.work().id, work.id); assert.equal(scene.ticket(`work:${work.id}`).runDisposition, 'mayWait'); scene.noMerge();
    scene.decide(scene.case(), { kind: 'refute', basis: 'Source now provides the missing information; continue.' });
    assert.equal(scene.ticket(`work:${work.id}`).runDisposition, 'mustRun');
  } },
  { name: 'source-close-preserves-work-external-merge-ends-without-fake-receipt', run(sink) {
    const scene = new Scene('close-external-merge', [entry(1, true)], null, facts => ({ ...facts, prs: facts.prs.map(pr => ({ ...pr, mergeable: 'no' })) }), sink);
    const work = scene.work(); scene.patchIssue(issue(1), { state: 'closed', lastClose: { id: 'human-close', at: 450 } }); scene.observe();
    assert.equal(scene.work().id, work.id); scene.case('closed'); assert.equal(scene.ticket(`work:${work.id}`).runDisposition, 'mayWait');
    const pr = scene.facts.prs[0]; assert.ok(pr);
    scene.facts = { ...scene.facts, prs: scene.facts.prs.map(value => ({ ...value, state: { kind: 'merged', sha: h2, at: 600 } })), repos: scene.facts.repos.map(value => ({ ...value, defaultHead: h2 })), commits: [{ repo, ancestor: h2, descendant: h2, result: 'contains' }] }; scene.observe();
    assert.equal(scene.member().work, null); assert.equal(scene.member().terminal.kind, 'merged'); assert.equal(scene.member().ownerTerminal?.kind, 'externallyMerged'); assert.equal(scene.member().ownerTerminal?.workId, work.id); assert.equal(scene.member().ownerReceipt, null);
    assert.ok(tickets(scene.state, scene.inputs()).some(ticket => ticket.holder.kind === 'main' && /externallyMerged|external.*merg|外部.*合并/i.test(ticket.brief)), 'Main must retain an actionable visibility path to the non-reply external merge result');
    scene.gate('postMerge');
  } },
  { name: 'no-code-reopen-not-automatically-closed', run(sink) {
    const scene = new Scene('no-code-reopen', [entry(1), entry(2)], null, facts => facts, sink);
    assert.equal(scene.member(issue(2)).work, null);
    scene.accept({ kind: 'mainNoCode', caller: main, member: issue(1), bodyHash: scene.member().contract.bodyHash, reason: 'Source evidence proves no implementation is needed.', acceptedAt: 400 }); scene.observe();
    scene.closeEffects(); assert.equal(scene.member().terminal.kind, 'noCode');
    scene.verdict('postMerge'); assert.ok(scene.member(issue(2)).work);
    const laterWork = scene.work(issue(2)); scene.patchIssue(issue(1), { state: 'open', lastReopen: { id: 'human-reopen', at: 700 } }); scene.observe();
    scene.case('reopened'); assert.equal(scene.work(issue(2)).id, laterWork.id); assert.equal(scene.ticket(`work:${laterWork.id}`).runDisposition, 'mayWait');
    assert.ok(!scene.state.effects.some(effect => effect.action.kind === 'setIssueState' && equalRef(effect.action.issue, issue(1)) && !effect.action.open && effect.state.kind === 'ready'), 'Human reopen must not be mechanically closed under the old noCode decision');
  } },
  { name: 'split-predecessor-retains-work-and-resumes-before-unit-postmerge', run(sink) {
    const scene = new Scene('split-predecessor', [entry(1)], null, facts => facts, sink);
    const original = scene.work(); scene.reply(scene.ticket(`work:${original.id}`), { kind: 'claim', claim: { kind: 'split', proposal: 'A concrete prerequisite must precede the remaining implementation.' } });
    const predecessor = entry(3); scene.facts = { ...scene.facts, issues: [...scene.facts.issues, sourceIssue(predecessor.issue)] };
    const body = `${scene.member().contract.body}\nNarrowed after prerequisite.`;
    const unit = scene.state.units[0]; assert.ok(unit);
    scene.decide(scene.case(), { kind: 'split', bodyEdit: { issue: issue(1), expectedHash: scene.member().contract.bodyHash, body }, insertions: [{ kind: 'existing', entry: predecessor, position: { kind: 'before', unitId: unit.id } }] });
    assert.equal(scene.work().id, original.id); assert.equal(scene.ticket(`work:${original.id}`).runDisposition, 'mayWait');
    const effect = scene.ready('replaceBody'); scene.start(effect); scene.patchIssue(issue(1), { body, bodyHash: hash(body) }); scene.confirm(effect, { kind: 'bodyReplaced', issue: issue(1), hash: hash(body) });
    scene.observe();
    assert.ok(scene.work().holds.some(hold => hold.kind === 'dependency' && equalRef(hold.member, issue(3))));
    assert.equal(scene.ticket(`work:${original.id}`).runDisposition, 'mayWait');
    const heldVersion = scene.work().contentVersion;
    scene.seats = scene.seats.map(seat => ({ ...seat, status: 'parked' })); scene.observe();
    assert.ok(!scene.state.effects.some(effect => effect.action.kind === 'wake' && effect.action.ticket === `work:${original.id}` && effect.state.kind === 'ready'));
    scene.accept({ kind: 'mainNoCode', caller: main, member: issue(3), bodyHash: scene.member(issue(3)).contract.bodyHash, reason: 'Independent source proves prerequisite is already satisfied.', acceptedAt: 500 }); scene.observe(); scene.closeEffects();
    assert.equal(scene.work().id, original.id); assert.equal(scene.ticket(`work:${original.id}`).runDisposition, 'mustRun');
    assert.equal(scene.work().contentVersion, heldVersion + 1, 'Releasing the last predecessor hold increments work content once');
    assert.equal(scene.state.effects.filter(effect => effect.action.kind === 'wake' && effect.action.ticket === `work:${original.id}` && effect.action.revision === scene.work().contentVersion).length, 1, 'Predecessor terminal resumes the same parked owner exactly once');
    assert.ok(!scene.state.units[0]?.postMerge || scene.state.units[0].postMerge.status.kind !== 'answered', 'Prerequisite release does not require entire unit acceptance');
  } },
  { name: 'parent-correction-all-members-before-next-unit-and-closure', run(sink) {
    const parent = issue(99); const scene = new Scene('parent-correction', [entry(1), entry(2)], parent, facts => facts, sink);
    scene.accept({ kind: 'mainNoCode', caller: main, member: issue(1), bodyHash: scene.member().contract.bodyHash, reason: 'Initial item is already satisfied.', acceptedAt: 400 }); scene.observe(); scene.closeEffects();
    assert.equal(scene.member(issue(2)).work, null);
    scene.verdict('postMerge', false); const failed = scene.case('postMerge'); const unit = scene.state.units[0]; assert.ok(unit);
    const correction = entry(3); scene.facts = { ...scene.facts, issues: [...scene.facts.issues, sourceIssue(correction.issue)] }; scene.patchIssue(parent, { children: [issue(1), issue(2), issue(3)] });
    scene.decide(failed, { kind: 'correct', insertion: { kind: 'existing', entry: correction, position: { kind: 'correctionOf', unitId: unit.id } } });
    assert.ok(scene.state.units[0]?.members.some(member => equalRef(member.ref, issue(3)))); assert.equal(scene.state.units.length, 2); assert.equal(scene.member(issue(2)).work, null);
    scene.accept({ kind: 'mainNoCode', caller: main, member: issue(3), bodyHash: scene.member(issue(3)).contract.bodyHash, reason: 'Correction independently proves no code change is needed.', acceptedAt: 500 }); scene.observe(); scene.closeEffects();
    const fresh = scene.gate('postMerge'); assert.ok(fresh.stamp.kind === 'postMerge' && fresh.stamp.members.length === 2, 'Fresh postMerge includes original and correction including noCode terminals');
    scene.verdict('postMerge'); assert.ok(scene.member(issue(2)).work);
    assert.equal(scene.facts.issues.find(value => equalRef(value.ref, parent))?.state, 'open');
    scene.accept({ kind: 'mainNoCode', caller: main, member: issue(2), bodyHash: scene.member(issue(2)).contract.bodyHash, reason: 'Second item independently already satisfied.', acceptedAt: 600 }); scene.observe(); scene.closeEffects(); scene.verdict('postMerge');
    const closure = scene.gate('closure'); assert.ok(closure.stamp.kind === 'closure' && closure.stamp.children.length === 3);
    assert.equal(scene.facts.issues.find(value => equalRef(value.ref, parent))?.state, 'open'); scene.verdict('closure'); scene.closeEffects();
    const report = scene.state.report; assert.ok(report); const reportTicket = scene.ticket(`work:${report.id}`);
    const accepted = scene.reply(reportTicket, { kind: 'report', summary: 'All ordered members, correction, postMerge checks and parent closure were delivered.' }, main);
    assert.equal(scene.state.lifecycle, 'completed');
    const replay = scene.reply(reportTicket, { kind: 'report', summary: 'All ordered members, correction, postMerge checks and parent closure were delivered.' }, main); assert.equal(replay.kind, 'same');
    if (accepted.kind !== 'rejected') assert.deepEqual(replay.reply, accepted.reply);
    assert.equal(scene.facts.issues.find(value => equalRef(value.ref, parent))?.state, 'closed');
  } },
];
