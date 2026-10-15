import { describe, expect, test } from 'bun:test';
import { createAgenda, tickets, transition } from '../src/domain/index.ts';
import type {
  Agenda, Caller, CaseDecision, CommitObservation, DecisionCase, DesignRoute, Event,
  Facts, GateJob, HostObservation, Inputs, IssueRef, IssueSnapshot, Member,
  PrSnapshot, ProtocolReply, Repo, ShaRef, Ticket, Transition, Unit,
} from '../src/domain/index.ts';

// Source and registry observations are constructed here, independently of every
// other test driver. Agenda objects, requirements, jobs and terminals come only
// from the exported API. No issue-creation attempt is made by these traces, so
// createdIssues is genuinely empty (corrections use an existing source issue).
const product: Repo = { owner: 'design-proof-source', name: 'application' };
const unrelated: Repo = { owner: 'design-proof-source', name: 'different-application' };
const digest = (digit: string, length = 40): string => digit.repeat(length);
const initialDefault = digest('1');
const design = digest('2');
const firstMerge = digest('3');
const carrierMerge = digest('4');
const laterDefault = digest('5');
const repairedDefault = digest('6');
const correctionMerge = digest('7');
const designRef: ShaRef = { repo: product, sha: design };
const original: IssueRef = { repo: product, number: 101 };
const laterCarrier: IssueRef = { repo: product, number: 102 };
const existingCorrection: IssueRef = { repo: product, number: 103 };
const umbrella: IssueRef = { repo: product, number: 100 };
const main: Caller = { agentId: 'design-main', sessionId: 'design-main-session',
  parentId: null, runId: 'design-verification-run', kind: 'main', depth: 0 };
type Route = 'defaultFirst' | 'withPr' | 'future';
type Proof = CommitObservation['result'] | 'absent' | 'wrongRepo';
const sameRepo = (left: Repo, right: Repo): boolean => left.owner === right.owner && left.name === right.name;
const sameIssue = (left: IssueRef, right: IssueRef): boolean => sameRepo(left.repo, right.repo) && left.number === right.number;

function sourceIssue(ref: IssueRef, children: IssueRef[] = []): IssueSnapshot {
  return { ref, body: `Delivery contract for source issue ${ref.number}`, bodyHash: digest('a', 64),
    updatedAt: 10_000, state: 'open', lastClose: null, lastReopen: null, children };
}

function required<T>(value: T | null | undefined, description: string): T {
  if (value === null || value === undefined) throw new Error(description);
  return value;
}

class DesignTrace {
  state: Agenda;
  facts: Facts;
  host: HostObservation;
  readonly route: Route;
  readonly carrier: IssueRef;
  readonly events: string[] = [];
  private time = 10_100;
  private generation = 1;

