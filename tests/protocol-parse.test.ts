import { describe, expect, test } from 'bun:test';
import { parsePortInput, parseToolParameters } from '../src/domain/parse.ts';
import type {
  BodyEdit, CaseDecision, DraftSpec, Entry, Insertion, IssueRef, ParseError,
  PortInput, ProtocolReply, Repo, Result, SourceCondition,
} from '../src/domain/model.ts';

// These payloads are independent public clients, not engine fixtures or a second
// schema. Parsing is not authorization: Main/seat labels describe the sender's
// payload, not a claim that a parser checks its registry identity or ticket kind.
const repo: Repo = { owner: 'protocol-consumer', name: 'application' };
const issue: IssueRef = { repo, number: 41 };
const otherIssue: IssueRef = { repo, number: 42 };
const pr: IssueRef = { repo, number: 81 };
const target = { repo, base: 'integration' };
const head = 'a'.repeat(40);
const bodyHash = 'b'.repeat(64);
const agenda = '67d59c71-c554-4a8f-8a44-763d877acf31';
const entry: Entry = { issue, target, designOnly: false, adoptPr: null };
const draft: DraftSpec = {
  repo, title: 'Carry the independent design obligation',
  body: 'Deliver the original obligation and verify its public behavior.',
  target, designOnly: true,
};
const bodyEdit: BodyEdit = { issue, expectedHash: bodyHash, body: 'Revised delivery contract.' };
const existingInsertion: Insertion = {
  kind: 'existing', entry: { ...entry, issue: otherIssue },
  position: { kind: 'before', unitId: 'unit-original' },
};
const draftInsertion: Insertion = {
  kind: 'draft', draft, position: { kind: 'correctionOf', unitId: 'unit-original' },
};
const question: ProtocolReply = {
  kind: 'claim', claim: {
    kind: 'question', reproduction: 'A missing clause permits two observable outcomes.',
    readings: ['The operation retains its obligation.', 'The operation transfers its obligation.'],
    earliestGap: 'The transfer boundary does not name a carrier.',
    proposal: 'Name the carrier before implementation resumes.',
  },
};
const submit: ProtocolReply = {
  kind: 'submit', branch: 'delivery/protocol-boundary', head,
  title: 'Implement the agreed contract', body: 'Implementation, review, runtime evidence and limits.',
  template: 'fourLayer', retryNote: null,
};

type ReplyInput=Extract<PortInput,{op:'reply'}>;
function replyInput(reply: ProtocolReply, ticket = 'case:consumer-case'): ReplyInput {
  return { op: 'reply', ticket, revision: 1, reply };
}

function reject<T>(result: Result<T, ParseError>): ParseError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Malformed public payload was accepted');
  expect(result.error.path.length).toBeGreaterThan(0);
  expect(result.error.reason.trim().length).toBeGreaterThan(0);
  return result.error;
}

function rejectInput(value: unknown): void {
  reject(parsePortInput(value));
  reject(parseToolParameters({ input: value }));
}

function preserve(input: PortInput): void {
  expect(parsePortInput(input)).toEqual({ ok: true, value: input });
  expect(parseToolParameters({ input })).toEqual({ ok: true, value: { input } });
}

type ValidInput = { name: string; input: PortInput };
type ValidDecision = { name: string; decision: CaseDecision };
type InvalidInput = { name: string; value: unknown };

const operations: ValidInput[] = [
  { name: 'Main plans convene with required nullable parent and adoption', input: {
    op: 'convene', mode: 'plan', parent: null, entries: [entry],
  } },
  { name: 'Main executes convene with parent, adopted PR and design-only entry', input: {
    op: 'convene', mode: 'execute', parent: otherIssue,
    entries: [{ ...entry, adoptPr: pr, designOnly: true }],
  } },
  { name: 'Main resumes only with explicit true confirmation', input: {
    op: 'resume', agenda, operatorConfirmedOriginalSessionEnded: true,
  } },
  { name: 'Main or seat requests selected tickets without optional agenda', input: { op: 'tickets' } },
  { name: 'Main requests exact agenda tickets', input: { op: 'tickets', agenda } },
  { name: 'Main classifies no-code with source body hash', input: {
    op: 'noCode', member: issue, bodyHash, reason: 'The issue requires no source change.',
  } },
];

