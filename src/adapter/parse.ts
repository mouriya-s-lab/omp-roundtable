// Boundary parsing of port payloads (C2): every reply, convene and resume input is parsed into core types here, strictly
// (unknown keys are errors), so core only sees well-formed values.

import type {
  AgendaId,
  AgentId,
  Anchor,
  BodyReplacement,
  Claim,
  Context,
  ConvenedEntry,
  Decision,
  DeliveryTarget,
  Draft,
  EventId,
  FindingVerdict,
  Hash,
  IssueRef,
  Millis,
  ObligationId,
  PrRef,
  ReplyId,
  RepoRef,
  Reply,
  Route,
  Sha,
} from "../core/index.ts";

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface ConveneInput {
  readonly mode: "plan" | "execute";
  readonly parent: IssueRef | null;
  readonly entries: readonly ConvenedEntry[];
}

export interface ResumeInput {
  readonly agenda: AgendaId;
  readonly operatorConfirmedOriginalSessionEnded: true;
}

class ParseFailure extends Error {}

function fail(path: string, expectation: string): never {
  throw new ParseFailure(`${path}: ${expectation}`);
}

function assertNever(value: never): never {
  throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

function parsed<T>(parse: () => T): Parsed<T> {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, error: error.message };
    throw error;
  }
}

/** Strict object: only the listed keys may appear; each field is then parsed by its own parser. */
function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected object");
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!keys.includes(key)) fail(`${path}.${key}`, "unknown key");
  }
  return o;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected string");
  return value;
}

function nonempty(value: unknown, path: string): string {
  const result = string(value, path);
  if (result.length === 0) fail(path, "expected non-empty string");
  return result;
}

function choice<const T extends string>(value: unknown, path: string, options: readonly T[]): T {
  const result = options.find((option) => option === value);
  if (result === undefined) fail(path, `expected ${options.map((option) => JSON.stringify(option)).join(" | ")}`);
  return result;
}

function integer(value: unknown, path: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    fail(path, `expected ${minimum === 0 ? "non-negative" : "positive"} integer`);
  }
  return value;
}

function array<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T): readonly T[] {
  if (!Array.isArray(value)) fail(path, "expected array");
  return value.map((item: unknown, index: number) => parse(item, `${path}[${index}]`));
}

function nullable<T>(value: unknown, path: string, parse: (value: unknown, path: string) => T): T | null {
  return value === null ? null : parse(value, path);
}

function optional<T>(object: Record<string, unknown>, key: string, path: string, fallback: T, parse: (value: unknown, path: string) => T): T {
  return Object.hasOwn(object, key) ? parse(object[key], `${path}.${key}`) : fallback;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected boolean");
  return value;
}

function repo(value: unknown, path: string): RepoRef {
  const o = record(value, path, ["owner", "name"]);
  return { owner: nonempty(o.owner, `${path}.owner`), name: nonempty(o.name, `${path}.name`) };
}

function issue(value: unknown, path: string): IssueRef {
  const o = record(value, path, ["repo", "number"]);
  return { repo: repo(o.repo, `${path}.repo`), number: integer(o.number, `${path}.number`, 1) };
}

function pr(value: unknown, path: string): PrRef {
  const o = record(value, path, ["repo", "number"]);
  return { repo: repo(o.repo, `${path}.repo`), number: integer(o.number, `${path}.number`, 1) };
}

function sha(value: unknown, path: string): Sha {
  const result = string(value, path);
  if (!/^[0-9a-f]{40}$/.test(result)) fail(path, "expected 40 lowercase hexadecimal characters (SHA)");
  return result as Sha;
}

function obligation(value: unknown, path: string): ObligationId {
  const result = string(value, path);
  if (!/^ob-[0-9a-f]{16}$/.test(result)) fail(path, "expected ob- followed by 16 lowercase hexadecimal characters");
  return result as ObligationId;
}

function replyId(value: unknown, path: string): ReplyId {
  const result = string(value, path);
  if (!/^re-[0-9a-f]{16}$/.test(result)) fail(path, "expected re- followed by 16 lowercase hexadecimal characters (the id shown in the brief)");
  return result as ReplyId;
}