  constructor(route: Route, parent = false) {
    this.route = route;
    this.carrier = route === 'future' ? laterCarrier : original;
    const members = route === 'future' ? [original, laterCarrier] : [original];
    this.facts = {
      viewer: 'design-source-author',
      issues: [...members.map(ref => sourceIssue(ref)), ...(parent ? [sourceIssue(umbrella, members)] : [])],
      prs: [], links: [], maintenance: [], checkAttempts: [], createdIssues: [],
      repos: [{ repo: product, defaultBranch: 'main', defaultHead: initialDefault,
        bases: ['main', 'integration'].map(name => ({ name, state: { kind: 'present',
          head: initialDefault, isDefault: name === 'main',
          rules: { required: [], strict: false, upToDate: false, constraints: [] } } })) }],
      branches: [{ repo: product, name: 'main-design-work', state: { kind: 'present', head: design } }],
      commits: [{ repo: product, ancestor: design, descendant: initialDefault, result: 'contains' }],
    };
    this.host = { runId: main.runId, main, seats: [], turnEnds: [], preflight: { ok: true, value: {
      asyncEnabled: true, isolationEnabled: true, asyncManager: true,
      gitCwd: '/tmp/roundtable-design-verification', agents: [{ name: 'task:free', blocking: false }],
    } } };
    const created = createAgenda({ op: 'convene', mode: 'execute', parent: parent ? umbrella : null,
      entries: members.map(issue => ({ issue, target: { repo: product, base: 'integration' },
        designOnly: false, adoptPr: null })) }, this.facts, 10_000,
    'b579a073-d481-4858-a148-41f75eaa2445');
    if (!created.ok) throw new Error(`convene: ${JSON.stringify(created.error)}`);
    this.state = created.value;
    this.observe();
    const owner = required(this.member(original).work, 'Initial public owner work missing');
    const ownerTicket = this.ticket(`work:${owner.id}`);
    if (ownerTicket.holder.kind !== 'seat') throw new Error('Ordinary owner must have a native seat');
    const caller = this.bind(ownerTicket.holder.requestId);
    this.reply(this.ticket(ownerTicket.id), { kind: 'claim', claim: {
      kind: 'question', reproduction: 'The source issue omits the design ancestry requirement.',
      readings: ['Implementation may omit the design commit.', 'Implementation must carry the exact design commit.'],
      earliestGap: 'The original issue does not define its design carrier.',
      proposal: 'Main specifies a same-repository design route before implementation resumes.',
    } }, caller);
    const claim = required(this.state.cases.find(item => item.subject.kind === 'claim'), 'Owner question case missing');
    const designRoute: DesignRoute = route === 'defaultFirst' ? { kind: route, repo: product }
      : route === 'withPr' ? { kind: route, member: original } : { kind: route, carrier: laterCarrier };
    this.decide(claim, { kind: 'amend', amendment: { kind: 'designGap', affected: [original],
      bodyEdits: [], route: designRoute } });
    const work = required(this.state.designWorks.find(item => item.parentCaseId === claim.id), 'Main design work missing');
    expect(work.result).toBeNull();
    const designTicket = this.ticket(`work:${work.id}`);
    expect(designTicket.holder.kind).toBe('main');
    this.reply(designTicket, { kind: 'designCommit', commit: designRef });
    this.observe();
    const accepted = required(this.member(this.carrier).contract.requirements[0], 'Accepted design requirement missing');
    expect(accepted.commit).toEqual(designRef);
    expect(accepted.route).toEqual(designRoute);
    expect(accepted.carrier).toEqual({ kind: 'member', member: this.carrier });
    expect(this.state.designWorks.find(item => item.id === work.id)?.result).toEqual(designRef);
    expect(this.state.cases.find(item => item.id === claim.id)?.state.kind).toBe('resolved');
    expect(this.state.amendments.some(item => item.caseId === claim.id && item.state.kind === 'effective')).toBe(true);
    if (route === 'future') {
      // The earlier issue must genuinely finish before the future carrier runs.
      this.merge(original, firstMerge);
      this.verdict(required(this.unit(original).postMerge, 'Earlier unit postMerge missing'));
      expect(this.member(laterCarrier).work).not.toBeNull();
    }
  }

  input(): Inputs {
    return { facts: { kind: 'available', generation: this.generation, observedAt: this.time,
      scope: { issues: this.facts.issues.map(item => item.ref), prs: this.facts.prs.map(item => item.ref),
        repos: this.facts.repos.map(item => ({ repo: item.repo, bases: item.bases.map(base => base.name) })),
        branches: this.facts.branches.map(item => ({ repo: item.repo, name: item.name })),
        commits: this.facts.commits.map(({ repo, ancestor, descendant }) => ({ repo, ancestor, descendant })),
        checkRuns: [], creations: [] }, facts: this.facts }, host: this.host,
      policy: { text: 'Verify the exact source design commit without inventing delivered merges.',
        ownerAgent: 'task:free', gateAgent: 'task:free' } };
  }

  event(event: Event): Transition {
    const result = transition(this.state, this.input(), event);
    this.events.push(`${event.kind}${event.kind === 'reply' ? `:${event.payload.kind}` : ''} => ${result.kind}`);
    if (result.kind === 'rejected') throw new Error(`${JSON.stringify(result.error)}\n${this.events.join('\n')}`);
    if (result.kind === 'next') {
      expect(result.state.version).toBe(this.state.version + 1);
      this.state = result.state;
    }
    return result;
  }