const replies: { name: string; reply: ProtocolReply; ticket: string }[] = [
  { name: 'seat submits four-layer evidence with null retry note', reply: submit, ticket: 'work:owner' },
  { name: 'seat submits documentation and a non-null retry note', reply: {
    kind: 'submit', branch: 'delivery/design', head, title: 'Publish design',
    body: 'Document-only evidence.', template: 'docOnly', retryNote: 'Retested after review.',
  }, ticket: 'work:design-member' },
  { name: 'seat questions with exactly two preserved readings', reply: question, ticket: 'work:owner' },
  { name: 'seat claims no-code', reply: { kind: 'claim', claim: {
    kind: 'noCode', evidence: 'The current source already satisfies the stated outcome.',
  } }, ticket: 'work:owner' },
  { name: 'seat proposes a split', reply: { kind: 'claim', claim: {
    kind: 'split', proposal: 'Separate the prerequisite from the implementation obligation.',
  } }, ticket: 'work:owner' },
  { name: 'seat reports a concrete block', reply: { kind: 'claim', claim: {
    kind: 'blocked', category: 'external dependency', attempts: 'Queried the named upstream source.',
  } }, ticket: 'work:owner' },
  { name: 'gate returns passing verdict with only ok and note', reply: {
    kind: 'verdict', ok: true, note: 'Observed the required outcome.',
  }, ticket: 'gate:review' },
  { name: 'gate returns failing verdict with only ok and note', reply: {
    kind: 'verdict', ok: false, note: 'The independent runtime path still fails.',
  }, ticket: 'gate:accept' },
  { name: 'Main acknowledges a spawned seat', reply: { kind: 'spawned', agentId: 'RtOwner17' }, ticket: 'spawn:owner' },
  { name: 'Main supplies an exact design commit', reply: { kind: 'designCommit', commit: { repo, sha: head } }, ticket: 'work:design' },
  { name: 'Main reports completion', reply: { kind: 'report', summary: 'Delivered the verified result.' }, ticket: 'work:report' },
];