function hash(value: unknown, path: string): Hash {
  return nonempty(value, path) as Hash;
}
function eventId(value: unknown, path: string): EventId {
  return nonempty(value, path) as EventId;
}
function agentId(value: unknown, path: string): AgentId {
  return nonempty(value, path) as AgentId;
}
function millis(value: unknown, path: string): Millis {
  return integer(value, path, 0) as Millis;
}

function target(value: unknown, path: string): DeliveryTarget {
  const o = record(value, path, ["repo", "base"]);
  return { repo: repo(o.repo, `${path}.repo`), base: string(o.base, `${path}.base`) };
}

function anchor(value: unknown, path: string): Anchor {
  const o = record(value, path, ["kind", "entry"]);
  const kind = choice(o.kind, `${path}.kind`, ["before", "after", "correctionOf", "outsideAgenda"]);
  switch (kind) {
    case "before":
    case "after":
    case "correctionOf":
      return { kind, entry: issue(o.entry, `${path}.entry`) };
    case "outsideAgenda":
      record(value, path, ["kind"]);
      return { kind };
    default:
      return assertNever(kind);
  }
}

function draft(value: unknown, path: string): Draft {
  const o = record(value, path, ["index", "repo", "title", "body", "anchor", "target", "designOnly"]);
  return {
    index: integer(o.index, `${path}.index`, 0),
    repo: repo(o.repo, `${path}.repo`),
    title: string(o.title, `${path}.title`),
    body: string(o.body, `${path}.body`),
    anchor: anchor(o.anchor, `${path}.anchor`),
    target: target(o.target, `${path}.target`),
    designOnly: boolean(o.designOnly, `${path}.designOnly`),
  };
}

function bodyReplacement(value: unknown, path: string): BodyReplacement {
  const o = record(value, path, ["issue", "baseHash", "body"]);
  return { issue: issue(o.issue, `${path}.issue`), baseHash: hash(o.baseHash, `${path}.baseHash`), body: string(o.body, `${path}.body`) };
}

function route(value: unknown, path: string): Route {
  const o = record(value, path, ["kind", "commit", "migration", "designBranch", "carrier"]);
  const kind = choice(o.kind, `${path}.kind`, ["defaultFirst", "withPr", "future"]);
  switch (kind) {
    case "defaultFirst":
      record(value, path, ["kind", "commit", "migration"]);
      return { kind, commit: sha(o.commit, `${path}.commit`), migration: nullable(o.migration, `${path}.migration`, issue) };
    case "withPr":
      record(value, path, ["kind", "commit", "designBranch"]);
      return { kind, commit: sha(o.commit, `${path}.commit`), designBranch: string(o.designBranch, `${path}.designBranch`) };
    case "future":
      record(value, path, ["kind", "commit", "carrier"]);
      return { kind, commit: sha(o.commit, `${path}.commit`), carrier: issue(o.carrier, `${path}.carrier`) };
    default:
      return assertNever(kind);
  }
}

function context(value: unknown, path: string): Context {
  const o = record(value, path, ["kind", "member", "unit"]);
  const kind = choice(o.kind, `${path}.kind`, ["member", "unitVerification", "agendaClosure"]);
  switch (kind) {
    case "member":
      record(value, path, ["kind", "member"]);
      return { kind, member: issue(o.member, `${path}.member`) };
    case "unitVerification":
      record(value, path, ["kind", "unit"]);
      return { kind, unit: issue(o.unit, `${path}.unit`) };
    case "agendaClosure":
      record(value, path, ["kind"]);
      return { kind };
    default:
      return assertNever(kind);
  }
}