  observe(): void {
    for (let step = 0; step < 32; step++) {
      if (this.event({ kind: 'observe' }).kind === 'same') return;
    }
    throw new Error(`Nonconvergent public trace\n${this.events.join('\n')}`);
  }

  stable(): void {
    this.observe();
    const state = this.state;
    const bytes = JSON.stringify(state);
    for (let repeat = 0; repeat < 3; repeat++) {
      this.time += 100;
      this.generation++;
      const result = transition(this.state, this.input(), { kind: 'observe' });
      expect(result.kind, this.events.join('\n')).toBe('same');
      expect(this.state).toBe(state);
      expect(JSON.stringify(this.state)).toBe(bytes);
      expect(this.state.version).toBe(state.version);
    }
  }

  member(ref: IssueRef): Member {
    return required(this.state.units.flatMap(unit => unit.members).find(member => sameIssue(member.ref, ref)), 'Member absent');
  }

  unit(ref = this.carrier): Unit {
    return required(this.state.units.find(unit => unit.members.some(member => sameIssue(member.ref, ref))), 'Unit absent');
  }

  ticket(id: string): Ticket {
    return required(tickets(this.state, this.input()).find(ticket => ticket.id === id), `Public ticket absent: ${id}`);
  }

  reply(ticket: Ticket, payload: ProtocolReply, caller: Caller = main): void {
    this.event({ kind: 'reply', caller, ticket: ticket.id, revision: ticket.revision, payload, acceptedAt: ++this.time });
  }

  decide(item: DecisionCase, decision: CaseDecision): void {
    this.reply(this.ticket(`case:${item.id}`), { kind: 'decision', decision });
    this.observe();
  }

  bind(requestId: string): Caller {
    const request = required(this.state.requests.find(item => item.id === requestId), 'Seat request absent');
    if (request.binding.kind === 'bound') {
      return { kind: 'sub', agentId: request.binding.agentId, sessionId: request.binding.sessionId,
        parentId: main.agentId, depth: 1, runId: main.runId };
    }
    const agentId = `native-${requestId}`;
    const sessionId = `session-${requestId}`;
    this.host = { ...this.host, seats: [...this.host.seats, { agentId, sessionId,
      requestedName: request.name, parentId: main.agentId, createdAt: ++this.time,
      status: 'running', plan: 'disabled', streaming: false }] };
    this.reply(this.ticket(`spawn:${requestId}`), { kind: 'spawned', agentId });
    return { kind: 'sub', agentId, sessionId, parentId: main.agentId, depth: 1, runId: main.runId };
  }

  verdict(job: GateJob, settle = true): void {
    const caller = this.bind(job.requestId);
    this.reply(this.ticket(`gate:${job.id}`), { kind: 'verdict', ok: true,
      note: 'Independently tested the complete scope at its pinned source commits.' }, caller);
    if (settle) this.observe();
  }

  proof(ancestor: string, descendant: string, proof: Proof): void {
    const retained = this.facts.commits.filter(item => !(item.ancestor === ancestor && item.descendant === descendant));
    const comparison: CommitObservation[] = proof === 'absent' ? [] : [{ repo: proof === 'wrongRepo' ? unrelated : product,
      ancestor, descendant, result: proof === 'wrongRepo' ? 'contains' : proof }];
    this.facts = { ...this.facts, commits: [...retained, ...comparison] };
  }

  defaultHead(head: string): void {
    this.facts = { ...this.facts, repos: this.facts.repos.map(repo => ({ ...repo, defaultHead: head,
      bases: repo.bases.map(base => base.name === 'main' && base.state.kind === 'present'
        ? { ...base, state: { ...base.state, head } } : base) })) };
  }