const decisions: ValidDecision[] = [
  { name: 'amend/designGap/defaultFirst', decision: { kind: 'amend', amendment: {
    kind: 'designGap', affected: [issue], bodyEdits: [], route: { kind: 'defaultFirst', repo },
  } } },
  { name: 'amend/designGap/withPr', decision: { kind: 'amend', amendment: {
    kind: 'designGap', affected: [issue, otherIssue], bodyEdits: [bodyEdit],
    route: { kind: 'withPr', member: issue },
  } } },
  { name: 'amend/designGap/future-existing', decision: { kind: 'amend', amendment: {
    kind: 'designGap', affected: [issue], bodyEdits: [], route: { kind: 'future', carrier: otherIssue },
  } } },
  { name: 'amend/designGap/future-draft', decision: { kind: 'amend', amendment: {
    kind: 'designGap', affected: [issue], bodyEdits: [bodyEdit], route: { kind: 'future', carrier: draft },
  } } },
  { name: 'amend/acceptanceMethod/draft-transfer', decision: { kind: 'amend', amendment: {
    kind: 'acceptanceMethod', affected: [issue], bodyEdits: [bodyEdit], transfer: draftInsertion,
  } } },
  { name: 'amend/acceptanceMethod/existing-transfer', decision: { kind: 'amend', amendment: {
    kind: 'acceptanceMethod', affected: [issue], bodyEdits: [bodyEdit], transfer: existingInsertion,
  } } },
  { name: 'confirmNoCode/member-context', decision: { kind: 'confirmNoCode', bodyHash, reason: 'No implementation obligation remains.' } },
  { name: 'confirmNoCode/explicit-issue', decision: { kind: 'confirmNoCode', issue, bodyHash, reason: 'Classify the exact agenda gap.' } },
  { name: 'answer', decision: { kind: 'answer', basis: 'Use the first reading.' } },
  { name: 'outOfDomain', decision: { kind: 'outOfDomain', basis: 'This is outside the public contract.' } },
  { name: 'implementationDefect', decision: { kind: 'implementationDefect', basis: 'The existing member owns this defect.' } },
  { name: 'refute', decision: { kind: 'refute', basis: 'The source evidence disproves the claim.' } },
  { name: 'upholdOwner', decision: { kind: 'upholdOwner', basis: 'The finding is an implementation obligation.' } },
  { name: 'upholdMain', decision: { kind: 'upholdMain', basis: 'Main must settle the design first.' } },
  { name: 'reject', decision: { kind: 'reject', basis: 'The finding contradicts the accepted contract.' } },
  { name: 'fix', decision: { kind: 'fix', basis: 'Repair the failed check.' } },
  { name: 'reverify', decision: { kind: 'reverify', basis: 'Run the independent acceptance again.' } },
  { name: 'keepWork', decision: { kind: 'keepWork', basis: 'Preserve the existing implementation obligation.' } },
  { name: 'split/mixed-insertions', decision: { kind: 'split', bodyEdit,
    insertions: [existingInsertion, { kind: 'draft', draft, position: { kind: 'after', unitId: 'unit-original' } }],
  } },
  { name: 'replacePr', decision: { kind: 'replacePr', pr, reason: 'The source confirms this maintainable replacement.' } },
  { name: 'outOfScope', decision: { kind: 'outOfScope', draft } },
  { name: 'reopen', decision: { kind: 'reopen', eventId: 'close-event-1' } },
  { name: 'restore', decision: { kind: 'restore', eventId: 'reopen-event-2' } },
  { name: 'revokeNoCode', decision: { kind: 'revokeNoCode', eventId: 'reopen-event-3' } },
  { name: 'correct/insertion', decision: { kind: 'correct', insertion: draftInsertion } },
  { name: 'correct/draft', decision: { kind: 'correct', draft } },
  { name: 'rerun', decision: { kind: 'rerun', runId: 91 } },
  { name: 'correctDesign/existing', decision: { kind: 'correctDesign', insertion: existingInsertion, clauses: ['Retain the original design requirement.'] } },
  { name: 'correctDesign/draft', decision: { kind: 'correctDesign', insertion: draftInsertion, clauses: ['Carry the exact commit.', 'Verify the transferred obligation.'] } },
  { name: 'assignCarrier/existing', decision: { kind: 'assignCarrier', commit: { repo, sha: head }, carrier: otherIssue } },
  { name: 'assignCarrier/draft', decision: { kind: 'assignCarrier', commit: { repo, sha: head }, carrier: draft } },
  { name: 'assignMigration/existing', decision: { kind: 'assignMigration', original: issue, migration: otherIssue } },
  { name: 'assignMigration/draft', decision: { kind: 'assignMigration', original: issue, migration: draft } },
  { name: 'includeExisting', decision: { kind: 'includeExisting', issue: otherIssue, position: { kind: 'outsideAgenda' } } },
  { name: 'retry/zero-based-attempt', decision: { kind: 'retry', effectId: 'effect-merge', attempt: 0 } },
  { name: 'adoptResult/pr', decision: { kind: 'adoptResult', effectId: 'effect-publish', result: { kind: 'pr', pr } } },
  { name: 'adoptResult/issue', decision: { kind: 'adoptResult', effectId: 'effect-create', result: { kind: 'issue', issue: otherIssue } } },
  { name: 'retryAfterAbsence', decision: { kind: 'retryAfterAbsence', effectId: 'effect-create', attempt: 1 } },
  { name: 'rebaseEdit/empty-replacement-body', decision: { kind: 'rebaseEdit', effectId: 'effect-body', expectedHash: bodyHash, body: '' } },
  { name: 'sourceRestored', decision: { kind: 'sourceRestored', acceptedHead: head } },
  { name: 'acceptExternalMerge', decision: { kind: 'acceptExternalMerge', pr } },
  { name: 'retryHost', decision: { kind: 'retryHost', requestId: 'request-owner' } },
];
const conditions: SourceCondition[] = [
  { kind: 'checksSettled', pr, runId: 91 },
  { kind: 'bodyChanged', issue, fromHash: bodyHash },
  { kind: 'commitLanded', commit: { repo, sha: head } },
  { kind: 'issueState', issue, open: true },
  { kind: 'prChanged', pr, fromHead: head },
  { kind: 'mainRelease', reason: 'Main must explicitly reassess the external dependency.' },
];

