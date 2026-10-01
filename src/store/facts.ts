// readFacts: the GitHub facts one derivation round needs (core.md §1 Facts), from one `facts` request plus commit
// containment answered from an immutable cache (omp-roundtable.md Q7). Nothing here is stored beyond the round.

import { bodyHash, computeUnits, type AgendaState, type Facts, type IssueFact, type IssueRef, type PrFact, type PrLink, type PrRef, type RepoRef, type Sha } from "../core/index.ts";
import type { FactsRequest, GitHub, IssueRaw, PrLinkRaw, PrRaw } from "./github.ts";
import type { StoreResult } from "./index.ts";

/** A commit pair the core reads: does `descendant` contain `ancestor` in `repo`. */
export interface CommitPair {
  readonly repo: RepoRef;
  readonly ancestor: Sha;
  readonly descendant: Sha;
}

/**
 * Near copy of GitHub's commit ancestry (source: `GitHub.contains`). Inputs are immutable sha pairs, so an entry
 * never goes stale and is never invalidated; it only saves repeated compare calls.
 */
export class ContainsCache {
  private readonly known = new Map<string, boolean>();

  async get(gh: GitHub, p: CommitPair): Promise<boolean> {
    if (p.ancestor === p.descendant) return true;
    const key = `${p.repo.owner}/${p.repo.name}|${p.ancestor}|${p.descendant}`;
    const hit = this.known.get(key);
    if (hit !== undefined) return hit;
    const value = await gh.contains(p.repo, p.ancestor, p.descendant);
    this.known.set(key, value);
    return value;
  }
}

const repoKey = (r: RepoRef): string => `${r.owner}/${r.name}`;
const refKey = (r: IssueRef | PrRef): string => `${r.repo.owner}/${r.repo.name}#${r.number}`;

function uniqueBy<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const i of items) if (!seen.has(key(i))) seen.set(key(i), i);
  return [...seen.values()];
}

/** What one round reads: the agenda's issues, its parent tree, its registered PRs, and the delivery branches. */
export function factsRequest(state: AgendaState): FactsRequest {
  const units = computeUnits(state);
  const entries = units.flatMap((u) => u.members);
  const migrations = state.contracts.flatMap((c) => c.routes.flatMap((r) => (r.route.kind === "defaultFirst" && r.route.migration !== null ? [r.route.migration] : [])));
  const targets = uniqueBy(
    [...entries.map((e) => e.target), ...state.drafts.map((d) => d.draft.target)],
    (t) => `${repoKey(t.repo)}@${t.base}`,
  );
  return {
    issues: uniqueBy([...entries.map((e) => e.issue), ...migrations], refKey),
    parent: state.parent,
    prs: uniqueBy([...state.members.flatMap((m) => m.prs), ...state.convened.flatMap((c) => (c.adoptPr === null ? [] : [c.adoptPr]))], refKey),
    branches: targets.map((t) => ({ repo: t.repo, branch: t.base })),
    repos: uniqueBy(targets.map((t) => t.repo), repoKey),
  };
}

const issueFact = (raw: IssueRaw): IssueFact => ({
  ref: raw.ref,
  open: raw.open,
  events: raw.events,
  bodyHash: bodyHash(raw.body),
  children: raw.children,
});

const linkFact = (raw: PrLinkRaw): PrLink => ({
  ref: raw.ref,
  state: raw.state,
  headBranch: raw.headRef,
  head: raw.head,
  target: { repo: raw.baseRepo, base: raw.base },
  closes: raw.closes,
});

export const prFact = (raw: PrRaw): PrFact => ({
  ...linkFact(raw),
  bodyHash: bodyHash(raw.body),
  mergeable: raw.mergeable,
  checks: raw.checks.kind === "rollup" ? raw.checks.fact : { state: raw.checks.requiresChecks ? "pending" : "pass", failedRunId: null },
});

/** Design commits the state refers to: route commits and designFix commits. */
function designCommits(state: AgendaState): Sha[] {
  return [...new Set([...state.contracts.flatMap((c) => c.routes.map((r) => r.route.commit)), ...state.members.flatMap((m) => m.designFixes.map((d) => d.commit))])];
}

/** One link per PR; a PR listed under several issues closes each of them. */
function mergeLinks(raw: readonly PrLinkRaw[]): PrLinkRaw[] {
  const byRef = new Map<string, PrLinkRaw>();
  for (const l of raw) {
    const seen = byRef.get(refKey(l.ref));
    byRef.set(refKey(l.ref), seen === undefined ? l : { ...seen, closes: uniqueBy([...seen.closes, ...l.closes], refKey) });
  }
  return [...byRef.values()];
}

/** One round of facts: one `facts` request, plus containment of design commits answered from the cache. */
export async function readFacts(gh: GitHub, cache: ContainsCache, state: AgendaState): Promise<StoreResult<Facts>> {
  try {
    const request = factsRequest(state);
    const raw = await gh.facts(request);
    const prs = uniqueBy(raw.prs, (p) => refKey(p.ref)).map(prFact);
    const links = mergeLinks(raw.links).map(linkFact);
    const design = designCommits(state);
    const onDefault: { repo: RepoRef; sha: Sha }[] = [];
    for (const d of raw.defaultHeads)
      for (const sha of design) if (await cache.get(gh, { repo: d.repo, ancestor: sha, descendant: d.head })) onDefault.push({ repo: d.repo, sha });
    const open = uniqueBy([...prs, ...links], (p) => refKey(p.ref)).filter((p) => p.state.kind === "open");
    const pairs: CommitPair[] = open.flatMap((p) => design.map((sha) => ({ repo: p.target.repo, ancestor: sha, descendant: p.head })));
    const contains: CommitPair[] = [];
    for (const p of uniqueBy(pairs, (x) => `${repoKey(x.repo)}|${x.ancestor}|${x.descendant}`)) if (await cache.get(gh, p)) contains.push(p);
    return {
      ok: true,
      value: {
        issues: raw.issues.map(issueFact),
        prs,
        links,
        commits: {
          onDefault,
          contains,
          baseHead: raw.branches.flatMap((b) => (b.head === null ? [] : [{ repo: b.repo, base: b.branch, sha: b.head }])),
        },
      },
    };
  } catch (err) {
    return { ok: false, error: { kind: "read", detail: err instanceof Error ? err.message : String(err) } };
  }
}