  merge(member: IssueRef, merge: string): void {
    const at = ++this.time;
    const pull: PrSnapshot = { ref: { repo: product, number: member.number + 1000 },
      headRepo: product, headBranch: `source-delivery-${member.number}`, head: digest('b'),
      target: { repo: product, base: 'integration' }, title: `Deliver source issue ${member.number}`,
      body: `Closes #${member.number}`, bodyHash: digest('c', 64), updatedAt: at,
      state: { kind: 'merged', sha: merge, at }, closes: [member], mergeable: 'yes',
      checks: { kind: 'passing', required: [] } };
    this.facts = { ...this.facts,
      issues: this.facts.issues.map(issue => sameIssue(issue.ref, member)
        ? { ...issue, state: 'closed', updatedAt: at, lastClose: { id: `merge-close-${member.number}`, at } } : issue),
      prs: [...this.facts.prs, pull], links: [...this.facts.links, { issue: member, pr: pull.ref }],
      branches: [...this.facts.branches, { repo: product, name: pull.headBranch, state: { kind: 'present', head: pull.head } }],
      maintenance: [...this.facts.maintenance, { pr: pull.ref, result: { kind: 'maintainable', basis: {
        headRepo: product, headBranch: pull.headBranch, viewerPermission: 'ADMIN',
        author: this.facts.viewer, maintainerCanModify: true,
        authorization: { kind: 'actorIsAuthor', actor: this.facts.viewer },
      } } }],
      repos: this.facts.repos.map(repo => ({ ...repo, bases: repo.bases.map(base =>
        base.name === 'integration' && base.state.kind === 'present'
          ? { ...base, state: { ...base.state, head: merge } } : base) })),
    };
    this.proof(merge, merge, 'contains');
    this.observe();
    expect(this.member(member).terminal).toEqual({ kind: 'merged', pr: pull.ref,
      merge: { repo: product, sha: merge }, at });
    expect(this.member(member).work).toBeNull();
  }

  ancestryCase(kind: 'postMerge' | 'closure'): DecisionCase {
    const item = required(this.state.cases.find(item => item.subject.kind === kind && item.state.kind === 'open'),
      `Exact ${kind} ancestry case absent`);
    if (item.subject.kind !== kind || item.subject.cause.kind !== 'ancestry') throw new Error('Fabricated gate failure instead of source ancestry case');
    const expected = { ancestor: designRef, descendant: { repo: product,
      sha: kind === 'postMerge' ? carrierMerge : this.facts.repos[0]!.defaultHead } };
    expect(item.subject.cause.comparisons).toContainEqual(expected);
    return item;
  }

  rejectVerdict(job: GateJob, caller: Caller): void {
    const before = JSON.stringify(this.state);
    const result = transition(this.state, this.input(), { kind: 'reply', caller, ticket: `gate:${job.id}`,
      revision: 1, acceptedAt: ++this.time,
      payload: { kind: 'verdict', ok: true, note: 'Attempt to accept after exact design proof vanished.' } });
    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error('Unproven design ancestry accepted a verdict');
    expect(result.error.kind).toBe('premiseChanged');
    expect(JSON.stringify(this.state)).toBe(before);
  }
}

function assertRealMerges(trace: DesignTrace, job: GateJob): void {
  if (job.stamp.kind !== 'postMerge' && job.stamp.kind !== 'closure') throw new Error('Verification stamp absent');
  const members = job.stamp.kind === 'postMerge' ? trace.unit().members : trace.state.units.flatMap(unit => unit.members);
  for (const repo of job.stamp.repos) {
    const real = members.flatMap(member => member.terminal.kind === 'merged' && sameRepo(member.terminal.merge.repo, repo.repo)
      ? [member.terminal.merge.sha] : []);
    expect([...repo.merges].sort()).toEqual(real.sort());
    expect(repo.merges).not.toContain(design);
  }
  if (job.stamp.kind === 'postMerge') {
    expect(job.stamp.members.map(item => item.member.member)).toEqual(trace.unit().members.map(member => member.ref));
    expect(job.stamp.members.flatMap(item => item.member.required)).toContainEqual(designRef);
  }
}

function prepareClosure(route: Route): DesignTrace {
  const trace = new DesignTrace(route, true);
  trace.proof(design, carrierMerge, 'contains');
  trace.merge(trace.carrier, carrierMerge);
  // Return at the accepted reply boundary: each caller supplies the complete
  // default-branch read before asking observe to consider parent closure.
  trace.verdict(required(trace.unit().postMerge, 'Carrier postMerge job absent'), false);
  return trace;
}