function claim(value: unknown, path: string): Claim {
  const o = record(value, path, ["kind", "context", "reproduction", "readings", "earliestGap", "proposal", "member", "evidence", "category", "attempts"]);
  const kind = choice(o.kind, `${path}.kind`, ["question", "noCode", "split", "blocked"]);
  switch (kind) {
    case "question": {
      record(value, path, ["kind", "context", "reproduction", "readings", "earliestGap", "proposal"]);
      if (!Array.isArray(o.readings) || o.readings.length !== 2) fail(`${path}.readings`, "expected two strings");
      return {
        kind,
        context: context(o.context, `${path}.context`),
        reproduction: string(o.reproduction, `${path}.reproduction`),
        readings: [string(o.readings[0], `${path}.readings[0]`), string(o.readings[1], `${path}.readings[1]`)],
        earliestGap: string(o.earliestGap, `${path}.earliestGap`),
        proposal: string(o.proposal, `${path}.proposal`),
      };
    }
    case "noCode":
      record(value, path, ["kind", "member", "evidence"]);
      return { kind, member: issue(o.member, `${path}.member`), evidence: string(o.evidence, `${path}.evidence`) };
    case "split":
      record(value, path, ["kind", "member", "proposal"]);
      return { kind, member: issue(o.member, `${path}.member`), proposal: string(o.proposal, `${path}.proposal`) };
    case "blocked":
      record(value, path, ["kind", "member", "category", "attempts"]);
      return { kind, member: issue(o.member, `${path}.member`), category: string(o.category, `${path}.category`), attempts: string(o.attempts, `${path}.attempts`) };
    default:
      return assertNever(kind);
  }
}

function findingVerdict(value: unknown, path: string): FindingVerdict {
  const o = record(value, path, ["kind", "responsible", "basis", "draft", "route"]);
  const kind = choice(o.kind, `${path}.kind`, ["upheld", "rejected", "outOfScope", "designGap", "acceptanceMethod"]);
  switch (kind) {
    case "upheld":
      record(value, path, ["kind", "responsible"]);
      return { kind, responsible: choice(o.responsible, `${path}.responsible`, ["owner", "main"]) };
    case "rejected":
      record(value, path, ["kind", "basis"]);
      return { kind, basis: string(o.basis, `${path}.basis`) };
    case "outOfScope":
      record(value, path, ["kind", "draft"]);
      return { kind, draft: draft(o.draft, `${path}.draft`) };
    case "designGap":
      record(value, path, ["kind", "route"]);
      return { kind, route: route(o.route, `${path}.route`) };
    case "acceptanceMethod":
      record(value, path, ["kind"]);
      return { kind };
    default:
      return assertNever(kind);
  }
}

function questionVerdict(value: unknown, path: string): Extract<Decision, { subject: "question" }>["verdict"] {
  const o = record(value, path, ["kind", "route"]);
  const kind = choice(o.kind, `${path}.kind`, ["answered", "outOfDomain", "implDefect", "acceptanceMethod", "designGap"]);
  switch (kind) {
    case "answered":
    case "outOfDomain":
    case "implDefect":
    case "acceptanceMethod":
      record(value, path, ["kind"]);
      return { kind };
    case "designGap":
      record(value, path, ["kind", "route"]);
      return { kind, route: route(o.route, `${path}.route`) };
    default:
      return assertNever(kind);
  }
}

const DECISION_KEYS = [
  "subject", "claim", "verdict", "affected", "member", "bodyHash", "verdictId", "event", "pr", "runId", "key",
  "effect", "failedAt", "commit", "summary", "reason", "requestName", "previous", "agentId",
];

