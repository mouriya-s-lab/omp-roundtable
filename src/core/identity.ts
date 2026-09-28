// Deterministic identities: obligation ids, request names, work directories (core.md §3 义务、席位名).
// Pure: no host crypto, so core stays host-independent and enumerable.

import type { Hash, IssueRef, ObligationId, RepoRef } from "./types.ts";

/** Stable serialization of plain data: object keys sorted, no whitespace. */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v: unknown) => canonical(v)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  throw new Error(`canonical: unsupported value of type ${typeof value}`);
}

/** FNV-1a 64-bit over UTF-16 code units, hex. Collision resistance is sufficient for identity within one agenda. */
export function fnv64(text: string): Hash {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0") as Hash;
}

export function obligationId(kind: string, context: unknown, pin: unknown, attempt: number): ObligationId {
  return `ob-${fnv64(canonical({ kind, context, pin, attempt }))}` as ObligationId;
}

const slug = (repo: RepoRef): string =>
  `${repo.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16);

export type SeatRole = "owner" | "review" | "accept" | "postMerge" | "closure";

/**
 * Request name: `[a-z0-9-]`, at most 44 chars so the registry's `-N` suffix fits in 48.
 * Gate names end with `-h<hash>-a<attempt>`; the letter prefixes keep a trailing `-\d+` unambiguous.
 */
export function requestName(role: SeatRole, issue: IssueRef, pinHash: Hash | null, attempt: number): string {
  const base = `rt-${slug(issue.repo)}-${issue.number}`;
  if (role === "owner") return `${base}-owner`;
  const short = (pinHash ?? "0").slice(0, 8);
  return `${base}-${role.toLowerCase()}-h${short}-a${attempt}`;
}

/** Strip the registry's duplicate suffix (`-2`, `-3`, ...). */
export function stripSuffix(agentId: string): string {
  return agentId.replace(/-\d+$/, "");
}

export function workDir(issue: IssueRef, name: string): string {
  return `/tmp/omp-roundtable/${issue.repo.owner}-${issue.repo.name}-${issue.number}/${name}`;
}

export function issueKey(issue: IssueRef): string {
  return `${issue.repo.owner}/${issue.repo.name}#${issue.number}`;
}

export function sameIssue(a: IssueRef, b: IssueRef): boolean {
  return a.number === b.number && a.repo.owner === b.repo.owner && a.repo.name === b.repo.name;
}
