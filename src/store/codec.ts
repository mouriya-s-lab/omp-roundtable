// Record wire format, hidden markers, HMAC stamps, body hash and acceptance rows. Pure: no IO.
//
// Every machine-readable block is one HTML comment (GitHub renders it invisibly):
//   <!-- omp-roundtable:v1 <kind> <base64url(canonical JSON)> <hmac-sha256 hex over the base64url string> -->

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  canonical,
  fnv64,
  type AgentId,
  type Author,
  type ConvenedEntry,
  type DraftId,
  type Hash,
  type IssueRef,
  type Manifest,
  type NewRecord,
  type ObligationId,
  type PrRef,
  type RecordBody,
  type RecordId,
  type RepoRef,
} from "../core/index.ts";
import type { HmacKey } from "./key.ts";

// ---------------------------------------------------------------- envelope

export type MarkerKind = "record" | "agenda" | "pr" | "applied" | "draft" | "notice";

/** Signed payloads, one per envelope kind. */
export interface RecordPayload {
  readonly agenda: IssueRef;
  readonly author: Author;
  readonly obligation: ObligationId | null;
  readonly idempotencyKey: string;
  readonly manifest: Manifest | null;
  readonly payloadHash: Hash;
  readonly body: RecordBody;
}
export interface AgendaPayload {
  readonly parent: IssueRef | null;
  readonly convened: readonly ConvenedEntry[];
}
export interface PrPayload {
  readonly agenda: IssueRef;
  /** The member the submit delivers: a closing reference GitHub does not parse for a non-default base. */
  readonly member: IssueRef;
  readonly appliedSubmit: RecordId;
}
export interface AppliedPayload {
  readonly decisions: readonly RecordId[];
}
export interface DraftPayload {
  readonly agenda: IssueRef;
  readonly draftId: DraftId;
}
export interface NoticePayload {
  readonly agenda: IssueRef;
  readonly obligation: ObligationId;
}

export type Marker =
  | { readonly kind: "record"; readonly payload: RecordPayload }
  | { readonly kind: "agenda"; readonly payload: AgendaPayload }
  | { readonly kind: "pr"; readonly payload: PrPayload }
  | { readonly kind: "applied"; readonly payload: AppliedPayload }
  | { readonly kind: "draft"; readonly payload: DraftPayload }
  | { readonly kind: "notice"; readonly payload: NoticePayload };

/** One envelope found in a text: either a verified, parsed marker or the reason it was rejected. */
export type Scanned = { readonly ok: true; readonly marker: Marker } | { readonly ok: false; readonly kind: string; readonly reason: string };

/** Any block claiming our namespace, well-formed or not; stripped from visible bodies. */
const ANY_ENVELOPE = /<!--\s*omp-roundtable:v1\b[\s\S]*?-->/g;
const ENVELOPE = /^<!--\s*omp-roundtable:v1\s+([a-z]+)\s+([A-Za-z0-9_-]*)\s+([0-9a-f]*)\s*-->$/;

const hmac = (key: HmacKey, data: string): string => createHmac("sha256", Buffer.from(key, "hex")).update(data).digest("hex");

export function encodeMarker(key: HmacKey, marker: Marker): string {
  const data = Buffer.from(canonical(marker.payload), "utf8").toString("base64url");
  return `<!-- omp-roundtable:v1 ${marker.kind} ${data} ${hmac(key, data)} -->`;
}

/** Verify and parse every envelope in `text`, in order of appearance. */
export function scanMarkers(key: HmacKey, text: string): Scanned[] {
  return (text.match(ANY_ENVELOPE) ?? []).map((block): Scanned => {
    const m = ENVELOPE.exec(block);
    if (m === null) return { ok: false, kind: "?", reason: "malformed envelope" };
    const [, kind = "", data = "", mac = ""] = m;
    const expected = Buffer.from(hmac(key, data), "hex");
    const given = Buffer.from(mac, "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, kind, reason: "signature invalid" };
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    } catch {
      return { ok: false, kind, reason: "payload is not JSON" };
    }
    const marker = parseMarker(kind, json);
    return marker === null ? { ok: false, kind, reason: `payload does not match the ${kind} schema` } : { ok: true, marker };
  });
}

