// In-memory GitHub for local tests and dry runs: the same port as the gh backend, no network. It counts every call,
// so tests can assert the read budget of a round (omp-roundtable.md Q7) and that a no-op transition writes nothing.

import type { EventId, IssueRef, LifecycleEvent, Millis, PrRef, RepoRef, Sha } from "../core/index.ts";
import type { ChecksRaw, CreatedIssue, FactsRequest, FactsResponse, GitHub, IssueRaw, MergeOutcome, NewPr, PrLinkRaw, PrRaw, PrStateRaw } from "./github.ts";

interface IssueRow {
  ref: IssueRef;
  title: string;
  body: string;
  open: boolean;
  createdAt: Millis;
  events: LifecycleEvent[];
  children: IssueRef[];
}

interface PrRow {
  ref: PrRef;
  title: string;
  body: string;
  state: PrStateRaw;
  headRef: string;
  head: Sha;
  base: string;
  mergeable: PrRaw["mergeable"];
  checks: ChecksRaw;
  closes: IssueRef[];
}

const key = (r: IssueRef | PrRef): string => `${r.repo.owner}/${r.repo.name}#${r.number}`;
const repoKey = (r: RepoRef): string => `${r.owner}/${r.name}`;
const same = (a: IssueRef, b: IssueRef): boolean => key(a) === key(b);

export class FakeGitHub implements GitHub {
  readonly calls = new Map<string, number>();
  private readonly issues = new Map<string, IssueRow>();
  private readonly prs = new Map<string, PrRow>();
  private readonly branches = new Map<string, Sha>();
  private readonly defaults = new Map<string, string>();
  /** `${repo}|${ancestor}|${descendant}` for every contained pair. */
  private readonly ancestry = new Set<string>();
  private next = 1;
  private clock: number;
  private seq = 0;

  constructor(start: number = 1_000_000) {
    this.clock = start;
  }

  // ------------------------------------------------------------ test setup

  now(): Millis {
    this.clock += 1000;
    return this.clock as Millis;
  }
  count(method: string): number {
    return this.calls.get(method) ?? 0;
  }
  writes(): number {
    return ["createIssue", "addSubIssue", "editIssueBody", "setIssueOpen", "createPr", "editPr", "mergePr", "rerunCheck"].reduce((n, m) => n + this.count(m), 0);
  }
  addRepo(repo: RepoRef, defaultBranch: string, head: Sha): void {
    this.defaults.set(repoKey(repo), defaultBranch);
    this.branches.set(`${repoKey(repo)}:${defaultBranch}`, head);
  }
  setBranch(repo: RepoRef, branch: string, head: Sha, parents: readonly Sha[] = []): void {
    this.branches.set(`${repoKey(repo)}:${branch}`, head);
    for (const p of parents) this.addAncestry(repo, p, head);
  }
  addAncestry(repo: RepoRef, ancestor: Sha, descendant: Sha): void {
    this.ancestry.add(`${repoKey(repo)}|${ancestor}|${descendant}`);
  }
  seedIssue(repo: RepoRef, title: string, body: string, children: readonly IssueRef[] = []): IssueRef {
    const ref = { repo, number: this.next++ };
    this.issues.set(key(ref), { ref, title, body, open: true, createdAt: this.now(), events: [], children: [...children] });
    return ref;
  }
  row(ref: IssueRef): IssueRow {
    const row = this.issues.get(key(ref));
    if (row === undefined) throw new Error(`issue ${key(ref)} not found`);
    return row;
  }
  prRow(ref: PrRef): PrRow {
    const row = this.prs.get(key(ref));
    if (row === undefined) throw new Error(`PR ${key(ref)} not found`);
    return row;
  }
  settle(ref: PrRef, over: Partial<Pick<PrRow, "mergeable" | "checks">>): void {
    Object.assign(this.prRow(ref), over);
  }

  private tick(method: string): void {
    this.calls.set(method, this.count(method) + 1);
  }
  private issueRaw(row: IssueRow): IssueRaw {
    return { ref: row.ref, title: row.title, open: row.open, body: row.body, createdAt: row.createdAt, events: [...row.events], children: [...row.children] };
  }
  private prRaw(row: PrRow): PrRaw {
    return { ...row, baseRepo: row.ref.repo, closes: [...row.closes] };
  }
  private event(row: IssueRow, kind: "closed" | "reopened"): void {
    row.open = kind === "reopened";
    row.events.push({ id: `ev-${++this.seq}` as EventId, kind, at: this.now() });
  }

  // ------------------------------------------------------------ reads