const invalidInputs: InvalidInput[] = [
  { name: 'null input', value: null },
  { name: 'array input', value: [] },
  { name: 'unknown operation', value: { op: 'publish' } },
  { name: 'root extra field', value: { op: 'tickets', unexpected: true } },
  { name: 'host intent is not a domain field', value: { op: 'tickets', i: 'Reading roundtable tickets' } },
  { name: 'nested entry extra field', value: { op: 'convene', mode: 'execute', parent: null, entries: [{ ...entry, active: true }] } },
  { name: 'nested repo extra field', value: { op: 'noCode', member: { ...issue, repo: { ...repo, permission: 'ADMIN' } }, bodyHash, reason: 'No change.' } },
  { name: 'false resume authorization', value: { op: 'resume', agenda, operatorConfirmedOriginalSessionEnded: false } },
  { name: 'missing resume authorization', value: { op: 'resume', agenda } },
  { name: 'unknown reply tag', value: { op: 'reply', ticket: 'work:owner', revision: 1, reply: { kind: 'finished' } } },
  { name: 'unknown decision tag', value: { op: 'reply', ticket: 'case:one', revision: 1, reply: { kind: 'decision', decision: { kind: 'resolved' } } } },
  { name: 'verdict carries head', value: { ...replyInput({ kind: 'verdict', ok: true, note: 'Passed.' }), reply: { kind: 'verdict', ok: true, note: 'Passed.', head } } },
  { name: 'verdict carries pin', value: { ...replyInput({ kind: 'verdict', ok: true, note: 'Passed.' }), reply: { kind: 'verdict', ok: true, note: 'Passed.', pin: { head, bodyHash } } } },
  { name: 'reply root extra field', value: { ...replyInput(submit), caller: 'Main' } },
  { name: 'missing required nullable parent', value: { op: 'convene', mode: 'plan', entries: [entry] } },
  { name: 'undefined required nullable parent', value: { op: 'convene', mode: 'plan', parent: undefined, entries: [entry] } },
  { name: 'missing required nullable adoption', value: { op: 'convene', mode: 'plan', parent: null, entries: [{ issue, target, designOnly: false }] } },
  { name: 'missing required nullable retry note', value: { op: 'reply', ticket: 'work:one', revision: 1, reply: { kind: 'submit', branch: 'delivery/one', head, title: 'Title', body: 'Evidence', template: 'fourLayer' } } },
  { name: 'null optional agenda', value: { op: 'tickets', agenda: null } },
  { name: 'null optional decision issue', value: { op: 'reply', ticket: 'case:one', revision: 1, reply: { kind: 'decision', decision: { kind: 'confirmNoCode', issue: null, bodyHash, reason: 'No change.' } } } },
  { name: 'empty convene entries', value: { op: 'convene', mode: 'plan', parent: null, entries: [] } },
  { name: 'missing ticket prefix', value: { ...replyInput(submit), ticket: 'owner' } },
  { name: 'empty ticket identity', value: { ...replyInput(submit), ticket: 'work:' } },
  { name: 'invalid submission SHA', value: { ...replyInput(submit), reply: { ...submit, head: 'not-a-commit' } } },
  { name: 'invalid source hash', value: { op: 'noCode', member: issue, bodyHash: head, reason: 'No change.' } },
];

