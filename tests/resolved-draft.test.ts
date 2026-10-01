import { describe, expect, test } from "bun:test";
import {
  bodyHash,
  canonical,
  convene,
  derive,
  step,
  type AgendaId,
  type AgendaState,
  type Classified,
  type Decision,
  type Draft,
  type EventId,
  type Facts,
  type Host,
  type IssueFact,
  type IssueRef,
  type Millis,
  type Obligation,
  type Policy,
  type ReplyId,
  type Sha,
  type StepEvent,
  type StoredVerdict,
  type Transition,
} from "../src/core/index.ts";

type SubjectName = "orphanDesign" | "migration" | "agendaGap";
type SubjectVerdict = "resolved" | "external";
type ClassifiedSubject = Classified["subjects"][number];

const repo = { owner: "lab", name: "sandbox" } as const;
const target = { repo, base: "main" } as const;
const policy: Policy = { appendSystem: "APPEND", systemBlocks: "BLOCKS", seatAgents: { owner: "task:high", gate: "task:mid" } };
const host: Host = { agents: [], failures: [] };

const agendaId = "ag-resolved-draft" as AgendaId;
const at = (value: number): Millis => value as Millis;
const ref = (number: number): IssueRef => ({ repo, number });
const sha = (value: string): Sha => value as Sha;
const replyId = (value: string): ReplyId => `re-${value}` as ReplyId;

interface Fixture {
  readonly subject: SubjectName;
  readonly state: AgendaState;
  readonly facts: Facts;
  readonly draft: Draft;
}

function closedIssue(issue: IssueRef, body: string, children: readonly IssueRef[] = []): IssueFact {
  return {
    ref: issue,
    open: false,
    events: [{ id: `event-${issue.number}` as EventId, kind: "closed", at: at(30) }],
    bodyHash: bodyHash(body),
    children,
  };
}

function facts(issues: readonly IssueFact[], onDefault: readonly Sha[] = [sha("base")]): Facts {
  return {
    issues,
    prs: [],
    links: [],
    commits: {
      onDefault: onDefault.map((commit) => ({ repo, sha: commit })),
      contains: [],
      baseHead: [],
    },
  };
}

function terminalMember(state: AgendaState, member: IssueRef, body: string): AgendaState {
  return {
    ...state,
    members: state.members.map((candidate) =>
      candidate.issue.number === member.number
        ? { ...candidate, noCode: { bodyHash: bodyHash(body), at: at(20) } }
        : candidate,
    ),
  };
}

function draft(title: string, anchor: Draft["anchor"], designOnly: boolean): Draft {
  return { index: 0, repo, title, body: `${title} body`, anchor, target, designOnly };
}

function orphanDesignFixture(): Fixture {
  const member = ref(11);
  const memberBody = "orphan member";
  const stranded = sha("orphan-design");
  const initial = convene(agendaId, at(1), null, [{ issue: member, target, designOnly: false, adoptPr: null }]);
  const state: AgendaState = {
    ...terminalMember(initial, member, memberBody),
    contracts: [
      {
        id: replyId("orphan-contract"),
        affected: [member],
        routes: [{ route: { kind: "withPr", commit: stranded, designBranch: "design" }, carrier: member }],
      },
    ],
    reported: true,
  };
  return {
    subject: "orphanDesign",
    state,
    facts: facts([closedIssue(member, memberBody)]),
    // A stranded design commit gets a remediation draft for a new design-only entry.
    draft: draft("orphan design carrier", { kind: "after", entry: member }, true),
  };
}

function migrationFixture(): Fixture {
  const member = ref(21);
  const migration = ref(22);
  const memberBody = "migration member";
  const migrationCommit = sha("migration-design");
  const initial = convene(agendaId, at(1), null, [{ issue: member, target, designOnly: false, adoptPr: null }]);
  const state: AgendaState = {
    ...terminalMember(initial, member, memberBody),
    contracts: [
      {
        id: replyId("migration-contract"),
        affected: [member],
        routes: [{ route: { kind: "defaultFirst", commit: migrationCommit, migration }, carrier: null }],
      },
    ],
    reported: true,
  };
  return {
    subject: "migration",
    state,
    // Keeping the design commit on default isolates the migration witness from orphanDesign.
    facts: facts([closedIssue(member, memberBody), closedIssue(migration, "migration source")], [sha("base"), migrationCommit]),
    draft: draft("migration replacement", { kind: "after", entry: member }, false),
  };
}

function agendaGapFixture(): Fixture {
  const member = ref(31);
  const parent = ref(32);
  const missingChild = ref(33);
  const memberBody = "agenda member";
  const parentBody = "agenda parent";
  const initial = convene(agendaId, at(1), parent, [{ issue: member, target, designOnly: false, adoptPr: null }]);
  const initialState: AgendaState = { ...terminalMember(initial, member, memberBody), reported: true };
  const initialFacts = facts([closedIssue(member, memberBody), closedIssue(parent, parentBody, [member, missingChild])]);

  // A valid closure pass keeps the agenda-gap ticket as the only actionable ticket. The
  // closure witness and manifest are obtained from derive rather than hand-made obligations.
  const initialDerived = derive(initialState, initialFacts, host, policy);
  const manifest = initialDerived.classified.closure.w.manifest;
  const closureTicket = initialDerived.classified.closure.w.ids.closure;
  if (manifest === null || closureTicket === null) throw new Error("agenda-gap fixture did not produce a closure witness");
  const closure: StoredVerdict = {
    id: replyId("agenda-closure-pass"),
    ticket: closureTicket,
    attempt: 1,
    manifest,
    verdict: { gate: "closure", ok: true, note: "fixture pass" },
    adjudication: null,
    failDecision: null,
  };

  return {
    subject: "agendaGap",
    state: { ...initialState, closure: { attempt: 1, verdict: closure } },
    facts: initialFacts,
    draft: draft("missing child", { kind: "after", entry: member }, false),
  };
}

