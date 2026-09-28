import type { ChecksFact, EventId, IssueRef, LifecycleEvent, Mergeable, Millis, PrRef, RepoRef, Sha } from "../core/index.ts";
import type { CommentRaw, IssueRaw, MergeOutcome, NewPr, PrRaw, PrStateRaw, Source } from "./source.ts";

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${where}: expected object`);
  return value as Record<string, unknown>;
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
function nullableText(value: unknown, where: string): string | null {
  return value === null ? null : text(value, where);
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
  const name = text(value, where);
  const parts = name.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`Invalid ${where}: expected owner/name`);
  return { owner: parts[0], name: parts[1] };
}
function dateOrNull(value: unknown, where: string): Millis | null {
  return value === null ? null : timestamp(value, where);
}
function issueRaw(value: unknown, repo: RepoRef): IssueRaw {
  const issue = object(value, "issue");
  const state = text(issue.state, "issue.state");
  if (state !== "open" && state !== "closed") throw new Error(`Invalid issue.state: ${state}`);
  return {
    ref: { repo, number: integer(issue.number, "issue.number") },
    title: text(issue.title, "issue.title"), open: state === "open",
    body: nullableText(issue.body, "issue.body") ?? "",
    createdAt: timestamp(issue.created_at, "issue.created_at"),
  };
}
function commentRaw(value: unknown): CommentRaw {
  const comment = object(value, "comment");
  return { id: String(integer(comment.id, "comment.id")), body: text(comment.body, "comment.body"), createdAt: timestamp(comment.created_at, "comment.created_at") };
}
function connection(value: unknown, where: string): { nodes: readonly unknown[]; next: string | null } {
  const conn = object(value, where);
  const info = object(conn.pageInfo, `${where}.pageInfo`);
  if (typeof info.hasNextPage !== "boolean") throw new Error(`Invalid ${where}.pageInfo.hasNextPage`);
  const end = nullableText(info.endCursor, `${where}.pageInfo.endCursor`);
  if (info.hasNextPage && !end) throw new Error(`Invalid ${where}: next page without cursor`);
  return { nodes: list(conn.nodes, `${where}.nodes`), next: info.hasNextPage ? end : null };
}
function graphqlIssue(value: unknown): IssueRef {
  const issue = object(value, "GraphQL issue reference");
  const repository = object(issue.repository, "issue.repository");
  return { repo: repoName(repository.nameWithOwner, "issue.repository.nameWithOwner"), number: integer(issue.number, "issue.number") };
}
function graphqlPr(value: unknown): PrRef {
  const pr = object(value, "GraphQL PR reference");
  const repository = object(pr.repository, "PR.repository");
  return { repo: repoName(repository.nameWithOwner, "PR.repository.nameWithOwner"), number: integer(pr.number, "PR.number") };
}
function encoded(value: string): string { return encodeURIComponent(value); }
function path(repo: RepoRef): string { return `repos/${encoded(repo.owner)}/${encoded(repo.name)}`; }
function issuePath(ref: IssueRef): string { return `${path(ref.repo)}/issues/${ref.number}`; }
function prPath(ref: PrRef): string { return `${path(ref.repo)}/pulls/${ref.number}`; }

const PR_QUERY = `query($owner:String!, $name:String!, $number:Int!, $issues:String, $checks:String) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    title body state mergedAt closedAt mergeCommit { oid }
    headRefName headRefOid baseRepository { nameWithOwner } baseRefName mergeable
    closingIssuesReferences(first:100,after:$issues) { nodes { number repository { nameWithOwner } } pageInfo { hasNextPage endCursor } }
    commits(last:1) { nodes { commit { oid statusCheckRollup { state
      contexts(first:100,after:$checks) { nodes { __typename ... on CheckRun { databaseId conclusion startedAt } }
        pageInfo { hasNextPage endCursor } } } } } }
  } }
}`;
const CLOSING_QUERY = `query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner,name:$name) { issue(number:$number) {
    closedByPullRequestsReferences(includeClosedPrs:true,first:100,after:$cursor) {
      nodes { number repository { nameWithOwner } } pageInfo { hasNextPage endCursor }
    }
  } }
}`;

interface CommandResult { readonly stdout: string; readonly stderr: string; readonly code: number }

export class GhSource implements Source {
  constructor(private readonly gh: string = "gh") {}

  private async command(args: readonly string[]): Promise<CommandResult> {
    const process = Bun.spawn([this.gh, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
    ]);
    return { stdout, stderr, code };
  }
  private async run(args: readonly string[]): Promise<string> {
    const result = await this.command(args);
    if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout;
  }
  private async api(endpoint: string, method?: "POST" | "PATCH" | "PUT", fields: readonly string[] = []): Promise<unknown> {
    const args = ["api", endpoint, ...(method ? ["--method", method] : []), ...fields];
    const output = await this.run(args);
    try { return JSON.parse(output) as unknown; }
    catch { throw new Error(`Invalid JSON from gh api ${endpoint}: ${output.slice(0, 200)}`); }
  }
  private async optionalApi(endpoint: string): Promise<unknown | null> {
    const result = await this.command(["api", endpoint]);
    if (result.code !== 0) {
      if (/\bHTTP 404\b/.test(result.stderr)) return null;
      throw new Error(`gh api ${endpoint} failed (${result.code}): ${result.stderr.trim()}`);
    }
    try { return JSON.parse(result.stdout) as unknown; }
    catch { throw new Error(`Invalid JSON from gh api ${endpoint}`); }
  }
  private async pages(endpoint: string): Promise<readonly unknown[]> {
    // --jq emits one compact JSON object per row, across every API page.
    const output = await this.run(["api", endpoint, "--paginate", "--jq", ".[]"]);
    return output.trim() === "" ? [] : output.trimEnd().split("\n").map((line) => {
      try { return JSON.parse(line) as unknown; }
      catch { throw new Error(`Invalid paginated JSON from gh api ${endpoint}: ${line.slice(0, 200)}`); }
    });
  }
  private async graphql(query: string, repo: RepoRef, number: number, cursors: Readonly<Record<string, string | null>>): Promise<Record<string, unknown>> {
    const fields = ["-f", `query=${query}`, "-f", `owner=${repo.owner}`, "-f", `name=${repo.name}`, "-F", `number=${number}`];
    for (const [key, value] of Object.entries(cursors)) if (value !== null) fields.push("-f", `${key}=${value}`);
    const response = object(await this.api("graphql", undefined, fields), "GraphQL response");
    if (response.errors !== undefined) throw new Error(`gh api graphql errors: ${JSON.stringify(response.errors)}`);
    return object(response.data, "GraphQL data");
  }
  private async prQuery(ref: PrRef, issues: string | null, checks: string | null): Promise<Record<string, unknown>> {
    const data = await this.graphql(PR_QUERY, ref.repo, ref.number, { issues, checks });
    const result = object(data.repository, "repository").pullRequest;
    if (result === null) throw new Error(`PR ${ref.repo.owner}/${ref.repo.name}#${ref.number} not found`);
    return object(result, "pullRequest");
  }

  async issue(ref: IssueRef): Promise<IssueRaw> { return issueRaw(await this.api(issuePath(ref)), ref.repo); }
  async issueEvents(ref: IssueRef): Promise<readonly LifecycleEvent[]> {
    const events: LifecycleEvent[] = [];
    for (const value of await this.pages(`${issuePath(ref)}/timeline?per_page=100`)) {
      const event = object(value, "issue timeline event");
      if (event.event === "closed" || event.event === "reopened") events.push({
        id: String(integer(event.id, "timeline.id")) as EventId,
        kind: event.event, at: timestamp(event.created_at, "timeline.created_at"),
      });
    }
    return events.sort((a, b) => a.at - b.at);
  }
  async subIssues(parent: IssueRef): Promise<readonly IssueRef[]> {
    return (await this.pages(`${issuePath(parent)}/sub_issues?per_page=100`)).map((value) => ({
      repo: parent.repo, number: integer(object(value, "sub-issue").number, "sub-issue.number"),
    }));
  }
  async comments(ref: IssueRef): Promise<readonly CommentRaw[]> {
    return (await this.pages(`${issuePath(ref)}/comments?per_page=100`)).map(commentRaw).sort((a, b) => a.createdAt - b.createdAt);
  }
  // Issue and PR listings go through GraphQL connections: the REST list endpoints lag behind writes (a just-created
  // issue was absent from `GET /issues?state=open` 0.6–2.7 s later while GraphQL listed it), and a lagging listing
  // would let convene / createIssue / openPr write a second object.
  async listIssuesSince(repo: RepoRef, since: Millis): Promise<readonly IssueRaw[]> {
    return this.listIssues(repo, `filterBy:{since:${JSON.stringify(new Date(since).toISOString())}}`);
  }
  async listOpenIssues(repo: RepoRef): Promise<readonly IssueRaw[]> {
    return this.listIssues(repo, "states:[OPEN]");
  }
  private async listIssues(repo: RepoRef, filter: string): Promise<readonly IssueRaw[]> {
    const out: IssueRaw[] = [];
    let cursor: string | null = null;
    do {
      const query = `query($owner:String!, $name:String!, $cursor:String) { repository(owner:$owner,name:$name) {
        issues(${filter}, first:100, after:$cursor, orderBy:{field:CREATED_AT,direction:ASC}) {
          nodes { number title state body createdAt } pageInfo { hasNextPage endCursor } } } }`;
      const fields = ["-f", `query=${query}`, "-f", `owner=${repo.owner}`, "-f", `name=${repo.name}`, ...(cursor === null ? [] : ["-f", `cursor=${cursor}`])];
      const response = object(await this.api("graphql", undefined, fields), "GraphQL response");
      if (response.errors !== undefined) throw new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
      const page = connection(object(object(response.data, "data").repository, "repository").issues, "issues");
      for (const value of page.nodes) {
        const node = object(value, "listed issue");
        const state = text(node.state, "issue.state");
        out.push({
          ref: { repo, number: integer(node.number, "issue.number") },
          title: text(node.title, "issue.title"),
          open: state === "OPEN",
          body: text(node.body, "issue.body"),
          createdAt: timestamp(node.createdAt, "issue.createdAt"),
        });
      }
      cursor = page.next;
    } while (cursor !== null);
    return out;
  }
  async closingPrs(issue: IssueRef): Promise<readonly PrRef[]> {
    const result: PrRef[] = [];
    let cursor: string | null = null;
    do {
      const data = await this.graphql(CLOSING_QUERY, issue.repo, issue.number, { cursor });
      const node = object(data.repository, "repository").issue;
      if (node === null) throw new Error(`Issue ${issue.repo.owner}/${issue.repo.name}#${issue.number} not found`);
      const page = connection(object(node, "issue").closedByPullRequestsReferences, "closedByPullRequestsReferences");
      result.push(...page.nodes.map(graphqlPr));
      cursor = page.next;
    } while (cursor !== null);
    return result;
  }
  async prsByHead(repo: RepoRef, head: string): Promise<readonly PrRef[]> {
    const out: PrRef[] = [];
    let cursor: string | null = null;
    do {
      const query = `query($owner:String!, $name:String!, $head:String!, $cursor:String) { repository(owner:$owner,name:$name) {
        pullRequests(headRefName:$head, first:100, after:$cursor, orderBy:{field:CREATED_AT,direction:ASC}) {
          nodes { number headRepositoryOwner { login } } pageInfo { hasNextPage endCursor } } } }`;
      const fields = ["-f", `query=${query}`, "-f", `owner=${repo.owner}`, "-f", `name=${repo.name}`, "-f", `head=${head}`, ...(cursor === null ? [] : ["-f", `cursor=${cursor}`])];
      const response = object(await this.api("graphql", undefined, fields), "GraphQL response");
      if (response.errors !== undefined) throw new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
      const page = connection(object(object(response.data, "data").repository, "repository").pullRequests, "pullRequests");
      for (const value of page.nodes) {
        const node = object(value, "listed PR");
        // Only heads in `repo` itself (a fork may use the same branch name).
        const owner = node.headRepositoryOwner === null ? null : text(object(node.headRepositoryOwner, "headRepositoryOwner").login, "headRepositoryOwner.login");
        if (owner === repo.owner) out.push({ repo, number: integer(node.number, "PR.number") });
      }
      cursor = page.next;
    } while (cursor !== null);
    return out;
  }
  async pr(ref: PrRef): Promise<PrRaw> {
    const node = await this.prQuery(ref, null, null);
    const closes: IssueRef[] = [];
    let issues = connection(node.closingIssuesReferences, "closingIssuesReferences");
    closes.push(...issues.nodes.map(graphqlIssue));
    while (issues.next !== null) {
      issues = connection((await this.prQuery(ref, issues.next, null)).closingIssuesReferences, "closingIssuesReferences");
      closes.push(...issues.nodes.map(graphqlIssue));
    }
    const commits = connectionlessNodes(node.commits, "PR.commits");
    const latest = commits.at(0);
    if (!latest) throw new Error(`PR ${ref.number} has no commits`);
    const commit = object(object(latest, "PR commit node").commit, "PR commit");
    const head = sha(node.headRefOid, "PR.headRefOid");
    if (sha(commit.oid, "PR commit oid") !== head) throw new Error(`PR ${ref.number}: head changed during read`);
    let checks: PrRaw["checks"] = { kind: "none" };
    if (commit.statusCheckRollup !== null) {
      const rollup = object(commit.statusCheckRollup, "statusCheckRollup");
      const checkRuns: { id: string; failed: boolean; at: Millis | null }[] = [];
      const recordContexts = (contexts: readonly unknown[]): void => {
        for (const value of contexts) {
          const context = object(value, "check context");
          if (context.__typename !== "CheckRun") {
            if (context.__typename !== "StatusContext") throw new Error(`Unexpected check context: ${String(context.__typename)}`);
            continue;
          }
          const conclusion = nullableText(context.conclusion, "CheckRun.conclusion");
          const id = String(integer(context.databaseId, "CheckRun.databaseId"));
          // REST has no created_at; a just-requested QUEUED Actions rerun exposed
          // started_at (sandbox check run 109040570019), so use GraphQL startedAt.
          const at = dateOrNull(context.startedAt, "CheckRun.startedAt");
          checkRuns.push({ id, at, failed: ["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"].includes(conclusion ?? "") });
        }
      };
      let contexts = connection(rollup.contexts, "statusCheckRollup.contexts");
      recordContexts(contexts.nodes);
      while (contexts.next !== null) {
        const next = await this.prQuery(ref, null, contexts.next);
        const nextCommits = connectionlessNodes(next.commits, "PR.commits");
        const nextCommit = object(object(nextCommits[0], "PR commit node").commit, "PR commit");
        if (sha(nextCommit.oid, "PR commit oid") !== head) throw new Error(`PR ${ref.number}: head changed during check pagination`);
        const nextRollup = object(nextCommit.statusCheckRollup, "statusCheckRollup");
        contexts = connection(nextRollup.contexts, "statusCheckRollup.contexts");
        recordContexts(contexts.nodes);
      }
      const state = text(rollup.state, "statusCheckRollup.state");
      const fact: ChecksFact = {
        state: state === "SUCCESS" ? "pass" : state === "FAILURE" || state === "ERROR" ? "fail" : state === "PENDING" || state === "EXPECTED" ? "pending" : "unknown",
        failedRunId: checkRuns.find((run) => run.failed)?.id ?? null,
        latestRunCreatedAt: checkRuns.reduce<Millis | null>((latest, run) => run.at !== null && (latest === null || run.at > latest) ? run.at : latest, null),
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
      ref, title: text(node.title, "PR.title"), body: text(node.body, "PR.body"), state,
      headRef: text(node.headRefName, "PR.headRefName"), head,
      baseRepo: repoName(object(node.baseRepository, "PR.baseRepository").nameWithOwner, "PR.baseRepository.nameWithOwner"),
      base: text(node.baseRefName, "PR.baseRefName"), mergeable, checks, closes,
    };
  }
  async defaultHead(repo: RepoRef): Promise<Sha> {
    const branch = text(object(await this.api(path(repo)), "repository").default_branch, "repository.default_branch");
    return sha(object(object(await this.api(`${path(repo)}/branches/${encoded(branch)}`), "branch").commit, "branch.commit").sha, "branch.commit.sha");
  }
  async branchHead(repo: RepoRef, branch: string): Promise<Sha | null> {
    const found = await this.optionalApi(`${path(repo)}/branches/${encoded(branch)}`);
    return found === null ? null : sha(object(object(found, "branch").commit, "branch.commit").sha, "branch.commit.sha");
  }
  async contains(repo: RepoRef, ancestor: Sha, descendant: Sha): Promise<boolean> {
    const result = await this.command(["api", `${path(repo)}/compare/${encoded(ancestor)}...${encoded(descendant)}`]);
    if (result.code !== 0) {
      if (/\bHTTP (404|422)\b/.test(result.stderr)) return false;
      throw new Error(`gh api compare failed (${result.code}): ${result.stderr.trim()}`);
    }
    let value: unknown;
    try { value = JSON.parse(result.stdout) as unknown; }
    catch { throw new Error("Invalid JSON from gh api compare"); }
    const status = text(object(value, "comparison").status, "comparison.status");
    if (!["ahead", "identical", "behind", "diverged"].includes(status)) throw new Error(`Invalid comparison.status: ${status}`);
    return status === "ahead" || status === "identical";
  }
  async requiresChecks(repo: RepoRef, base: string): Promise<boolean> {
    const branch = encoded(base);
    const protection = await this.optionalApi(`${path(repo)}/branches/${branch}/protection/required_status_checks`);
    if (protection !== null) {
      const checks = object(protection, "required_status_checks");
      if (list(checks.contexts, "required_status_checks.contexts").length > 0 || list(checks.checks, "required_status_checks.checks").length > 0) return true;
    }
    const rules = await this.pages(`${path(repo)}/rules/branches/${branch}?per_page=100`);
    return rules.some((rule) => text(object(rule, "branch rule").type, "branch rule.type") === "required_status_checks");
  }

  async createIssue(repo: RepoRef, title: string, body: string): Promise<IssueRaw> {
    return issueRaw(await this.api(`${path(repo)}/issues`, "POST", ["-f", `title=${title}`, "-f", `body=${body}`]), repo);
  }
  async editIssueBody(ref: IssueRef, body: string): Promise<void> {
    object(await this.api(issuePath(ref), "PATCH", ["-f", `body=${body}`]), "edited issue");
  }
  async setIssueOpen(ref: IssueRef, open: boolean): Promise<void> {
    object(await this.api(issuePath(ref), "PATCH", ["-f", `state=${open ? "open" : "closed"}`]), "edited issue");
  }
  async addSubIssue(parent: IssueRef, child: IssueRef): Promise<void> {
    if (parent.repo.owner !== child.repo.owner || parent.repo.name !== child.repo.name) throw new Error("Sub-issue must belong to parent's repository");
    const id = integer(object(await this.api(issuePath(child)), "child issue").id, "child issue.id");
    object(await this.api(`${issuePath(parent)}/sub_issues`, "POST", ["-F", `sub_issue_id=${id}`]), "added sub-issue");
  }
  async comment(ref: IssueRef, body: string): Promise<CommentRaw> {
    return commentRaw(await this.api(`${issuePath(ref)}/comments`, "POST", ["-f", `body=${body}`]));
  }
  async createPr(pr: NewPr): Promise<PrRef> {
    const result = object(await this.api(`${path(pr.repo)}/pulls`, "POST", ["-f", `base=${pr.base}`, "-f", `head=${pr.head}`, "-f", `title=${pr.title}`, "-f", `body=${pr.body}`]), "created PR");
    return { repo: pr.repo, number: integer(result.number, "created PR.number") };
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

function connectionlessNodes(value: unknown, where: string): readonly unknown[] {
  return list(object(value, where).nodes, `${where}.nodes`);
}
