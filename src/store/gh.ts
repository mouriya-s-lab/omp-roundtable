// GitHub through the `gh` CLI. `facts` is one GraphQL query per round (omp-roundtable.md Q7); issue and PR listings
// also go through GraphQL, which is read-after-write consistent where the REST lists lagged (evidence doc).

import type { ChecksFact, EventId, IssueRef, LifecycleEvent, Mergeable, Millis, PrRef, RepoRef, Sha } from "../core/index.ts";
import type { FactsRequest, FactsResponse, GitHub, IssueRaw, MergeOutcome, NewPr, PrRaw, PrStateRaw } from "./github.ts";

// ---------------------------------------------------------------- boundary parsing

type Obj = Record<string, unknown>;

function object(value: unknown, where: string): Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${where}: expected object`);
  return value as Obj;
}
function text(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${where}: expected string`);
  return value;
}
function integer(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid ${where}: expected integer`);
  return value;
}
function list(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${where}: expected array`);
  return value;
}
function timestamp(value: unknown, where: string): Millis {
  const date = Date.parse(text(value, where));
  if (!Number.isFinite(date)) throw new Error(`Invalid ${where}: expected timestamp`);
  return date as Millis;
}
function sha(value: unknown, where: string): Sha {
  const result = text(value, where);
  if (!/^[a-f0-9]{40}$/i.test(result)) throw new Error(`Invalid ${where}: expected commit SHA`);
  return result as Sha;
}
function repoName(value: unknown, where: string): RepoRef {
  const parts = text(value, where).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`Invalid ${where}: expected owner/name`);
  return { owner: parts[0], name: parts[1] };
}
function nodes(value: unknown, where: string, complete: "next" | "previous" | "none"): readonly unknown[] {
  const conn = object(value, where);
  if (complete !== "none") {
    const info = object(conn.pageInfo, `${where}.pageInfo`);
    if (info[complete === "next" ? "hasNextPage" : "hasPreviousPage"] === true) throw new Error(`${where} has more entries than one page; refusing a partial read`);
  }
  return list(conn.nodes, `${where}.nodes`);
}
const refOf = (value: unknown, where: string): { repo: RepoRef; number: number } => {
  const o = object(value, where);
  return { repo: repoName(object(o.repository, `${where}.repository`).nameWithOwner, `${where}.repository.nameWithOwner`), number: integer(o.number, `${where}.number`) };
};

const FAILED = ["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"];

function prRaw(value: unknown): PrRaw {
  const node = object(value, "pullRequest");
  const ref = refOf(node, "pullRequest");
  const head = sha(node.headRefOid, "PR.headRefOid");
  const commits = nodes(node.commits, "PR.commits", "none");
  const commit = commits.length === 0 ? null : object(object(commits[0], "PR commit node").commit, "PR commit");
  if (commit !== null && sha(commit.oid, "PR commit oid") !== head) throw new Error(`PR ${ref.number}: head changed during read`);
  let checks: PrRaw["checks"];
  if (commit === null || commit.statusCheckRollup === null) {
    const baseRef = node.baseRef === null ? null : object(node.baseRef, "PR.baseRef");
    const rule = baseRef === null || baseRef.refUpdateRule === null ? null : object(baseRef.refUpdateRule, "PR.baseRef.refUpdateRule");
    const contexts = rule === null ? [] : list(rule.requiredStatusCheckContexts ?? [], "refUpdateRule.requiredStatusCheckContexts");
    const rules = baseRef === null ? [] : nodes(baseRef.rules, "PR.baseRef.rules", "none");
    checks = { kind: "none", requiresChecks: contexts.length > 0 || rules.some((r) => text(object(r, "rule").type, "rule.type") === "REQUIRED_STATUS_CHECKS") };
  } else {
    const rollup = object(commit.statusCheckRollup, "statusCheckRollup");
    const failed = nodes(rollup.contexts, "statusCheckRollup.contexts", "none")
      .map((c) => object(c, "check context"))
      .find((c) => c.__typename === "CheckRun" && FAILED.includes(typeof c.conclusion === "string" ? c.conclusion : ""));
    const state = text(rollup.state, "statusCheckRollup.state");
    const fact: ChecksFact = {
      state: state === "SUCCESS" ? "pass" : state === "FAILURE" || state === "ERROR" ? "fail" : state === "PENDING" || state === "EXPECTED" ? "pending" : "unknown",
      failedRunId: failed === undefined ? null : String(integer(failed.databaseId, "CheckRun.databaseId")),
    };
    checks = { kind: "rollup", fact };
  }
  const stateName = text(node.state, "PR.state");
  let state: PrStateRaw;
  if (stateName === "OPEN") state = { kind: "open" };
  else if (stateName === "MERGED") state = { kind: "merged", mergeSha: sha(object(node.mergeCommit, "PR.mergeCommit").oid, "PR.mergeCommit.oid"), mergedAt: timestamp(node.mergedAt, "PR.mergedAt") };
  else if (stateName === "CLOSED") state = { kind: "closedUnmerged", closedAt: timestamp(node.closedAt, "PR.closedAt") };
  else throw new Error(`Invalid PR.state: ${stateName}`);
  const mergeableName = text(node.mergeable, "PR.mergeable");
  const mergeable: Mergeable = mergeableName === "MERGEABLE" ? "yes" : mergeableName === "CONFLICTING" ? "no" : "unknown";
  return {
    ref,
    title: text(node.title, "PR.title"),
    body: text(node.body, "PR.body"),
    state,
    headRef: text(node.headRefName, "PR.headRefName"),
    head,
    baseRepo: repoName(object(node.baseRepository, "PR.baseRepository").nameWithOwner, "PR.baseRepository.nameWithOwner"),
    base: text(node.baseRefName, "PR.baseRefName"),
    mergeable,
    checks,
    closes: nodes(node.closingIssuesReferences, "PR.closingIssuesReferences", "next").map((n) => refOf(n, "closing issue")),
  };
}