const CASES: readonly { readonly name: string; readonly build: () => Fixture }[] = [
  { name: "orphanDesign", build: orphanDesignFixture },
  { name: "migration", build: migrationFixture },
  { name: "agendaGap", build: agendaGapFixture },
];

function currentSubject(fixture: Fixture): { readonly subject: ClassifiedSubject; readonly obligation: Obligation } {
  const derived = derive(fixture.state, fixture.facts, host, policy);
  const candidates = derived.classified.subjects.filter((entry) => entry.w.subject === fixture.subject);
  if (candidates.length !== 1) throw new Error(`expected one ${fixture.subject} witness, got ${candidates.length}`);
  const subject = candidates[0];
  if (subject === undefined) throw new Error(`missing ${fixture.subject} subject witness`);
  const obligation = derived.obligations.find((entry) => entry.id === subject.w.id && entry.kind === `decide:${fixture.subject}`);
  expect(obligation).toBeDefined();
  if (obligation === undefined) throw new Error(`missing current ${fixture.subject} obligation`);
  return { subject, obligation };
}

function subjectDecision(subject: SubjectName, key: ClassifiedSubject["w"]["key"], verdict: SubjectVerdict): Decision {
  switch (subject) {
    case "orphanDesign":
      return { subject: "orphanDesign", key, verdict };
    case "migration":
      return { subject: "migration", key, verdict };
    case "agendaGap":
      return { subject: "agendaGap", key, verdict };
    default:
      return assertNever(subject);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected subject ${String(value)}`);
}

function eventFor(obligation: Obligation, subject: ClassifiedSubject, verdict: SubjectVerdict, drafts: readonly Draft[]): StepEvent {
  return {
    kind: "reply",
    caller: { kind: "main" },
    reply: {
      kind: "decision",
      obligation: obligation.id,
      decision: subjectDecision(subject.w.subject, subject.w.key, verdict),
      rationale: "resolved-draft regression",
      drafts,
      bodyReplacements: [],
    },
    live: { branchHead: null, branchContains: [] },
    at: at(100),
  };
}

function nextState(transition: Transition): AgendaState {
  expect(transition.kind).toBe("next");
  if (transition.kind !== "next") throw new Error(`expected next, got ${transition.kind}`);
  return transition.state;
}

function rejected(transition: Transition): Extract<Transition, { kind: "rejected" }> {
  expect(transition.kind).toBe("rejected");
  if (transition.kind !== "rejected") throw new Error(`expected rejected, got ${transition.kind}`);
  return transition;
}

describe("resolved subject decisions and draft materialization", () => {
  for (const variant of CASES) {
    test(`${variant.name}: resolved without a draft is rejected without consuming the ticket`, () => {
      const fixture = variant.build();
      const current = currentSubject(fixture);
      const before = canonical(fixture.state);

      const transition = step(fixture.state, fixture.facts, host, policy, eventFor(current.obligation, current.subject, "resolved", []));
      const result = rejected(transition);

      expect(result.reason).toContain("草稿");
      expect(canonical(fixture.state)).toBe(before);
      const stillCurrent = currentSubject(fixture);
      expect(stillCurrent.subject.w.key).toBe(current.subject.w.key);
      expect(stillCurrent.obligation.id).toBe(current.obligation.id);
    });

    test(`${variant.name}: resolved with its attached draft is accepted and derives that draft's createIssue effect`, () => {
      const fixture = variant.build();
      const current = currentSubject(fixture);

      const state = nextState(step(fixture.state, fixture.facts, host, policy, eventFor(current.obligation, current.subject, "resolved", [fixture.draft])));
      const persisted = state.drafts.find((entry) => entry.issue === null && canonical(entry.draft) === canonical(fixture.draft));
      expect(persisted).toBeDefined();
      if (persisted === undefined) throw new Error("accepted draft was not persisted");

      const derived = derive(state, fixture.facts, host, policy);
      const createIssue = derived.obligations.find((entry) => {
        const action = entry.action;
        return entry.kind === "effect:createIssue" && action?.kind === "effect" && action.target.kind === "createIssue" && action.target.draft.id === persisted.id;
      });
      expect(createIssue).toBeDefined();
      if (createIssue === undefined || createIssue.action?.kind !== "effect" || createIssue.action.target.kind !== "createIssue")
        throw new Error("accepted draft did not derive its createIssue effect");
    });

    test(`${variant.name}: external without a draft is accepted and leaves the subject in waiting`, () => {
      const fixture = variant.build();
      const current = currentSubject(fixture);

      const state = nextState(step(fixture.state, fixture.facts, host, policy, eventFor(current.obligation, current.subject, "external", [])));
      expect(state.drafts).toEqual(fixture.state.drafts);
      const derived = derive(state, fixture.facts, host, policy);
      const subject = derived.classified.subjects.find((entry) => entry.w.subject === fixture.subject);
      expect(subject?.s.decided).toBe("external");
      expect(derived.waiting).toBe(true);
      expect(derived.obligations.some((entry) => entry.kind === `decide:${fixture.subject}`)).toBe(false);
      expect(derived.obligations.some((entry) => entry.kind === "effect:createIssue")).toBe(false);
      expect(derived.obligations.some((entry) => entry.kind === "decideStall")).toBe(false);
    });
  }
});