function decision(value: unknown, path: string): Decision {
  const o = record(value, path, DECISION_KEYS);
  const subject = choice(o.subject, `${path}.subject`, [
    "question", "noCodeClaim", "splitClaim", "blockedClaim", "findings", "closed", "reopened", "checks", "postMergeFail", "closureFail",
    "orphanDesign", "migration", "agendaGap", "stall", "effectFailed", "designFix", "report", "noCode", "seated",
  ]);
  switch (subject) {
    case "question":
      record(value, path, ["subject", "claim", "verdict", "affected"]);
      return { subject, claim: replyId(o.claim, `${path}.claim`), verdict: questionVerdict(o.verdict, `${path}.verdict`), affected: array(o.affected, `${path}.affected`, issue) };
    case "noCodeClaim":
    case "splitClaim":
      record(value, path, ["subject", "claim", "member", "bodyHash", "verdict"]);
      return {
        subject,
        claim: replyId(o.claim, `${path}.claim`),
        member: issue(o.member, `${path}.member`),
        bodyHash: hash(o.bodyHash, `${path}.bodyHash`),
        verdict: choice(o.verdict, `${path}.verdict`, ["confirmed", "refuted"]),
      };
    case "blockedClaim":
      record(value, path, ["subject", "claim", "verdict"]);
      return { subject, claim: replyId(o.claim, `${path}.claim`), verdict: choice(o.verdict, `${path}.verdict`, ["replacePr", "external", "refuted"]) };
    case "findings":
      record(value, path, ["subject", "verdictId", "verdict"]);
      return { subject, verdictId: replyId(o.verdictId, `${path}.verdictId`), verdict: findingVerdict(o.verdict, `${path}.verdict`) };
    case "closed":
      record(value, path, ["subject", "member", "event", "bodyHash", "verdict"]);
      return {
        subject,
        member: issue(o.member, `${path}.member`),
        event: eventId(o.event, `${path}.event`),
        bodyHash: hash(o.bodyHash, `${path}.bodyHash`),
        verdict: choice(o.verdict, `${path}.verdict`, ["confirmedNoCode", "reopen"]),
      };
    case "reopened":
      record(value, path, ["subject", "member", "event", "verdict"]);
      return { subject, member: issue(o.member, `${path}.member`), event: eventId(o.event, `${path}.event`), verdict: choice(o.verdict, `${path}.verdict`, ["restore", "correction", "reopenAccepted"]) };
    case "checks":
      record(value, path, ["subject", "pr", "runId", "verdict"]);
      return { subject, pr: pr(o.pr, `${path}.pr`), runId: string(o.runId, `${path}.runId`), verdict: choice(o.verdict, `${path}.verdict`, ["rerun", "fixNeeded", "external"]) };
    case "postMergeFail":
    case "closureFail":
      record(value, path, ["subject", "verdictId", "verdict"]);
      return { subject, verdictId: replyId(o.verdictId, `${path}.verdictId`), verdict: choice(o.verdict, `${path}.verdict`, ["correction", "reverify"]) };
    case "orphanDesign":
    case "migration":
    case "agendaGap":
    case "stall":
      record(value, path, ["subject", "key", "verdict"]);
      return { subject, key: hash(o.key, `${path}.key`), verdict: choice(o.verdict, `${path}.verdict`, ["resolved", "external"]) };
    case "effectFailed":
      record(value, path, ["subject", "effect", "failedAt", "verdict"]);
      return { subject, effect: obligation(o.effect, `${path}.effect`), failedAt: millis(o.failedAt, `${path}.failedAt`), verdict: choice(o.verdict, `${path}.verdict`, ["retry", "external"]) };
    case "designFix":
      record(value, path, ["subject", "verdictId", "commit"]);
      return { subject, verdictId: replyId(o.verdictId, `${path}.verdictId`), commit: sha(o.commit, `${path}.commit`) };
    case "report":
      record(value, path, ["subject", "summary"]);
      return { subject, summary: string(o.summary, `${path}.summary`) };
    case "noCode":
      record(value, path, ["subject", "member", "bodyHash", "reason"]);
      return { subject, member: issue(o.member, `${path}.member`), bodyHash: hash(o.bodyHash, `${path}.bodyHash`), reason: string(o.reason, `${path}.reason`) };
    case "seated":
      record(value, path, ["subject", "requestName", "previous", "agentId"]);
      return { subject, requestName: string(o.requestName, `${path}.requestName`), previous: nullable(o.previous, `${path}.previous`, agentId), agentId: agentId(o.agentId, `${path}.agentId`) };
    default:
      return assertNever(subject);
  }
}