  async facts(req: FactsRequest): Promise<FactsResponse> {
    this.tick("facts");
    const issues: IssueRaw[] = [];
    const prs: PrRaw[] = [];
    const links: PrLinkRaw[] = [];
    const closing = (ref: IssueRef): PrLinkRaw[] =>
      [...this.prs.values()]
        .filter((p) => p.closes.some((c) => same(c, ref)))
        .map((p) => ({ ref: p.ref, state: p.state, headRef: p.headRef, head: p.head, baseRepo: p.ref.repo, base: p.base, closes: [...p.closes] }));
    const take = (ref: IssueRef, withChildren: boolean): void => {
      const row = this.row(ref);
      issues.push({ ...this.issueRaw(row), children: withChildren ? [...row.children] : [] });
      links.push(...closing(ref));
    };
    for (const i of req.issues) take(i, false);
    if (req.parent !== null) {
      take(req.parent, true);
      for (const c of this.row(req.parent).children) take(c, false);
    }
    for (const p of req.prs) prs.push(this.prRaw(this.prRow(p)));
    return {
      issues,
      prs,
      links,
      branches: req.branches.map((b) => ({ ...b, head: this.branches.get(`${repoKey(b.repo)}:${b.branch}`) ?? null })),
      defaultHeads: req.repos.map((r) => {
        const head = this.branches.get(`${repoKey(r)}:${this.defaults.get(repoKey(r)) ?? "main"}`);
        if (head === undefined) throw new Error(`repo ${repoKey(r)} has no default branch`);
        return { repo: r, head };
      }),
    };
  }
  async contains(repo: RepoRef, ancestor: Sha, descendant: Sha): Promise<boolean> {
    this.tick("contains");
    return ancestor === descendant || this.ancestry.has(`${repoKey(repo)}|${ancestor}|${descendant}`);
  }
  async branchHead(repo: RepoRef, branch: string): Promise<Sha | null> {
    this.tick("branchHead");
    return this.branches.get(`${repoKey(repo)}:${branch}`) ?? null;
  }
  async issue(ref: IssueRef): Promise<IssueRaw> {
    this.tick("issue");
    return this.issueRaw(this.row(ref));
  }
  async pr(ref: PrRef): Promise<PrRaw> {
    this.tick("pr");
    return this.prRaw(this.prRow(ref));
  }
  async openPrsByHead(repo: RepoRef, head: string): Promise<readonly PrRaw[]> {
    this.tick("openPrsByHead");
    return [...this.prs.values()].filter((p) => repoKey(p.ref.repo) === repoKey(repo) && p.headRef === head && p.state.kind === "open").map((p) => this.prRaw(p));
  }
  async issuesCreatedSince(repo: RepoRef, since: Millis): Promise<readonly CreatedIssue[]> {
    this.tick("issuesCreatedSince");
    return [...this.issues.values()].filter((i) => repoKey(i.ref.repo) === repoKey(repo) && i.createdAt >= since).map((i) => ({ ref: i.ref, title: i.title, body: i.body, createdAt: i.createdAt }));
  }

  // ------------------------------------------------------------ writes

  async createIssue(repo: RepoRef, title: string, body: string): Promise<IssueRef> {
    this.tick("createIssue");
    const ref = { repo, number: this.next++ };
    this.issues.set(key(ref), { ref, title, body, open: true, createdAt: this.now(), events: [], children: [] });
    return ref;
  }
  async addSubIssue(parent: IssueRef, child: IssueRef): Promise<void> {
    this.tick("addSubIssue");
    const row = this.row(parent);
    if (!row.children.some((c) => same(c, child))) row.children.push(child);
  }
  async editIssueBody(ref: IssueRef, body: string): Promise<void> {
    this.tick("editIssueBody");
    this.row(ref).body = body;
  }
  async setIssueOpen(ref: IssueRef, open: boolean): Promise<void> {
    this.tick("setIssueOpen");
    const row = this.row(ref);
    if (row.open !== open) this.event(row, open ? "reopened" : "closed");
  }
  async createPr(pr: NewPr): Promise<PrRef> {
    this.tick("createPr");
    const head = this.branches.get(`${repoKey(pr.repo)}:${pr.head}`);
    if (head === undefined) throw new Error(`branch ${pr.head} does not exist`);
    const ref = { repo: pr.repo, number: this.next++ };
    const closes = [...pr.body.matchAll(/Closes\s+([^\s/]+)\/([^\s#]+)#(\d+)/g)].map((m) => ({ repo: { owner: m[1] ?? "", name: m[2] ?? "" }, number: Number(m[3]) }));
    const isDefault = this.defaults.get(repoKey(pr.repo)) === pr.base;
    this.prs.set(key(ref), {
      ref,
      title: pr.title,
      body: pr.body,
      state: { kind: "open" },
      headRef: pr.head,
      head,
      base: pr.base,
      mergeable: "unknown",
      checks: { kind: "rollup", fact: { state: "pending", failedRunId: null } },
      // GitHub resolves closing keywords only for PRs into the default branch
      closes: isDefault ? closes : [],
    });
    return ref;
  }
  async editPr(ref: PrRef, title: string, body: string): Promise<void> {
    this.tick("editPr");
    Object.assign(this.prRow(ref), { title, body });
  }
  async mergePr(ref: PrRef, head: Sha): Promise<MergeOutcome> {
    this.tick("mergePr");
    const row = this.prRow(ref);
    if (row.state.kind !== "open") return { kind: "rejected", detail: "already closed" };
    if (row.head !== head) return { kind: "rejected", detail: "head commit does not match" };
    const mergeSha = `${"m".repeat(8)}${String(++this.seq).padStart(32, "0")}` as Sha;
    row.state = { kind: "merged", mergeSha, mergedAt: this.now() };
    this.addAncestry(ref.repo, row.head, mergeSha);
    const base = `${repoKey(ref.repo)}:${row.base}`;
    const prior = this.branches.get(base);
    if (prior !== undefined) this.addAncestry(ref.repo, prior, mergeSha);
    this.branches.set(base, mergeSha);
    for (const c of row.closes) {
      const issue = this.issues.get(key(c));
      if (issue !== undefined && issue.open) this.event(issue, "closed");
    }
    return { kind: "merged" };
  }
  async rerunCheck(_repo: RepoRef, runId: string): Promise<void> {
    this.tick("rerunCheck");
    for (const p of this.prs.values()) if (p.checks.kind === "rollup" && p.checks.fact.failedRunId === runId) p.checks = { kind: "rollup", fact: { state: "pending", failedRunId: null } };
  }
}