describe('independent exact design ancestry verification', () => {
  for (const route of ['defaultFirst', 'withPr', 'future'] as const) {
    test(`${route}: explicit design noncontainment blocks postMerge despite every real merge ancestor`, () => {
      const trace = new DesignTrace(route);
      trace.proof(design, carrierMerge, 'notContained');
      trace.merge(trace.carrier, carrierMerge);
      expect(trace.unit().postMerge).toBeNull();
      const item = trace.ancestryCase('postMerge');
      expect(tickets(trace.state, trace.input()).some(ticket => ticket.id === `case:${item.id}`)).toBe(true);
      expect(trace.state.units.flatMap(unit => unit.members).every(member => member.terminal.kind === 'merged')).toBe(true);
      expect(trace.state.units.flatMap(unit => unit.members).some(member => member.review?.status.kind === 'answered'
        && !member.review.status.ok)).toBe(false);
      trace.stable();
      trace.proof(design, carrierMerge, 'contains');
      trace.observe();
      const fresh = required(trace.unit().postMerge, 'Real design containment did not permit postMerge');
      expect(fresh.status.kind).toBe('requested');
      expect(trace.state.cases.find(current => current.id === item.id)?.state.kind).toBe('cancelled');
      assertRealMerges(trace, fresh);
      trace.verdict(fresh);
      expect(trace.unit().postMerge?.status).toMatchObject({ kind: 'answered', ok: true });
      trace.stable();
    });

    for (const proof of ['absent', 'missing', 'wrongRepo'] as const) {
      test(`${route}: ${proof} design proof is unavailable, never a fabricated not-ok`, () => {
        const trace = new DesignTrace(route);
        trace.proof(design, carrierMerge, proof);
        trace.merge(trace.carrier, carrierMerge);
        expect(trace.unit().postMerge).toBeNull();
        expect(trace.state.cases.filter(item => item.subject.kind === 'postMerge')).toEqual([]);
        expect(tickets(trace.state, trace.input()).filter(ticket => ticket.id.startsWith('gate:')
          && ticket.context.kind === 'unit' && ticket.context.unitId === trace.unit().id)).toEqual([]);
        expect(trace.member(trace.carrier).contract.requirements.map(item => item.commit)).toEqual([designRef]);
        trace.stable();
      });
    }

    test(`${route}: an already requested postMerge verdict must recheck the exact design proof`, () => {
      const trace = new DesignTrace(route);
      trace.proof(design, carrierMerge, 'contains');
      trace.merge(trace.carrier, carrierMerge);
      const old = required(trace.unit().postMerge, 'Initial postMerge missing');
      const caller = trace.bind(old.requestId);
      trace.proof(design, carrierMerge, 'notContained');
      trace.rejectVerdict(old, caller);
      trace.observe();
      const item = trace.ancestryCase('postMerge');
      trace.proof(design, carrierMerge, 'contains');
      trace.decide(item, { kind: 'reverify', basis: 'The exact design-to-selected-commit ancestry is now source verified.' });
      const fresh = required(trace.unit().postMerge, 'Fresh postMerge absent');
      expect(fresh.id).not.toBe(old.id);
      expect(fresh.requestId).not.toBe(old.requestId);
      assertRealMerges(trace, fresh);
      trace.verdict(fresh);
      trace.stable();
    });

    test(`${route}: parent closure uses exact default design ancestry, not only member merges`, () => {
      const trace = prepareClosure(route);
      trace.defaultHead(laterDefault);
      for (const member of trace.state.units.flatMap(unit => unit.members)) {
        if (member.terminal.kind === 'merged') trace.proof(member.terminal.merge.sha, laterDefault, 'contains');
      }
      trace.proof(design, laterDefault, 'notContained');
      trace.observe();
      expect(trace.state.closure).toBeNull();
      const item = trace.ancestryCase('closure');
      expect(trace.state.cases.some(current => current.subject.kind === 'orphanDesign' && current.state.kind === 'open')).toBe(false);
      expect(trace.state.units.every(unit => unit.postMerge?.status.kind === 'answered' && unit.postMerge.status.ok)).toBe(true);
      trace.stable();
      trace.defaultHead(repairedDefault);
      for (const member of trace.state.units.flatMap(unit => unit.members)) {
        if (member.terminal.kind === 'merged') trace.proof(member.terminal.merge.sha, repairedDefault, 'contains');
      }
      trace.proof(design, repairedDefault, 'contains');
      trace.observe();
      const fresh = required(trace.state.closure, 'Source repair did not permit fresh closure');
      expect(fresh.status.kind).toBe('requested');
      expect(trace.state.cases.find(current => current.id === item.id)?.state.kind).toBe('cancelled');
      assertRealMerges(trace, fresh);
      trace.stable();
    });

    for (const proof of ['missing', 'wrongRepo'] as const) {
      test(`${route}: closure cannot turn ${proof} default design proof into a failed gate`, () => {
        const trace = prepareClosure(route);
        trace.defaultHead(laterDefault);
        for (const member of trace.state.units.flatMap(unit => unit.members)) {
          if (member.terminal.kind === 'merged') trace.proof(member.terminal.merge.sha, laterDefault, 'contains');
        }
        trace.proof(design, laterDefault, proof);
        trace.observe();
        expect(trace.state.closure).toBeNull();
        expect(trace.state.cases.filter(item => item.subject.kind === 'closure')).toEqual([]);
        expect(trace.state.units.every(unit => unit.postMerge?.status.kind === 'answered' && unit.postMerge.status.ok)).toBe(true);
        trace.stable();
      });
    }

    test(`${route}: requested closure rejects a verdict when only its exact design proof disappears`, () => {
      const trace = prepareClosure(route);
      trace.defaultHead(laterDefault);
      for (const member of trace.state.units.flatMap(unit => unit.members)) {
        if (member.terminal.kind === 'merged') trace.proof(member.terminal.merge.sha, laterDefault, 'contains');
      }
      trace.proof(design, laterDefault, 'contains');
      trace.observe();
      const closure = required(trace.state.closure, 'Initial closure absent');
      assertRealMerges(trace, closure);
      const caller = trace.bind(closure.requestId);
      trace.proof(design, laterDefault, 'wrongRepo');
      trace.rejectVerdict(closure, caller);
      trace.proof(design, laterDefault, 'contains');
      trace.verdict(closure);
      expect(trace.state.closure?.status).toMatchObject({ kind: 'answered', ok: true });
      trace.stable();
    });
  }

  test('a real correction enables whole-unit verification without treating the design commit as another merge', () => {
    const trace = new DesignTrace('withPr');
    trace.proof(design, carrierMerge, 'notContained');
    trace.merge(original, carrierMerge);
    const failedProof = trace.ancestryCase('postMerge');
    trace.facts = { ...trace.facts, issues: [...trace.facts.issues, sourceIssue(existingCorrection)] };
    trace.decide(failedProof, { kind: 'correct', insertion: { kind: 'existing', entry: {
      issue: existingCorrection, target: { repo: product, base: 'integration' }, designOnly: false, adoptPr: null,
    }, position: { kind: 'correctionOf', unitId: trace.unit().id } } });
    trace.proof(carrierMerge, correctionMerge, 'contains');
    trace.proof(design, correctionMerge, 'contains');
    trace.merge(existingCorrection, correctionMerge);
    const fresh = required(trace.unit().postMerge, 'Whole-unit corrected postMerge absent');
    expect(trace.unit().members.map(member => member.ref)).toEqual([original, existingCorrection]);
    if (fresh.stamp.kind !== 'postMerge') throw new Error('Wrong corrected gate kind');
    expect(fresh.stamp.repos).toEqual([{ repo: product, commit: correctionMerge, merges: [carrierMerge, correctionMerge] }]);
    assertRealMerges(trace, fresh);
    trace.verdict(fresh);
    trace.stable();
  });
});