function issueRaw(value: unknown, withChildren: boolean): { issue: IssueRaw; closingPrs: PrRaw[] } {
  const node = object(value, "issue");
  const ref = refOf(node, "issue");
  const events: LifecycleEvent[] = nodes(node.timelineItems, "issue.timelineItems", "previous").flatMap((e) => {
    const o = object(e, "timeline item");
    const kind = o.__typename === "ClosedEvent" ? "closed" : o.__typename === "ReopenedEvent" ? "reopened" : null;
    return kind === null ? [] : [{ id: text(o.id, "timeline.id") as EventId, kind, at: timestamp(o.createdAt, "timeline.createdAt") }];
  });
  const state = text(node.state, "issue.state");
  return {
    issue: {
      ref,
      title: text(node.title, "issue.title"),
      open: state === "OPEN",
      body: text(node.body, "issue.body"),
      createdAt: timestamp(node.createdAt, "issue.createdAt"),
      events: events.sort((a, b) => a.at - b.at),
      children: withChildren ? nodes(node.subIssues, "issue.subIssues", "next").map((c) => refOf(c, "sub-issue")) : [],
    },
    closingPrs: nodes(node.closedByPullRequestsReferences, "issue.closedByPullRequestsReferences", "next").map(prRaw),
  };
}

// ---------------------------------------------------------------- GraphQL documents

const PR_FIELDS = `number repository { nameWithOwner } title body state mergedAt closedAt mergeCommit { oid }
  headRefName headRefOid baseRepository { nameWithOwner } baseRefName mergeable
  baseRef { refUpdateRule { requiredStatusCheckContexts } rules(first: 50) { nodes { type } } }
  closingIssuesReferences(first: 50) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { databaseId conclusion } } } } } } }`;

const ISSUE_FIELDS = `number repository { nameWithOwner } title state body createdAt
  timelineItems(itemTypes: [CLOSED_EVENT, REOPENED_EVENT], last: 100) {
    nodes { __typename ... on ClosedEvent { id createdAt } ... on ReopenedEvent { id createdAt } } pageInfo { hasPreviousPage } }
  closedByPullRequestsReferences(includeClosedPrs: true, first: 50) { nodes { ...PR } pageInfo { hasNextPage } }`;

const FRAGMENTS = `fragment PR on PullRequest { ${PR_FIELDS} }\nfragment ISSUE on Issue { ${ISSUE_FIELDS} }`;

const repoArgs = (r: RepoRef): string => `owner: ${JSON.stringify(r.owner)}, name: ${JSON.stringify(r.name)}`;

/** The one query of a facts round: every issue (with closing PRs), the parent with its sub-issues, PRs and branch heads. */
export function factsQuery(req: FactsRequest): string {
  const parts: string[] = [];
  req.issues.forEach((i, n) => parts.push(`i${n}: repository(${repoArgs(i.repo)}) { issue(number: ${i.number}) { ...ISSUE } }`));
  if (req.parent !== null)
    parts.push(`parent: repository(${repoArgs(req.parent.repo)}) { issue(number: ${req.parent.number}) { ...ISSUE subIssues(first: 100) { nodes { ...ISSUE } pageInfo { hasNextPage } } } }`);
  req.prs.forEach((p, n) => parts.push(`p${n}: repository(${repoArgs(p.repo)}) { pullRequest(number: ${p.number}) { ...PR } }`));
  req.branches.forEach((b, n) => parts.push(`b${n}: repository(${repoArgs(b.repo)}) { ref(qualifiedName: ${JSON.stringify(`refs/heads/${b.branch}`)}) { target { oid } } }`));
  req.repos.forEach((r, n) => parts.push(`d${n}: repository(${repoArgs(r)}) { defaultBranchRef { target { oid } } }`));
  return `query {\n${parts.join("\n")}\n}\n${FRAGMENTS}`;
}

