import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EventId, IssueRef, LifecycleEvent, Mergeable, Millis, PrRef, RepoRef, Sha } from "../core/index.ts";
import type { ChecksRaw, CommentRaw, IssueRaw, MergeOutcome, NewPr, PrRaw, Source } from "./source.ts";

export const DEFAULT_STATE_DIR = join(homedir(), ".omp", "agent", "omp-roundtable", "state");

interface EventRow { id: string; kind: "closed" | "reopened"; at: number }
interface CommentRow { id: string; body: string; createdAt: number }
interface IssueRow {
  number: number;
  title: string;
  body: string;
  open: boolean;
  createdAt: number;
  updatedAt: number;
  events: EventRow[];
  subIssues: IssueRef[];
  comments: CommentRow[];
  isPr: boolean;
}
interface RunRow { id: string; createdAt: number; failed: boolean }
type PrStateRow = { kind: "open" } | { kind: "merged"; mergeSha: string; mergedAt: number } | { kind: "closedUnmerged"; closedAt: number };
interface PrRow {
  number: number;
  title: string;
  body: string;
  headRef: string;
  head: string;
  baseRepo: RepoRef;
  base: string;
  state: PrStateRow;
  mergeable: Mergeable;
  checks: ChecksRaw;
  runs: RunRow[];
}
interface RepoRow {
  owner: string;
  name: string;
  defaultBranch: string;
  branches: Record<string, string>;
  commits: Record<string, string[]>;
  workflowsPresent: boolean;
  requiredChecks: string[];
  nextNumber: number;
  issues: IssueRow[];
  prs: PrRow[];
}
interface Table { repos: Record<string, RepoRow>; nextCommentId: number; nextEventId: number; nextRunId: number; nextMergeId: number }