export function parseReply(ticket: unknown, reply: unknown): Parsed<Reply> {
  return parsed(() => {
    const o = record(reply, "reply", ["kind", "branch", "head", "title", "body", "template", "retryNote", "claim", "ok", "note", "decision", "rationale", "drafts", "bodyReplacements"]);
    const kind = choice(o.kind, "reply.kind", ["prSubmit", "claim", "verdict", "decision"]);
    const ticketId = ticket === null ? null : obligation(ticket, "ticket");
    switch (kind) {
      case "prSubmit":
        record(reply, "reply", ["kind", "branch", "head", "title", "body", "template", "retryNote"]);
        if (ticketId === null) fail("ticket", "obligation id required for prSubmit");
        return {
          kind,
          obligation: ticketId,
          branch: string(o.branch, "reply.branch"),
          head: sha(o.head, "reply.head"),
          title: string(o.title, "reply.title"),
          body: string(o.body, "reply.body"),
          template: choice(o.template, "reply.template", ["fourLayer", "docOnly"]),
          retryNote: optional(o, "retryNote", "reply", null, (v, p) => nullable(v, p, string)),
        };
      case "claim":
        record(reply, "reply", ["kind", "claim"]);
        if (ticketId === null) fail("ticket", "obligation id required for claim");
        return { kind, obligation: ticketId, claim: claim(o.claim, "reply.claim") };
      case "verdict":
        record(reply, "reply", ["kind", "ok", "note"]);
        if (ticketId === null) fail("ticket", "obligation id required for verdict");
        return { kind, obligation: ticketId, ok: boolean(o.ok, "reply.ok"), note: string(o.note, "reply.note") };
      case "decision": {
        record(reply, "reply", ["kind", "decision", "rationale", "drafts", "bodyReplacements"]);
        const d = decision(o.decision, "reply.decision");
        if (ticketId === null && d.subject !== "noCode") fail("ticket", "null allowed only for an unsolicited noCode decision");
        return {
          kind,
          obligation: ticketId,
          decision: d,
          rationale: string(o.rationale, "reply.rationale"),
          drafts: optional(o, "drafts", "reply", [], (v, p) => array(v, p, draft)),
          bodyReplacements: optional(o, "bodyReplacements", "reply", [], (v, p) => array(v, p, bodyReplacement)),
        };
      }
      default:
        return assertNever(kind);
    }
  });
}

function repoString(value: unknown, path: string): RepoRef {
  const text = string(value, path);
  const match = /^([^/\s#]+)\/([^/\s#]+)$/.exec(text);
  if (!match || !match[1] || !match[2]) fail(path, "expected owner/name");
  return { owner: match[1], name: match[2] };
}

function referenceString(value: unknown, path: string): IssueRef {
  const text = string(value, path);
  const match = /^([^/\s#]+)\/([^/\s#]+)#([1-9][0-9]*)$/.exec(text);
  if (!match || !match[1] || !match[2] || !match[3]) fail(path, "expected owner/name#N with a positive issue number");
  return { repo: { owner: match[1], name: match[2] }, number: integer(Number(match[3]), path, 1) };
}

function convenedEntry(value: unknown, path: string): ConvenedEntry {
  const o = record(value, path, ["issue", "target", "designOnly", "adoptPr"]);
  const t = record(o.target, `${path}.target`, ["repo", "base"]);
  return {
    issue: referenceString(o.issue, `${path}.issue`),
    target: { repo: repoString(t.repo, `${path}.target.repo`), base: nonempty(t.base, `${path}.target.base`) },
    designOnly: optional(o, "designOnly", path, false, boolean),
    adoptPr: optional(o, "adoptPr", path, null, (v, p) => nullable(v, p, referenceString)),
  };
}

export function parseConvene(input: unknown): Parsed<ConveneInput> {
  return parsed(() => {
    const o = record(input, "input", ["mode", "parent", "entries"]);
    const entries = array(o.entries, "input.entries", convenedEntry);
    if (entries.length === 0) fail("input.entries", "expected at least one entry");
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const key = `${entry.issue.repo.owner}/${entry.issue.repo.name}#${entry.issue.number}`;
      if (seen.has(key)) fail(`input.entries[${index}].issue`, "duplicate issue");
      seen.add(key);
    });
    return { mode: choice(o.mode, "input.mode", ["plan", "execute"]), parent: nullable(o.parent, "input.parent", referenceString), entries };
  });
}

export function parseResume(input: unknown): Parsed<ResumeInput> {
  return parsed(() => {
    const o = record(input, "input", ["agenda", "operatorConfirmedOriginalSessionEnded"]);
    if (o.operatorConfirmedOriginalSessionEnded !== true) {
      fail("input.operatorConfirmedOriginalSessionEnded", "operator must confirm the original session has ended (所有权阻塞)");
    }
    const agenda = string(o.agenda, "input.agenda");
    if (!/^ag-[0-9a-z-]+$/.test(agenda)) fail("input.agenda", "expected the agenda id returned by convene (ag-…)");
    return { agenda: agenda as AgendaId, operatorConfirmedOriginalSessionEnded: true };
  });
}