// ---------------------------------------------------------------- the backend

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const encoded = (value: string): string => encodeURIComponent(value);
const path = (repo: RepoRef): string => `repos/${encoded(repo.owner)}/${encoded(repo.name)}`;
const issuePath = (ref: IssueRef): string => `${path(ref.repo)}/issues/${ref.number}`;
const prPath = (ref: PrRef): string => `${path(ref.repo)}/pulls/${ref.number}`;

export class GhGitHub implements GitHub {
  constructor(private readonly gh: string = "gh") {}

  private async command(args: readonly string[]): Promise<CommandResult> {
    const proc = Bun.spawn([this.gh, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }
  private async run(args: readonly string[]): Promise<string> {
    const result = await this.command(args);
    if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout;
  }
  private async api(endpoint: string, method?: "POST" | "PATCH", fields: readonly string[] = []): Promise<unknown> {
    const output = await this.run(["api", endpoint, ...(method ? ["--method", method] : []), ...fields]);
    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new Error(`Invalid JSON from gh api ${endpoint}: ${output.slice(0, 200)}`);
    }
  }
  private async graphql(query: string): Promise<Obj> {
    const response = object(await this.api("graphql", undefined, ["-f", `query=${query}`]), "GraphQL response");
    if (response.errors !== undefined) throw new Error(`gh api graphql errors: ${JSON.stringify(response.errors)}`);
    return object(response.data, "GraphQL data");
  }

  async facts(req: FactsRequest): Promise<FactsResponse> {
    const data = await this.graphql(factsQuery(req));
    const issues: IssueRaw[] = [];
    const prs: PrRaw[] = [];
    const take = (value: unknown, withChildren: boolean, where: string): void => {
      if (value === null) throw new Error(`${where} not found`);
      const read = issueRaw(value, withChildren);
      issues.push(read.issue);
      prs.push(...read.closingPrs);
    };
    req.issues.forEach((i, n) => take(object(data[`i${n}`], `i${n}`).issue, false, `issue ${i.repo.owner}/${i.repo.name}#${i.number}`));
    if (req.parent !== null) {
      const parent = object(object(data.parent, "parent").issue, "parent issue");
      take(parent, true, "parent");
      for (const child of nodes(parent.subIssues, "parent.subIssues", "next")) take(child, false, "sub-issue");
    }
    req.prs.forEach((p, n) => {
      const node = object(data[`p${n}`], `p${n}`).pullRequest;
      if (node === null) throw new Error(`PR ${p.repo.owner}/${p.repo.name}#${p.number} not found`);
      prs.push(prRaw(node));
    });
    const branches = req.branches.map((b, n) => {
      const ref = object(data[`b${n}`], `b${n}`).ref;
      return { ...b, head: ref === null ? null : sha(object(object(ref, "ref").target, "ref.target").oid, "ref.target.oid") };
    });
    const defaultHeads = req.repos.map((r, n) => ({
      repo: r,
      head: sha(object(object(object(data[`d${n}`], `d${n}`).defaultBranchRef, "defaultBranchRef").target, "defaultBranchRef.target").oid, "defaultBranchRef.target.oid"),
    }));
    return { issues, prs, branches, defaultHeads };
  }

  async contains(repo: RepoRef, ancestor: Sha, descendant: Sha): Promise<boolean> {
    const result = await this.command(["api", `${path(repo)}/compare/${encoded(ancestor)}...${encoded(descendant)}`]);
    if (result.code !== 0) {
      if (/\bHTTP (404|422)\b/.test(result.stderr)) return false;
      throw new Error(`gh api compare failed (${result.code}): ${result.stderr.trim()}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error("Invalid JSON from gh api compare");
    }
    const status = text(object(value, "comparison").status, "comparison.status");
    if (!["ahead", "identical", "behind", "diverged"].includes(status)) throw new Error(`Invalid comparison.status: ${status}`);
    return status === "ahead" || status === "identical";
  }

  async branchHead(repo: RepoRef, branch: string): Promise<Sha | null> {
    const data = await this.graphql(`query { r: repository(${repoArgs(repo)}) { ref(qualifiedName: ${JSON.stringify(`refs/heads/${branch}`)}) { target { oid } } } }`);
    const ref = object(data.r, "repository").ref;
    return ref === null ? null : sha(object(object(ref, "ref").target, "ref.target").oid, "ref.target.oid");
  }

  async issue(ref: IssueRef): Promise<IssueRaw> {
    const data = await this.graphql(`query { r: repository(${repoArgs(ref.repo)}) { issue(number: ${ref.number}) { ...ISSUE subIssues(first: 100) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage } } } } }\n${FRAGMENTS}`);
    const node = object(data.r, "repository").issue;
    if (node === null) throw new Error(`issue ${ref.repo.owner}/${ref.repo.name}#${ref.number} not found`);
    return issueRaw(node, true).issue;
  }

  async pr(ref: PrRef): Promise<PrRaw> {
    const data = await this.graphql(`query { r: repository(${repoArgs(ref.repo)}) { pullRequest(number: ${ref.number}) { ...PR } } }\n${FRAGMENTS}`);
    const node = object(data.r, "repository").pullRequest;
    if (node === null) throw new Error(`PR ${ref.repo.owner}/${ref.repo.name}#${ref.number} not found`);
    return prRaw(node);
  }

  async openPrsByHead(repo: RepoRef, head: string): Promise<readonly PrRaw[]> {
    const data = await this.graphql(
      `query { r: repository(${repoArgs(repo)}) { pullRequests(headRefName: ${JSON.stringify(head)}, states: [OPEN], first: 20) { nodes { ...PR headRepositoryOwner { login } } pageInfo { hasNextPage } } } }\n${FRAGMENTS}`,
    );
    // Only heads in `repo` itself (a fork may use the same branch name).
    return nodes(object(data.r, "repository").pullRequests, "pullRequests", "next")
      .filter((n) => {
        const owner = object(n, "PR").headRepositoryOwner;
        return owner !== null && text(object(owner, "headRepositoryOwner").login, "headRepositoryOwner.login") === repo.owner;
      })
      .map(prRaw);
  }

  async issuesCreatedSince(repo: RepoRef, since: Millis): Promise<readonly IssueRaw[]> {
    const data = await this.graphql(
      `query { r: repository(${repoArgs(repo)}) { issues(filterBy: { since: ${JSON.stringify(new Date(since).toISOString())} }, first: 100, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ...ISSUE } } } }\n${FRAGMENTS}`,
    );
    return nodes(object(data.r, "repository").issues, "issues", "none")
      .map((n) => issueRaw(n, false).issue)
      .filter((i) => i.createdAt >= since);
  }

  async createIssue(repo: RepoRef, title: string, body: string): Promise<IssueRef> {
    const created = object(await this.api(`${path(repo)}/issues`, "POST", ["-f", `title=${title}`, "-f", `body=${body}`]), "created issue");
    return { repo, number: integer(created.number, "created issue.number") };
  }
  async addSubIssue(parent: IssueRef, child: IssueRef): Promise<void> {
    const id = integer(object(await this.api(issuePath(child)), "child issue").id, "child issue.id");
    object(await this.api(`${issuePath(parent)}/sub_issues`, "POST", ["-F", `sub_issue_id=${id}`]), "added sub-issue");
  }
  async editIssueBody(ref: IssueRef, body: string): Promise<void> {
    object(await this.api(issuePath(ref), "PATCH", ["-f", `body=${body}`]), "edited issue");
  }
  async setIssueOpen(ref: IssueRef, open: boolean): Promise<void> {
    object(await this.api(issuePath(ref), "PATCH", ["-f", `state=${open ? "open" : "closed"}`]), "edited issue");
  }
  async createPr(pr: NewPr): Promise<PrRef> {
    const created = object(await this.api(`${path(pr.repo)}/pulls`, "POST", ["-f", `base=${pr.base}`, "-f", `head=${pr.head}`, "-f", `title=${pr.title}`, "-f", `body=${pr.body}`]), "created PR");
    return { repo: pr.repo, number: integer(created.number, "created PR.number") };
  }
  async editPr(ref: PrRef, title: string, body: string): Promise<void> {
    object(await this.api(prPath(ref), "PATCH", ["-f", `title=${title}`, "-f", `body=${body}`]), "edited PR");
  }
  async mergePr(ref: PrRef, head: Sha): Promise<MergeOutcome> {
    const result = await this.command(["pr", "merge", String(ref.number), "-R", `${ref.repo.owner}/${ref.repo.name}`, "--merge", "--match-head-commit", head]);
    if (result.code === 0) return { kind: "merged" };
    const detail = result.stderr.trim() || result.stdout.trim();
    if (/head (branch|commit|sha).*(modified|changed|mismatch|match|differ)|does not match|not mergeable|merge conflict|cannot be merged|not possible to merge|already merged|already closed/i.test(detail)) return { kind: "rejected", detail };
    throw new Error(`gh pr merge failed (${result.code}): ${detail}`);
  }
  async rerunCheck(repo: RepoRef, runId: string): Promise<void> {
    if (!/^\d+$/.test(runId)) throw new Error(`Invalid check run id: ${runId}`);
    await this.run(["api", `${path(repo)}/actions/jobs/${runId}/rerun`, "--method", "POST"]);
  }
}