function invalidDecision(name: string, decision: unknown): InvalidInput {
  return { name, value: { op: 'reply', ticket: 'case:one', revision: 1, reply: { kind: 'decision', decision } } };
}
const invalidDecisions: InvalidInput[] = [
  invalidDecision('correct has both draft and insertion', { kind: 'correct', draft, insertion: existingInsertion }),
  invalidDecision('correct has neither draft nor insertion', { kind: 'correct' }),
  invalidDecision('existing insertion also carries draft', { kind: 'correctDesign', insertion: { ...existingInsertion, draft }, clauses: ['Clause'] }),
  invalidDecision('draft insertion also carries entry', { kind: 'correctDesign', insertion: { ...draftInsertion, entry }, clauses: ['Clause'] }),
  invalidDecision('existing insertion omits entry', { kind: 'correctDesign', insertion: { kind: 'existing', position: { kind: 'outsideAgenda' } }, clauses: ['Clause'] }),
  invalidDecision('draft insertion omits draft', { kind: 'correctDesign', insertion: { kind: 'draft', position: { kind: 'outsideAgenda' } }, clauses: ['Clause'] }),
  invalidDecision('draft includes another domain shape', { kind: 'outOfScope', draft: { ...draft, issue } }),
  invalidDecision('correctDesign clauses are nonempty', { kind: 'correctDesign', insertion: draftInsertion, clauses: [] }),
  invalidDecision('split insertions are nonempty', { kind: 'split', bodyEdit, insertions: [] }),
  invalidDecision('amend affected members are nonempty', { kind: 'amend', amendment: { kind: 'designGap', affected: [], bodyEdits: [], route: { kind: 'defaultFirst', repo } } }),
  invalidDecision('acceptanceMethod body edits are nonempty', { kind: 'amend', amendment: { kind: 'acceptanceMethod', affected: [issue], bodyEdits: [], transfer: existingInsertion } }),
  invalidDecision('acceptanceMethod transfer cannot be null', { kind: 'amend', amendment: { kind: 'acceptanceMethod', affected: [issue], bodyEdits: [bodyEdit], transfer: null } }),
  invalidDecision('acceptanceMethod transfer cannot be omitted', { kind: 'amend', amendment: { kind: 'acceptanceMethod', affected: [issue], bodyEdits: [bodyEdit] } }),
  invalidDecision('adopted issue cannot carry PR fields', { kind: 'adoptResult', effectId: 'effect-create', result: { kind: 'issue', issue, pr } }),
  invalidDecision('adopted PR cannot carry issue fields', { kind: 'adoptResult', effectId: 'effect-publish', result: { kind: 'pr', pr, issue } }),
  invalidDecision('adopted result tag cannot disagree with its reference', { kind: 'adoptResult', effectId: 'effect-create', result: { kind: 'issue', pr } }),
  invalidDecision('future carrier cannot merge member and draft shapes', { kind: 'amend', amendment: { kind: 'designGap', affected: [issue], bodyEdits: [], route: { kind: 'future', carrier: { ...draft, number: issue.number } } } }),
];