// ---------------------------------------------------------------- payload parsing (signed, so shape checks only)

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function repoOf(v: unknown): RepoRef | null {
  return isObj(v) && isStr(v.owner) && isStr(v.name) ? { owner: v.owner, name: v.name } : null;
}

function issueOf(v: unknown): IssueRef | null {
  if (!isObj(v) || typeof v.number !== "number" || !Number.isInteger(v.number)) return null;
  const repo = repoOf(v.repo);
  return repo === null ? null : { repo, number: v.number };
}

function authorOf(v: unknown): Author | null {
  if (!isObj(v)) return null;
  if (v.kind === "main") return { kind: "main" };
  if (v.kind === "seat" && isStr(v.agentId) && isStr(v.requestName)) return { kind: "seat", agentId: v.agentId as AgentId, requestName: v.requestName };
  return null;
}

function convenedOf(v: unknown): ConvenedEntry | null {
  if (!isObj(v) || typeof v.designOnly !== "boolean" || !isObj(v.target) || !isStr(v.target.base)) return null;
  const issue = issueOf(v.issue);
  const repo = repoOf(v.target.repo);
  const adoptPr: PrRef | null = v.adoptPr === null ? null : issueOf(v.adoptPr);
  if (issue === null || repo === null || (v.adoptPr !== null && adoptPr === null)) return null;
  return { issue, target: { repo, base: v.target.base }, designOnly: v.designOnly, adoptPr };
}

/** The raw envelope blocks of `text` with the kind each claims (unverified), in order; used to carry blocks across a body rewrite. */
export function rawEnvelopes(text: string): { readonly kind: string; readonly block: string }[] {
  return (text.match(ANY_ENVELOPE) ?? []).map((block) => ({ kind: ENVELOPE.exec(block)?.[1] ?? "?", block }));
}

function parseMarker(kind: string, v: unknown): Marker | null {
  if (!isObj(v)) return null;
  switch (kind) {
    case "record": {
      const agenda = issueOf(v.agenda);
      const author = authorOf(v.author);
      const obligation = v.obligation === null || isStr(v.obligation) ? (v.obligation as ObligationId | null) : undefined;
      if (agenda === null || author === null || obligation === undefined || !isStr(v.idempotencyKey) || !isStr(v.payloadHash)) return null;
      if (!isObj(v.body) || !isStr(v.body.kind) || !(v.manifest === null || isObj(v.manifest))) return null;
      // The body was serialized by writeRecord from a typed NewRecord and is covered by the stamp.
      const body = v.body as unknown as RecordBody;
      return {
        kind,
        payload: { agenda, author, obligation, idempotencyKey: v.idempotencyKey, manifest: v.manifest as Manifest | null, payloadHash: v.payloadHash as Hash, body },
      };
    }
    case "agenda": {
      const parent = v.parent === null ? null : issueOf(v.parent);
      if ((v.parent !== null && parent === null) || !Array.isArray(v.convened)) return null;
      const convened = v.convened.map(convenedOf);
      if (convened.some((c) => c === null)) return null;
      return { kind, payload: { parent, convened: convened as ConvenedEntry[] } };
    }
    case "pr": {
      const agenda = issueOf(v.agenda);
      const member = issueOf(v.member);
      return agenda !== null && member !== null && isStr(v.appliedSubmit) ? { kind, payload: { agenda, member, appliedSubmit: v.appliedSubmit as RecordId } } : null;
    }
    case "applied":
      return Array.isArray(v.decisions) && v.decisions.every(isStr) ? { kind, payload: { decisions: v.decisions as RecordId[] } } : null;
    case "draft": {
      const agenda = issueOf(v.agenda);
      return agenda !== null && isStr(v.draftId) ? { kind, payload: { agenda, draftId: v.draftId as DraftId } } : null;
    }
    case "notice": {
      const agenda = issueOf(v.agenda);
      return agenda !== null && isStr(v.obligation) ? { kind, payload: { agenda, obligation: v.obligation as ObligationId } } : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- bodies

/** The body a reader sees: every `omp-roundtable:v1` block removed, CRLF → LF, trailing whitespace trimmed. */
export function visibleBody(body: string): string {
  return body.replace(ANY_ENVELOPE, "").replace(/\r\n/g, "\n").trimEnd();
}

/** core.md §1 正文哈希; `BodyReplacement.baseHash` is compared with this same function. */
export function bodyHash(body: string): Hash {
  return fnv64(visibleBody(body));
}

/** `visible` followed by the given hidden blocks (one per line). */
export function withMarkers(visible: string, blocks: readonly string[]): string {
  return blocks.length === 0 ? visible : `${visible.trimEnd()}\n\n${blocks.join("\n")}\n`;
}

/**
 * Row ids of the first markdown table under `## 验收标准` (child) or `## 关闭验证` (parent):
 * `<owner>/<repo>#<issue>/<first-column integer>`. Rows whose first cell is not an integer are not rows.
 */
export function acceptanceRows(issue: IssueRef, body: string): string[] {
  const lines = visibleBody(body).split("\n");
  let inSection = false;
  let inFence = false;
  let inTable = false;
  const rows: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) inFence = !inFence;
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading !== null) {
      if (inTable) break;
      const level = heading[1]?.length ?? 0;
      if (level === 2 && (heading[2] === "验收标准" || heading[2] === "关闭验证")) inSection = true;
      else if (inSection && level <= 2) inSection = false;
      continue;
    }
    if (!inSection) continue;
    if (line.startsWith("|")) {
      inTable = true;
      const first = line.slice(1).split("|")[0]?.trim() ?? "";
      if (/^\d+$/.test(first)) rows.push(`${issue.repo.owner}/${issue.repo.name}#${issue.number}/${Number(first)}`);
    } else if (inTable) {
      break;
    }
  }
  return rows;
}

