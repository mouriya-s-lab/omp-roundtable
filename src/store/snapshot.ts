// readSnapshot: assemble a core Snapshot from Source reads plus the codec. Shared by both backends.
// Any failed read voids the whole read (crash matrix row 12); stamps that fail verification become diagnostics.

import {
  type Agenda,
  type ChecksFact,
  type CommitFacts,
  type Decision,
  type Draft,
  type IssueFact,
  type IssueRef,
  type ObligationId,
  type PrFact,
  type PrRef,
  type RecordBody,
  type RecordId,
  type RepoRef,
  type Sha,
  type Snapshot,
  type StoredRecord,
} from "../core/index.ts";
import { acceptanceRows, bodyHash, scanMarkers, type AgendaPayload, type Scanned } from "./codec.ts";
import type { Diagnostic, StoreResult } from "./index.ts";
import type { HmacKey } from "./key.ts";
import type { IssueRaw, PrRaw, Source } from "./source.ts";

export const refKey = (r: { readonly repo: RepoRef; readonly number: number }): string => `${r.repo.owner}/${r.repo.name}#${r.number}`;
const repoKey = (r: RepoRef): string => `${r.owner}/${r.name}`;
export const sameRef = (a: IssueRef, b: IssueRef): boolean => refKey(a) === refKey(b);