const emptyTable = (): Table => ({ repos: {}, nextCommentId: 1, nextEventId: 1, nextRunId: 1, nextMergeId: 1 });
const key = (repo: RepoRef): string => `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
const refOf = (repo: RepoRow, number: number): IssueRef => ({ repo: { owner: repo.owner, name: repo.name }, number });
const prRefOf = (repo: RepoRow, number: number): PrRef => ({ repo: { owner: repo.owner, name: repo.name }, number });
const issueRaw = (repo: RepoRow, issue: IssueRow): IssueRaw => ({ ref: refOf(repo, issue.number), title: issue.title, body: issue.body, open: issue.open, createdAt: issue.createdAt as Millis });
const commentRaw = (comment: CommentRow): CommentRaw => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt as Millis });
const code = (error: unknown): unknown => typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

/** Return the persisted table verbatim; a missing state file denotes an empty table. */
export function readStateText(dir: string): string {
  try { return readFileSync(join(dir, "state.json"), "utf8"); }
  catch (error) {
    if (code(error) === "ENOENT") return JSON.stringify(emptyTable());
    throw error;
  }
}

let temporarySequence = 0;
/** Durably replace the whole state table without exposing a partially written file. */
export function writeStateAtomically(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `state.json.tmp-${process.pid}-${++temporarySequence}`);
  let file: number | undefined;
  try {
    file = openSync(temporary, "wx", 0o600);
    const bytes = Buffer.from(text, "utf8");
    let written = 0;
    while (written < bytes.length) written += writeSync(file, bytes, written, bytes.length - written);
    fsyncSync(file);
    closeSync(file);
    file = undefined;
    renameSync(temporary, join(dir, "state.json"));
    const directory = openSync(dir, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch (error) {
    if (file !== undefined) closeSync(file);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

// Decode every field at the file boundary; internal operations only see a complete table.
const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid local state: ${label} must be an object`);
  return value as Record<string, unknown>;
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`Invalid local state: ${label} must be a string`);
  return value;
};
const number = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid local state: ${label} must be a finite number`);
  return value;
};
const boolean = (value: unknown, label: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`Invalid local state: ${label} must be a boolean`);
  return value;
};
const array = <T>(value: unknown, label: string, parse: (element: unknown, label: string) => T): T[] => {
  if (!Array.isArray(value)) throw new Error(`Invalid local state: ${label} must be an array`);
  return value.map((element: unknown, index: number) => parse(element, `${label}[${index}]`));
};
const record = <T>(value: unknown, label: string, parse: (element: unknown, label: string) => T): Record<string, T> =>
  Object.fromEntries(Object.entries(object(value, label)).map(([name, element]) => [name, parse(element, `${label}.${name}`)]));
const repoRef = (value: unknown, label: string): RepoRef => {
  const row = object(value, label);
  return { owner: string(row.owner, `${label}.owner`), name: string(row.name, `${label}.name`) };
};
const issueRef = (value: unknown, label: string): IssueRef => {
  const row = object(value, label);
  return { repo: repoRef(row.repo, `${label}.repo`), number: number(row.number, `${label}.number`) };
};
const parseChecks = (value: unknown, label: string): ChecksRaw => {
  const row = object(value, label);
  if (row.kind === "none") return { kind: "none" };
  if (row.kind !== "rollup") throw new Error(`Invalid local state: ${label}.kind`);
  const fact = object(row.fact, `${label}.fact`);
  const state = fact.state;
  if (state !== "pass" && state !== "fail" && state !== "pending" && state !== "unknown") throw new Error(`Invalid local state: ${label}.fact.state`);
  const failedRunId = fact.failedRunId === null ? null : string(fact.failedRunId, `${label}.fact.failedRunId`);
  const latestRunCreatedAt = fact.latestRunCreatedAt === null ? null : number(fact.latestRunCreatedAt, `${label}.fact.latestRunCreatedAt`) as Millis;
  return { kind: "rollup", fact: { state, failedRunId, latestRunCreatedAt } };
};
const parseState = (value: unknown, label: string): PrStateRow => {
  const row = object(value, label);
  if (row.kind === "open") return { kind: "open" };
  if (row.kind === "merged") return { kind: "merged", mergeSha: string(row.mergeSha, `${label}.mergeSha`), mergedAt: number(row.mergedAt, `${label}.mergedAt`) };
  if (row.kind === "closedUnmerged") return { kind: "closedUnmerged", closedAt: number(row.closedAt, `${label}.closedAt`) };
  throw new Error(`Invalid local state: ${label}.kind`);
};
const parseTable = (text: string): Table => {
  const root = object(JSON.parse(text) as unknown, "root");
  return {
    nextCommentId: number(root.nextCommentId, "nextCommentId"),
    nextEventId: number(root.nextEventId, "nextEventId"),
    nextRunId: number(root.nextRunId, "nextRunId"),
    nextMergeId: number(root.nextMergeId, "nextMergeId"),
    repos: record(root.repos, "repos", (value, label) => {
      const row = object(value, label);
      return {
        owner: string(row.owner, `${label}.owner`), name: string(row.name, `${label}.name`),
        defaultBranch: string(row.defaultBranch, `${label}.defaultBranch`),
        branches: record(row.branches, `${label}.branches`, string),
        commits: record(row.commits, `${label}.commits`, (entry, place) => array(entry, place, string)),
        workflowsPresent: boolean(row.workflowsPresent, `${label}.workflowsPresent`),
        requiredChecks: array(row.requiredChecks, `${label}.requiredChecks`, string),
        nextNumber: number(row.nextNumber, `${label}.nextNumber`),
        issues: array(row.issues, `${label}.issues`, (entry, place): IssueRow => {
          const issue = object(entry, place);
          return {
            number: number(issue.number, `${place}.number`), title: string(issue.title, `${place}.title`), body: string(issue.body, `${place}.body`),
            open: boolean(issue.open, `${place}.open`), createdAt: number(issue.createdAt, `${place}.createdAt`), updatedAt: number(issue.updatedAt, `${place}.updatedAt`),
            events: array(issue.events, `${place}.events`, (event, eventPlace): EventRow => {
              const e = object(event, eventPlace);
              if (e.kind !== "closed" && e.kind !== "reopened") throw new Error(`Invalid local state: ${eventPlace}.kind`);
              return { id: string(e.id, `${eventPlace}.id`), kind: e.kind, at: number(e.at, `${eventPlace}.at`) };
            }),
            subIssues: array(issue.subIssues, `${place}.subIssues`, issueRef),
            comments: array(issue.comments, `${place}.comments`, (comment, commentPlace): CommentRow => {
              const c = object(comment, commentPlace);
              return { id: string(c.id, `${commentPlace}.id`), body: string(c.body, `${commentPlace}.body`), createdAt: number(c.createdAt, `${commentPlace}.createdAt`) };
            }),
            isPr: boolean(issue.isPr, `${place}.isPr`),
          };
        }),
        prs: array(row.prs, `${label}.prs`, (entry, place): PrRow => {
          const pr = object(entry, place);
          const mergeable = pr.mergeable;
          if (mergeable !== "yes" && mergeable !== "no" && mergeable !== "unknown") throw new Error(`Invalid local state: ${place}.mergeable`);
          return {
            number: number(pr.number, `${place}.number`), title: string(pr.title, `${place}.title`), body: string(pr.body, `${place}.body`),
            headRef: string(pr.headRef, `${place}.headRef`), head: string(pr.head, `${place}.head`),
            baseRepo: repoRef(pr.baseRepo, `${place}.baseRepo`), base: string(pr.base, `${place}.base`),
            state: parseState(pr.state, `${place}.state`), mergeable, checks: parseChecks(pr.checks, `${place}.checks`),
            runs: array(pr.runs, `${place}.runs`, (entryRun, runPlace): RunRow => {
              const run = object(entryRun, runPlace);
              return { id: string(run.id, `${runPlace}.id`), createdAt: number(run.createdAt, `${runPlace}.createdAt`), failed: boolean(run.failed, `${runPlace}.failed`) };
            }),
          };
        }),
      };
    }),
  };
};
const load = (dir: string): Table => parseTable(readStateText(dir));
const save = (dir: string, table: Table): void => writeStateAtomically(dir, JSON.stringify(table));
const getRepo = (table: Table, ref: RepoRef): RepoRow => {
  const repo = table.repos[key(ref)];
  if (!repo) throw new Error(`Unknown repository ${ref.owner}/${ref.name}`);
  return repo;
};
const getIssue = (table: Table, ref: IssueRef): IssueRow => {
  const issue = getRepo(table, ref.repo).issues.find(row => row.number === ref.number);
  if (!issue) throw new Error(`Unknown issue ${ref.repo.owner}/${ref.repo.name}#${ref.number}`);
  return issue;
};
const getPr = (table: Table, ref: PrRef): PrRow => {
  const pr = getRepo(table, ref.repo).prs.find(row => row.number === ref.number);
  if (!pr) throw new Error(`Unknown PR ${ref.repo.owner}/${ref.repo.name}#${ref.number}`);
  return pr;
};
const closes = (table: Table, repo: RepoRow, body: string): IssueRef[] => {
  const references: IssueRef[] = [];
  const seen = new Set<string>();
  const pattern = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+(?:([\w.-]+)\/([\w.-]+))?#(\d+)\b/gi;
  for (const match of body.matchAll(pattern)) {
    const owner = match[1] ?? repo.owner;
    const name = match[2] ?? repo.name;
    const number = Number(match[3]);
    const target = table.repos[key({ owner, name })];
    if (!target || !target.issues.some(issue => issue.number === number && !issue.isPr)) continue;
    const id = `${key({ owner, name })}#${number}`;
    if (seen.has(id)) continue;
    seen.add(id);
    references.push(refOf(target, number));
  }
  return references;
};
const closeIssue = (table: Table, issue: IssueRow, at: number): void => {
  issue.open = false;
  issue.updatedAt = at;
  issue.events.push({ id: String(table.nextEventId++), kind: "closed", at });
};