// ---------------------------------------------------------------- record comments

/** Neutralize anything that could open or close an HTML comment inside the visible summary. */
const safe = (text: string): string => text.replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");

const ref = (r: IssueRef): string => `${r.repo.owner}/${r.repo.name}#${r.number}`;

function summary(record: NewRecord, author: Author): string {
  const who = author.kind === "main" ? "主会话" : `席位 \`${safe(author.requestName)}\`（\`${safe(author.agentId)}\`）`;
  const ticket = record.obligation === null ? "" : ` · 票据 \`${record.obligation}\``;
  const head = `**omp-roundtable 记录** · ${who}${ticket}`;
  const b = record.body;
  switch (b.kind) {
    case "prSubmit":
      return `${head}\n\n提交 PR：${ref(b.member)} · 分支 \`${safe(b.branch)}\` · head \`${b.head}\`\n\n> ${safe(b.title)}`;
    case "claim": {
      const c = b.claim;
      const target = c.kind === "question" ? `context \`${c.context.kind}\`` : ref(c.member);
      return `${head}\n\n主张 \`${c.kind}\`：${target}`;
    }
    case "verdict": {
      const v = b.verdict;
      const rows = "rows" in v ? ` · 验收行 ${v.rows.filter((r) => r.pass).length}/${v.rows.length} 通过` : "";
      const findings = "findings" in v ? ` · 发现 ${v.findings.length}` : "";
      return `${head}\n\n结论 \`${v.gate}\`${rows}${findings}`;
    }
    case "decision": {
      const d = b.decision;
      const verdict = "verdict" in d ? ` · \`${typeof d.verdict === "string" ? d.verdict : d.verdict.kind}\`` : "";
      const extras = [
        b.drafts.length > 0 ? `草稿 ${b.drafts.length}` : "",
        b.bodyReplacements.length > 0 ? `正文替换：${b.bodyReplacements.map((r) => ref(r.issue)).join("、")}` : "",
      ].filter((s) => s !== "");
      const rationale = b.rationale.trim() === "" ? "" : `\n\n${safe(b.rationale).split("\n").map((l) => `> ${l}`).join("\n")}`;
      return `${head}\n\n裁定 \`${d.subject}\`${verdict}${extras.length > 0 ? ` · ${extras.join(" · ")}` : ""}${rationale}`;
    }
    default:
      return assertNever(b);
  }
}

/** The full comment body for a record: readable summary plus exactly one signed `record` block. */
export function encodeRecordComment(key: HmacKey, agenda: IssueRef, record: NewRecord, author: Author): string {
  const payload: RecordPayload = {
    agenda,
    author,
    obligation: record.obligation,
    idempotencyKey: record.idempotencyKey,
    manifest: record.manifest,
    payloadHash: record.payloadHash,
    body: record.body,
  };
  return withMarkers(summary(record, author), [encodeMarker(key, { kind: "record", payload })]);
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