/** Bounded fan-out so a large agenda does not spawn hundreds of `gh` processes at once; results keep input order. */
export async function mapLimit<T, U>(items: readonly T[], limit: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out = new Array<U>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const FANOUT = 8;

export type AgendaRead =
  | { readonly kind: "ok"; readonly raw: IssueRaw; readonly payload: AgendaPayload }
  | { readonly kind: "keyMismatch"; readonly detail: string }
  | { readonly kind: "notAgenda"; readonly detail: string };

/** The agenda issue and its own signed `agenda` marker. A stamp that fails verification means the key is not the agenda's key. */
export async function readAgenda(source: Source, key: HmacKey, agenda: IssueRef): Promise<AgendaRead> {
  const raw = await source.issue(agenda);
  const scanned = scanMarkers(key, raw.body);
  const valid = scanned.flatMap((s) => (s.ok && s.marker.kind === "agenda" ? [s.marker.payload] : []));
  const invalid = scanned.find((s) => !s.ok && s.kind === "agenda");
  if (invalid !== undefined && !invalid.ok) return { kind: "keyMismatch", detail: `${refKey(agenda)}: agenda marker ${invalid.reason}; the HMAC key is not this agenda's key` };
  const payload = valid[0];
  if (payload === undefined || valid.length > 1) return { kind: "notAgenda", detail: `${refKey(agenda)} does not carry exactly one agenda marker` };
  return { kind: "ok", raw, payload };
}

/** Verified records on the agenda issue, in comment order; everything else that claims to be a record is a diagnostic. */
export async function readRecords(source: Source, key: HmacKey, agenda: IssueRef, diagnostics: Diagnostic[]): Promise<StoredRecord[]> {
  const records: StoredRecord[] = [];
  for (const c of await source.comments(agenda)) {
    const where = `comment ${c.id} on ${refKey(agenda)}`;
    const scanned = scanMarkers(key, c.body);
    for (const s of scanned) if (!s.ok) diagnostics.push({ where, reason: `${s.kind} block: ${s.reason}` });
    const found = scanned.flatMap((s) => (s.ok && s.marker.kind === "record" ? [s.marker.payload] : []));
    if (found.length > 1) {
      diagnostics.push({ where, reason: "more than one record block" });
      continue;
    }
    const p = found[0];
    if (p === undefined) continue;
    if (!sameRef(p.agenda, agenda)) {
      diagnostics.push({ where, reason: `record belongs to agenda ${refKey(p.agenda)}` });
      continue;
    }
    records.push({
      id: c.id as RecordId,
      at: c.createdAt,
      author: p.author,
      obligation: p.obligation,
      idempotencyKey: p.idempotencyKey,
      manifest: p.manifest,
      payloadHash: p.payloadHash,
      body: p.body,
    });
  }
  return records;
}

/** Drafts carried by a decision record (its own drafts plus `outOfScope` finding drafts), as core numbers them. */
export function draftsOf(r: StoredRecord): { readonly draftId: string; readonly draft: Draft }[] {
  if (r.body.kind !== "decision") return [];
  const d = r.body.decision;
  const fromFindings = d.subject === "findings" ? d.perFinding.flatMap((f) => (f.verdict.kind === "outOfScope" ? [f.verdict.draft] : [])) : [];
  return [...r.body.drafts, ...fromFindings].map((draft) => ({ draftId: `${r.id}#${draft.index}`, draft }));
}

/** Issues a record names: members, body replacements, notice targets (`affected`), draft anchors, route carriers/migrations. */
function issuesNamedBy(body: RecordBody): IssueRef[] {
  switch (body.kind) {
    case "prSubmit":
      return [body.member];
    case "claim":
      return body.claim.kind === "question" ? (body.claim.context.kind === "member" ? [body.claim.context.member] : []) : [body.claim.member];
    case "verdict":
      return [];
    case "decision": {
      const d: Decision = body.decision;
      const routes =
        d.subject === "question" && d.verdict.kind === "designGap"
          ? [d.verdict.route]
          : d.subject === "findings"
            ? d.perFinding.flatMap((f) => (f.verdict.kind === "designGap" ? [f.verdict.route] : []))
            : [];
      const findingDrafts = d.subject === "findings" ? d.perFinding.flatMap((f) => (f.verdict.kind === "outOfScope" ? [f.verdict.draft] : [])) : [];
      return [
        ...("member" in d ? [d.member] : []),
        ...(d.subject === "question" ? d.affected : []),
        ...body.bodyReplacements.map((b) => b.issue),
        ...[...body.drafts, ...findingDrafts].flatMap((dr) => (dr.anchor.kind === "outsideAgenda" ? [] : [dr.anchor.entry])),
        ...routes.flatMap((r) => (r.kind === "future" ? [r.carrier] : r.kind === "defaultFirst" && r.migration !== null ? [r.migration] : [])),
      ];
    }
    default:
      return assertNever(body);
  }
}

/** Design commits referenced by records: design-gap route commits and designFix commits. */
export function designCommits(records: readonly StoredRecord[]): Sha[] {
  const out: Sha[] = [];
  for (const r of records) {
    if (r.body.kind !== "decision") continue;
    const d = r.body.decision;
    if (d.subject === "question" && d.verdict.kind === "designGap") out.push(d.verdict.route.commit);
    if (d.subject === "findings") for (const f of d.perFinding) if (f.verdict.kind === "designGap") out.push(f.verdict.route.commit);
    if (d.subject === "designFix") out.push(d.commit);
  }
  return [...new Set(out)];
}

/** Commits observed by postMerge / closure verdicts. */
function observedCommits(records: readonly StoredRecord[]): { repo: RepoRef; sha: Sha }[] {
  return records.flatMap((r) =>
    r.body.kind === "verdict" && (r.body.verdict.gate === "postMerge" || r.body.verdict.gate === "closure")
      ? r.body.verdict.observed.map((o) => ({ repo: o.repo, sha: o.commit }))
      : [],
  );
}

export async function readSnapshot(
  source: Source,
  key: HmacKey,
  agendaRef: IssueRef,
): Promise<StoreResult<{ readonly snapshot: Snapshot; readonly diagnostics: readonly Diagnostic[] }>> {
  try {
    return await assemble(source, key, agendaRef);
  } catch (err) {
    return { ok: false, error: { kind: "read", detail: err instanceof Error ? err.message : String(err) } };
  }
}

async function assemble(
  source: Source,
  key: HmacKey,
  agendaRef: IssueRef,
): Promise<StoreResult<{ readonly snapshot: Snapshot; readonly diagnostics: readonly Diagnostic[] }>> {
  const diagnostics: Diagnostic[] = [];
  const head = await readAgenda(source, key, agendaRef);
  if (head.kind === "keyMismatch") return { ok: false, error: { kind: "keyMismatch", detail: head.detail } };
  if (head.kind === "notAgenda") return { ok: false, error: { kind: "read", detail: head.detail } };
  const agenda: Agenda = { record: agendaRef, createdAt: head.raw.createdAt, parent: head.payload.parent, convened: head.payload.convened };
  const records = await readRecords(source, key, agendaRef, diagnostics);

  // ------------------------------------------------ issue set (insertion order = discovery order)
  const raws = new Map<string, IssueRaw>([[refKey(agendaRef), head.raw]]);
  const wanted = new Map<string, IssueRef>([[refKey(agendaRef), agendaRef]]);
  const want = (r: IssueRef): void => {
    if (!wanted.has(refKey(r))) wanted.set(refKey(r), r);
  };
  const parentChildren = agenda.parent === null ? [] : [...(await source.subIssues(agenda.parent))];
  if (agenda.parent !== null) want(agenda.parent);
  for (const c of agenda.convened) want(c.issue);
  for (const c of parentChildren) want(c);
  for (const r of records) for (const i of issuesNamedBy(r.body)) want(i);

  // issues created from this agenda's drafts: REST listing (not search) of each draft repo since the agenda was created
  const draftIds = new Set(records.flatMap((r) => draftsOf(r).map((d) => d.draftId)));
  const draftRepos = new Map(records.flatMap((r) => draftsOf(r).map((d) => [repoKey(d.draft.repo), d.draft.repo] as const)));
  const draftCreated: IssueRef[] = [];
  for (const repo of draftRepos.values()) {
    for (const raw of await source.listIssuesSince(repo, agenda.createdAt)) {
      const marker = scanMarkers(key, raw.body).find((s) => s.ok && s.marker.kind === "draft");
      if (marker?.ok !== true || marker.marker.kind !== "draft") continue;
      if (!sameRef(marker.marker.payload.agenda, agendaRef) || !draftIds.has(marker.marker.payload.draftId)) continue;
      raws.set(refKey(raw.ref), raw);
      want(raw.ref);
      draftCreated.push(raw.ref);
    }
  }

  const issueRefs = [...wanted.values()];
  const missing = issueRefs.filter((r) => !raws.has(refKey(r)));
  for (const [i, raw] of (await mapLimit(missing, FANOUT, (r) => source.issue(r))).entries()) raws.set(refKey(missing[i] as IssueRef), raw);

  const effectMarkers = new Set<ObligationId>();
  const noticesFrom = (where: string, scanned: readonly Scanned[]): void => {
    for (const s of scanned) {
      if (!s.ok) diagnostics.push({ where, reason: `${s.kind} block: ${s.reason}` });
      else if (s.marker.kind === "notice" && sameRef(s.marker.payload.agenda, agendaRef)) effectMarkers.add(s.marker.payload.obligation);
    }
  };

  const issues: IssueFact[] = await mapLimit(issueRefs, FANOUT, async (ref): Promise<IssueFact> => {
    const raw = raws.get(refKey(ref)) as IssueRaw;
    const [events, comments] = await Promise.all([source.issueEvents(ref), sameRef(ref, agendaRef) ? Promise.resolve([]) : source.comments(ref)]);
    for (const c of comments) noticesFrom(`comment ${c.id} on ${refKey(ref)}`, scanMarkers(key, c.body));
    const scanned = scanMarkers(key, raw.body);
    const where = `body of ${refKey(ref)}`;
    let applied: RecordId[] = [];
    let draftMarker: IssueFact["draftMarker"] = null;
    let isAgendaRecord = false;
    for (const s of scanned) {
      if (!s.ok) {
        diagnostics.push({ where, reason: `${s.kind} block: ${s.reason}` });
        continue;
      }
      const m = s.marker;
      if (m.kind === "applied") applied = [...applied, ...m.payload.decisions.filter((d) => !applied.includes(d))];
      else if (m.kind === "draft" && sameRef(m.payload.agenda, agendaRef)) draftMarker = m.payload.draftId;
      else if (m.kind === "agenda") isAgendaRecord = true;
    }
    return {
      ref,
      open: raw.open,
      events,
      bodyHash: bodyHash(raw.body),
      appliedDecisions: applied,
      acceptanceRows: acceptanceRows(ref, raw.body),
      children: agenda.parent !== null && sameRef(ref, agenda.parent) ? parentChildren : [],
      draftMarker,
      isAgendaRecord,
    };
  });

  // ------------------------------------------------ PRs
  // GitHub parses closing keywords only for PRs into the default branch, so discovery also covers the head branch
  // of every PrSubmit (in the member's target repo) and every adopted PR; `closes` adds the member these name.
  const agendaRecords = new Set(issues.filter((i) => i.isAgendaRecord).map((i) => refKey(i.ref)));
  const members = [...agenda.convened.map((c) => c.issue), ...draftCreated, ...parentChildren].filter((r) => !agendaRecords.has(refKey(r)));
  const prRefs = new Map<string, PrRef>();
  const add = (found: readonly PrRef[]): void => {
    for (const p of [...found].sort((a, b) => a.number - b.number)) prRefs.set(refKey(p), p);
  };
  for (const found of await mapLimit(members, FANOUT, (m) => source.closingPrs(m))) add(found);
  const draftTargets = new Map(records.flatMap((r) => draftsOf(r).map((d) => [d.draftId, d.draft.target.repo] as const)));
  const targetRepo = new Map<string, RepoRef>(agenda.convened.map((c) => [refKey(c.issue), c.target.repo] as const));
  for (const i of issues) {
    const repo = i.draftMarker === null ? undefined : draftTargets.get(i.draftMarker);
    if (repo !== undefined && !targetRepo.has(refKey(i.ref))) targetRepo.set(refKey(i.ref), repo);
  }
  const heads = new Map<string, { repo: RepoRef; branch: string }>();
  for (const r of records) {
    if (r.body.kind !== "prSubmit") continue;
    const repo = targetRepo.get(refKey(r.body.member));
    if (repo !== undefined) heads.set(`${repoKey(repo)}:${r.body.branch}`, { repo, branch: r.body.branch });
  }
  for (const found of await mapLimit([...heads.values()], FANOUT, (h) => source.prsByHead(h.repo, h.branch))) add(found);
  const adopted = new Map<string, IssueRef>();
  for (const c of agenda.convened) {
    if (c.adoptPr === null) continue;
    prRefs.set(refKey(c.adoptPr), c.adoptPr);
    adopted.set(refKey(c.adoptPr), c.issue);
  }

  const required = new Map<string, Promise<boolean>>();
  const requiresChecks = (repo: RepoRef, base: string): Promise<boolean> => {
    const k = `${repoKey(repo)}@${base}`;
    const hit = required.get(k) ?? source.requiresChecks(repo, base);
    required.set(k, hit);
    return hit;
  };
  const prRaws: PrRaw[] = await mapLimit([...prRefs.values()], FANOUT, (p) => source.pr(p));
  const prs: PrFact[] = await mapLimit(prRaws, FANOUT, async (raw): Promise<PrFact> => {
    const comments = await source.comments(raw.ref);
    for (const c of comments) noticesFrom(`comment ${c.id} on ${refKey(raw.ref)}`, scanMarkers(key, c.body));
    const where = `body of PR ${refKey(raw.ref)}`;
    let appliedSubmit: RecordId | null = null;
    const closes = [...raw.closes];
    const close = (issue: IssueRef): void => {
      if (!closes.some((c) => sameRef(c, issue))) closes.push(issue);
    };
    for (const s of scanMarkers(key, raw.body)) {
      if (!s.ok) diagnostics.push({ where, reason: `${s.kind} block: ${s.reason}` });
      else if (s.marker.kind === "pr" && sameRef(s.marker.payload.agenda, agendaRef)) {
        appliedSubmit = s.marker.payload.appliedSubmit;
        close(s.marker.payload.member);
      }
    }
    const adoptedBy = adopted.get(refKey(raw.ref));
    if (adoptedBy !== undefined) close(adoptedBy);
    // A head without any rollup, as GitHub's merge rule reads it: pending when the base requires checks, else pass.
    const checks: ChecksFact =
      raw.checks.kind === "rollup"
        ? raw.checks.fact
        : { state: (await requiresChecks(raw.baseRepo, raw.base)) ? "pending" : "pass", failedRunId: null, latestRunCreatedAt: null };
    return {
      ref: raw.ref,
      state: raw.state,
      head: raw.head,
      target: { repo: raw.baseRepo, base: raw.base },
      bodyHash: bodyHash(raw.body),
      appliedSubmit,
      mergeable: raw.mergeable,
      checks,
      closes,
      agendaMarker: appliedSubmit !== null,
    };
  });

  const commits = await readCommits(source, agenda, records, prs, draftRepos);
  return {
    ok: true,
    value: { snapshot: { agenda, issues, prs, commits, records, effectMarkers: [...effectMarkers] }, diagnostics },
  };
}

/**
 * Only what core queries: default heads of every target repo; the base-branch head of every delivery target; for each
 * repo, containment of every design commit and merge commit (ancestors) in every PR head, the default head and every
 * verdict-observed commit (descendants). `onDefault` is containment in the default head.
 */
async function readCommits(
  source: Source,
  agenda: Agenda,
  records: readonly StoredRecord[],
  prs: readonly PrFact[],
  draftRepos: ReadonlyMap<string, RepoRef>,
): Promise<CommitFacts> {
  const repos = new Map<string, RepoRef>();
  for (const c of agenda.convened) repos.set(repoKey(c.target.repo), c.target.repo);
  for (const r of records) for (const d of draftsOf(r)) repos.set(repoKey(d.draft.target.repo), d.draft.target.repo);
  for (const r of draftRepos.values()) repos.set(repoKey(r), r);
  for (const p of prs) repos.set(repoKey(p.target.repo), p.target.repo);
  const design = designCommits(records);
  const observed = observedCommits(records);

  const heads = await mapLimit([...repos.values()], FANOUT, async (repo) => ({ repo, sha: await source.defaultHead(repo) }));
  const pairs: { repo: RepoRef; ancestor: Sha; descendant: Sha }[] = [];
  for (const { repo, sha: defaultSha } of heads) {
    const inRepo = (r: RepoRef): boolean => repoKey(r) === repoKey(repo);
    const ancestors = [...new Set([...design, ...prs.flatMap((p) => (inRepo(p.target.repo) && p.state.kind === "merged" ? [p.state.mergeSha] : []))])];
    const descendants = [...new Set([...prs.filter((p) => inRepo(p.target.repo)).map((p) => p.head), defaultSha, ...observed.filter((o) => inRepo(o.repo)).map((o) => o.sha)])];
    for (const ancestor of ancestors) for (const descendant of descendants) if (ancestor !== descendant) pairs.push({ repo, ancestor, descendant });
  }
  const held = await mapLimit(pairs, FANOUT, (p) => source.contains(p.repo, p.ancestor, p.descendant));
  const contains = pairs.filter((_, i) => held[i] === true);
  const onDefault = heads.flatMap(({ repo, sha }) =>
    design.filter((d) => d === sha || contains.some((c) => repoKey(c.repo) === repoKey(repo) && c.ancestor === d && c.descendant === sha)).map((d) => ({ repo, sha: d })),
  );
  const targets = new Map<string, { repo: RepoRef; base: string }>();
  for (const c of agenda.convened) targets.set(`${repoKey(c.target.repo)}@${c.target.base}`, c.target);
  for (const r of records) for (const d of draftsOf(r)) targets.set(`${repoKey(d.draft.target.repo)}@${d.draft.target.base}`, d.draft.target);
  const bases = await mapLimit([...targets.values()], FANOUT, async (t) => ({ repo: t.repo, base: t.base, sha: await source.branchHead(t.repo, t.base) }));
  const baseHead = bases.flatMap((b) => (b.sha === null ? [] : [{ repo: b.repo, base: b.base, sha: b.sha }]));
  return { onDefault, contains, defaultHead: heads, baseHead };
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