describe('canonical public protocol parsing', () => {
  for (const { name, input } of operations) test(name, () => preserve(input));
  for (const { name, reply, ticket } of replies) test(name, () => preserve(replyInput(reply, ticket)));
  for (const { name, decision } of decisions) {
    test(`Main decision ${name}`, () => preserve(replyInput({ kind: 'decision', decision })));
  }
  for (const condition of conditions) {
    test(`Main decision waitExternal/${condition.kind}`, () => preserve(replyInput({ kind: 'decision', decision: {
      kind: 'waitExternal', condition, reason: 'Wait for the exact named source condition.',
    } })));
  }

  test('inner PortInput is not an outer wrapper and host parameters require exactly one wrapper', () => {
    const input: PortInput = { op: 'tickets', agenda };
    reject(parsePortInput({ input }));
    reject(parseToolParameters(input));
    reject(parseToolParameters({ input: { input } }));
    reject(parseToolParameters({ input, extra: true }));
    reject(parseToolParameters({ input, i: 'Reading roundtable tickets' }));
    reject(parseToolParameters({}));
    reject(parseToolParameters(null));
  });

  for (const { name, value } of [...invalidInputs, ...invalidDecisions]) {
    test(`rejects ${name} at inner and wrapped boundaries`, () => rejectInput(value));
  }

  const invalidReadings: { name: string; readings: unknown }[] = [
    { name: 'zero strings', readings: [] },
    { name: 'one string', readings: ['First reading'] },
    { name: 'three strings', readings: ['First reading', 'Second reading', 'Third reading'] },
    { name: 'non-string first element', readings: [17, 'Second reading'] },
    { name: 'non-string second element', readings: ['First reading', null] },
    { name: 'empty string element', readings: ['First reading', ''] },
    { name: 'non-array value', readings: 'First reading, second reading' },
  ];
  for (const { name, readings } of invalidReadings) {
    test(`question readings rejects ${name} without an escaped transform exception`, () => {
      rejectInput({ op: 'reply', ticket: 'work:owner', revision: 1, reply: {
        kind: 'claim', claim: { kind: 'question', reproduction: 'Reproduction', readings,
          earliestGap: 'Earliest missing clause', proposal: 'Proposed resolution' },
      } });
    });
  }

  const invalidPositiveIntegers = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity];
  for (const value of invalidPositiveIntegers) {
    test(`rejects ${String(value)} as a positive safe revision, issue number or workflow run`, () => {
      rejectInput({ ...replyInput(submit), revision: value });
      rejectInput({ op: 'noCode', member: { ...issue, number: value }, bodyHash, reason: 'No change.' });
      rejectInput(invalidDecision('invalid run', { kind: 'rerun', runId: value }).value);
      rejectInput(invalidDecision('invalid adopted PR number', {
        kind: 'adoptResult', effectId: 'effect-publish', result: { kind: 'pr', pr: { ...pr, number: value } },
      }).value);
    });
  }
  for (const value of [1, Number.MAX_SAFE_INTEGER]) {
    test(`accepts the positive safe integer boundary ${value}`, () => {
      preserve({ ...replyInput(submit), revision: value });
      preserve({ op: 'noCode', member: { ...issue, number: value }, bodyHash, reason: 'No change.' });
      preserve(replyInput({ kind: 'decision', decision: { kind: 'rerun', runId: value } }));
    });
  }

  test('nested invalid reading reports its consumer-visible field, not only the union root', () => {
    const input = { op: 'reply', ticket: 'work:owner', revision: 1, reply: {
      kind: 'claim', claim: { kind: 'question', reproduction: 'Reproduction',
        readings: ['First reading', 17], earliestGap: 'Gap', proposal: 'Resolution' },
    } };
    expect(reject(parsePortInput(input)).path).toBe('reply.claim.readings.1');
    expect(reject(parseToolParameters({ input })).path).toBe('input.reply.claim.readings.1');
  });

  test('deep draft target error identifies the exact nested location', () => {
    const input = invalidDecision('invalid draft target', { kind: 'correctDesign', insertion: {
      kind: 'draft', draft: { ...draft, target: { ...target, repo: { ...repo, name: 17 } } },
      position: { kind: 'correctionOf', unitId: 'unit-original' },
    }, clauses: ['Preserve the design obligation.'] }).value;
    expect(reject(parsePortInput(input)).path).toBe('reply.decision.insertion.draft.target.repo.name');
    expect(reject(parseToolParameters({ input })).path).toBe('input.reply.decision.insertion.draft.target.repo.name');
  });
});