export class LocalSource implements Source {
  readonly dir: string;
  private readonly clock: () => Millis;

  constructor(options: { dir: string; clock: () => Millis }) {
    this.dir = options.dir;
    this.clock = options.clock;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private change<T>(action: (table: Table) => T): T {
    const table = load(this.dir);
    const result = action(table);
    save(this.dir, table);
    return result;
  }

  async issue(ref: IssueRef): Promise<IssueRaw> { const table = load(this.dir); return issueRaw(getRepo(table, ref.repo), getIssue(table, ref)); }
  async issueEvents(ref: IssueRef): Promise<readonly LifecycleEvent[]> {
    return getIssue(load(this.dir), ref).events.map(event => ({ id: event.id as EventId, kind: event.kind, at: event.at as Millis }));
  }
  async subIssues(parent: IssueRef): Promise<readonly IssueRef[]> { return getIssue(load(this.dir), parent).subIssues; }
  async comments(ref: IssueRef): Promise<readonly CommentRaw[]> { return getIssue(load(this.dir), ref).comments.map(commentRaw); }
  async listIssuesSince(repo: RepoRef, since: Millis): Promise<readonly IssueRaw[]> {
    const row = getRepo(load(this.dir), repo);
    return row.issues.filter(issue => !issue.isPr && issue.updatedAt >= since).map(issue => issueRaw(row, issue));
  }
  async listOpenIssues(repo: RepoRef): Promise<readonly IssueRaw[]> {
    const row = getRepo(load(this.dir), repo);
    return row.issues.filter(issue => !issue.isPr && issue.open).map(issue => issueRaw(row, issue));
  }
  async closingPrs(issue: IssueRef): Promise<readonly PrRef[]> {
    const table = load(this.dir);
    const target = getIssue(table, issue);
    if (target.isPr) return [];
    // Like GitHub, closing keywords only link when the PR targets the default branch.
    return Object.values(table.repos).flatMap(repo => repo.prs
      .filter(pr => pr.base === repo.defaultBranch && closes(table, repo, pr.body).some(ref => key(ref.repo) === key(issue.repo) && ref.number === issue.number))
      .map(pr => prRefOf(repo, pr.number)));
  }
  async prsByHead(repo: RepoRef, head: string): Promise<readonly PrRef[]> {
    const row = getRepo(load(this.dir), repo);
    return row.prs.filter(pr => pr.headRef === head).map(pr => prRefOf(row, pr.number));
  }
  async pr(ref: PrRef): Promise<PrRaw> {
    const table = load(this.dir);
    const repo = getRepo(table, ref.repo);
    const row = getPr(table, ref);
    const latestRun = row.runs.reduce<RunRow | null>((latest, run) => !latest || run.createdAt >= latest.createdAt ? run : latest, null);
    const failedRun = row.runs.reduce<RunRow | null>((latest, run) => run.failed ? run : latest, null);
    // Check runs recorded in the table decide the run facts; a rollup set by the driver without runs keeps its own.
    const checks: ChecksRaw = row.checks.kind === "none" ? { kind: "none" } : row.runs.length === 0 ? row.checks : {
      kind: "rollup", fact: { state: row.checks.fact.state, failedRunId: failedRun?.id ?? null, latestRunCreatedAt: latestRun ? latestRun.createdAt as Millis : null },
    };
    const state = row.state.kind === "open" ? { kind: "open" } as const : row.state.kind === "merged"
      ? { kind: "merged", mergeSha: row.state.mergeSha as Sha, mergedAt: row.state.mergedAt as Millis } as const
      : { kind: "closedUnmerged", closedAt: row.state.closedAt as Millis } as const;
    return { ref: prRefOf(repo, row.number), title: row.title, body: row.body, state, headRef: row.headRef,
      head: row.head as Sha, baseRepo: row.baseRepo, base: row.base, mergeable: row.mergeable,
      checks, closes: row.base === repo.defaultBranch ? closes(table, repo, row.body) : [] };
  }
  async defaultHead(repo: RepoRef): Promise<Sha> {
    const row = getRepo(load(this.dir), repo);
    const sha = row.branches[row.defaultBranch];
    if (!sha) throw new Error(`Unknown default branch ${row.defaultBranch} in ${repo.owner}/${repo.name}`);
    return sha as Sha;
  }
  async contains(repo: RepoRef, ancestor: Sha, descendant: Sha): Promise<boolean> {
    const commits = getRepo(load(this.dir), repo).commits;
    if (!Object.hasOwn(commits, ancestor) || !Object.hasOwn(commits, descendant)) return false;
    const visited = new Set<string>();
    const pending: string[] = [descendant];
    while (pending.length) {
      const sha = pending.pop();
      if (sha === ancestor) return true;
      if (sha === undefined || visited.has(sha)) continue;
      visited.add(sha);
      pending.push(...(commits[sha] ?? []));
    }
    return false;
  }
  async ciConfigured(repo: RepoRef, base: string): Promise<boolean> {
    const row = getRepo(load(this.dir), repo);
    return row.workflowsPresent || row.requiredChecks.includes(base);
  }

  async createIssue(repo: RepoRef, title: string, body: string): Promise<IssueRaw> {
    return this.change(table => {
      const row = getRepo(table, repo);
      const at = this.clock();
      const issue: IssueRow = { number: row.nextNumber++, title, body, open: true, createdAt: at, updatedAt: at, events: [], subIssues: [], comments: [], isPr: false };
      row.issues.push(issue);
      return issueRaw(row, issue);
    });
  }
  async editIssueBody(ref: IssueRef, body: string): Promise<void> {
    this.change(table => { const issue = getIssue(table, ref); issue.body = body; issue.updatedAt = this.clock(); });
  }
  async setIssueOpen(ref: IssueRef, open: boolean): Promise<void> {
    this.change(table => {
      const issue = getIssue(table, ref);
      if (issue.isPr) throw new Error(`Cannot change PR ${ref.repo.owner}/${ref.repo.name}#${ref.number} through setIssueOpen`);
      if (issue.open === open) return;
      const at = this.clock();
      issue.open = open;
      issue.updatedAt = at;
      issue.events.push({ id: String(table.nextEventId++), kind: open ? "reopened" : "closed", at });
    });
  }
  async addSubIssue(parent: IssueRef, child: IssueRef): Promise<void> {
    this.change(table => {
      const parentRow = getIssue(table, parent);
      const childRow = getIssue(table, child);
      if (parentRow.isPr || childRow.isPr) throw new Error("PRs cannot be sub-issues");
      if (!parentRow.subIssues.some(ref => key(ref.repo) === key(child.repo) && ref.number === child.number)) parentRow.subIssues.push(refOf(getRepo(table, child.repo), child.number));
    });
  }
  async comment(ref: IssueRef, body: string): Promise<CommentRaw> {
    return this.change(table => {
      const issue = getIssue(table, ref);
      const at = this.clock();
      const comment: CommentRow = { id: String(table.nextCommentId++), body, createdAt: at };
      issue.comments.push(comment);
      issue.updatedAt = at;
      return commentRaw(comment);
    });
  }
  async createPr(input: NewPr): Promise<PrRef> {
    return this.change(table => {
      const repo = getRepo(table, input.repo);
      const head = repo.branches[input.head];
      if (!head) throw new Error(`Unknown head branch ${input.head} in ${input.repo.owner}/${input.repo.name}`);
      if (!repo.branches[input.base]) throw new Error(`Unknown base branch ${input.base} in ${input.repo.owner}/${input.repo.name}`);
      const number = repo.nextNumber++;
      const at = this.clock();
      repo.issues.push({ number, title: input.title, body: input.body, open: true, createdAt: at, updatedAt: at, events: [], subIssues: [], comments: [], isPr: true });
      repo.prs.push({ number, title: input.title, body: input.body, headRef: input.head, head, baseRepo: { owner: repo.owner, name: repo.name }, base: input.base,
        state: { kind: "open" }, mergeable: "unknown", checks: { kind: "none" }, runs: [] });
      return prRefOf(repo, number);
    });
  }
  async editPr(ref: PrRef, title: string, body: string): Promise<void> {
    this.change(table => {
      const row = getPr(table, ref);
      const issue = getIssue(table, ref);
      row.title = issue.title = title;
      row.body = issue.body = body;
      issue.updatedAt = this.clock();
    });
  }
  async mergePr(ref: PrRef, head: Sha): Promise<MergeOutcome> {
    const table = load(this.dir);
    const pr = getPr(table, ref);
    if (pr.state.kind !== "open") return { kind: "rejected", detail: `PR ${ref.repo.owner}/${ref.repo.name}#${ref.number} is not open` };
    if (pr.head !== head) return { kind: "rejected", detail: `PR head changed: expected ${head}, found ${pr.head}` };
    const base = getRepo(table, pr.baseRepo);
    const baseHead = base.branches[pr.base];
    if (!baseHead) throw new Error(`Unknown base branch ${pr.base} in ${base.owner}/${base.name}`);
    let mergeSha: string;
    do { mergeSha = (table.nextMergeId++).toString(16).padStart(40, "0"); }
    while (Object.values(table.repos).some(repo => Object.hasOwn(repo.commits, mergeSha)));
    const at = this.clock();
    base.commits[mergeSha] = [baseHead, pr.head];
    base.branches[pr.base] = mergeSha;
    pr.state = { kind: "merged", mergeSha, mergedAt: at };
    const conversation = getIssue(table, ref);
    conversation.open = false;
    conversation.updatedAt = at;
    if (pr.base === base.defaultBranch) {
      for (const target of closes(table, getRepo(table, ref.repo), pr.body)) {
        if (key(target.repo) !== key(pr.baseRepo)) continue;
        const issue = getIssue(table, target);
        if (issue.open) closeIssue(table, issue, at);
      }
    }
    save(this.dir, table);
    return { kind: "merged" };
  }
  async rerunCheck(repo: RepoRef, runId: string): Promise<void> {
    this.change(table => {
      const row = getRepo(table, repo);
      const pr = row.prs.find(candidate => candidate.runs.some(run => run.id === runId && run.failed));
      if (!pr) throw new Error(`Unknown failed check run ${runId} in ${repo.owner}/${repo.name}`);
      const at = this.clock();
      pr.runs.push({ id: String(table.nextRunId++), createdAt: at, failed: false });
      pr.checks = { kind: "rollup", fact: { state: "pending", failedRunId: null, latestRunCreatedAt: at } };
    });
  }

  seedRepo(repo: RepoRef, input: { defaultBranch: string; commits: readonly { sha: Sha; parents: readonly Sha[] }[]; branches: Record<string, Sha>; workflowsPresent: boolean; requiredChecks: readonly string[] }): void {
    this.change(table => {
      const existing = table.repos[key(repo)];
      const commits = Object.fromEntries(input.commits.map(commit => [commit.sha, [...commit.parents]]));
      table.repos[key(repo)] = { owner: repo.owner, name: repo.name, defaultBranch: input.defaultBranch,
        commits, branches: { ...input.branches }, workflowsPresent: input.workflowsPresent, requiredChecks: [...input.requiredChecks],
        nextNumber: existing?.nextNumber ?? 1, issues: existing?.issues ?? [], prs: existing?.prs ?? [] };
    });
  }
  setBranch(repo: RepoRef, branch: string, sha: Sha, parents: readonly Sha[]): void {
    this.change(table => {
      const row = getRepo(table, repo);
      row.commits[sha] = [...parents];
      row.branches[branch] = sha;
      for (const pr of row.prs) {
        if (pr.state.kind !== "open" || pr.headRef !== branch || pr.head === sha) continue;
        pr.head = sha;
        pr.mergeable = "unknown";
        pr.checks = { kind: "none" };
        pr.runs = [];
      }
    });
  }
  setPrFacts(ref: PrRef, facts: { mergeable?: Mergeable; checks?: ChecksRaw; failedRun?: boolean }): void {
    this.change(table => {
      const row = getPr(table, ref);
      if (facts.mergeable !== undefined) row.mergeable = facts.mergeable;
      if (facts.checks !== undefined) row.checks = facts.checks;
      if (facts.failedRun) {
        const at = this.clock();
        const id = String(table.nextRunId++);
        row.runs.push({ id, createdAt: at, failed: true });
        row.checks = { kind: "rollup", fact: { state: "fail", failedRunId: id, latestRunCreatedAt: at } };
      }
    });
  }
}
