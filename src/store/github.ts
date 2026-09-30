// GitHub port: the reads the facts round needs, the source checks effects make, and the deliverable writes.
// Raw facts only, no protocol logic. `facts` is one request (one GraphQL query on the gh backend); the other reads
// happen only for an effect's source check, a PrSubmit's live facts, or a commit pair not yet cached.

import type { ChecksFact, IssueRef, LifecycleEvent, Mergeable, Millis, PrRef, RepoRef, Sha } from "../core/index.ts";

export interface IssueRaw {
  readonly ref: IssueRef;
  readonly title: string;
  readonly open: boolean;
  readonly body: string;
  readonly createdAt: Millis;
  /** Chronological `closed` / `reopened` events. */
  readonly events: readonly LifecycleEvent[];
  /** Sub-issues; read only for the issue requested as `parent`. */
  readonly children: readonly IssueRef[];
}

/** What the createIssue source check compares: identity, title and body of an issue created since a proposal. */
export interface CreatedIssue {
  readonly ref: IssueRef;
  readonly title: string;
  readonly body: string;
  readonly createdAt: Millis;
}

export type PrStateRaw =
  | { readonly kind: "open" }
  | { readonly kind: "merged"; readonly mergeSha: Sha; readonly mergedAt: Millis }
  | { readonly kind: "closedUnmerged"; readonly closedAt: Millis };

/** Checks for the PR head. `none`: the head has no status-check rollup; `requiresChecks` then decides pass or pending. */
export type ChecksRaw = { readonly kind: "rollup"; readonly fact: ChecksFact } | { readonly kind: "none"; readonly requiresChecks: boolean };

/** A PR as an issue's closing reference: state, head and base, without body, checks or nested connections. */
export interface PrLinkRaw {
  readonly ref: PrRef;
  readonly state: PrStateRaw;
  readonly headRef: string;
  readonly head: Sha;
  readonly baseRepo: RepoRef;
  readonly base: string;
  /**
   * Issues the PR closes. A full PR: GitHub `closingIssuesReferences` (empty when the base is not the default branch).
   * A link: the issue whose `closedByPullRequestsReferences` listed it.
   */
  readonly closes: readonly IssueRef[];
}

export interface PrRaw extends PrLinkRaw {
  readonly title: string;
  readonly body: string;
  readonly mergeable: Mergeable;
  readonly checks: ChecksRaw;
}

export interface FactsRequest {
  /** Issues to read, each with the links of the PRs whose closing references include it. */
  readonly issues: readonly IssueRef[];
  /** Read with its sub-issues (each also with its closing-PR links). */
  readonly parent: IssueRef | null;
  /** PRs to read regardless of closing references (registered and adopted PRs). */
  readonly prs: readonly PrRef[];
  /** Branches whose current head is read (delivery bases). */
  readonly branches: readonly { readonly repo: RepoRef; readonly branch: string }[];
  /** Repositories whose default-branch head is read. */
  readonly repos: readonly RepoRef[];
}

export interface FactsResponse {
  readonly issues: readonly IssueRaw[];
  /** The requested PRs. */
  readonly prs: readonly PrRaw[];
  /** The closing-PR links of every issue read. */
  readonly links: readonly PrLinkRaw[];
  readonly branches: readonly { readonly repo: RepoRef; readonly branch: string; readonly head: Sha | null }[];
  readonly defaultHeads: readonly { readonly repo: RepoRef; readonly head: Sha }[];
}

export interface NewPr {
  readonly repo: RepoRef;
  readonly base: string;
  /** Head branch name in `repo`. */
  readonly head: string;
  readonly title: string;
  readonly body: string;
}

export type MergeOutcome = { readonly kind: "merged" } | { readonly kind: "rejected"; readonly detail: string };

/** Every method resolves with the fact or rejects (throws); the store turns a rejection into a StoreError. */
export interface GitHub {
  // ------------------------------------------------------------ reads
  facts(request: FactsRequest): Promise<FactsResponse>;
  /** `descendant` contains `ancestor`; false when either commit is unknown to `repo`. Immutable: callers cache it. */
  contains(repo: RepoRef, ancestor: Sha, descendant: Sha): Promise<boolean>;
  /** Current head of branch `branch` in `repo`; null when the branch does not exist. */
  branchHead(repo: RepoRef, branch: string): Promise<Sha | null>;
  issue(ref: IssueRef): Promise<IssueRaw>;
  pr(ref: PrRef): Promise<PrRaw>;
  /** Open PRs whose head is branch `head` of `repo` itself. */
  openPrsByHead(repo: RepoRef, head: string): Promise<readonly PrRaw[]>;
  /** Issues (never PRs) of `repo` created at or after `since`, read-after-write consistent. */
  issuesCreatedSince(repo: RepoRef, since: Millis): Promise<readonly CreatedIssue[]>;

  // ------------------------------------------------------------ deliverable writes
  createIssue(repo: RepoRef, title: string, body: string): Promise<IssueRef>;
  addSubIssue(parent: IssueRef, child: IssueRef): Promise<void>;
  editIssueBody(ref: IssueRef, body: string): Promise<void>;
  setIssueOpen(ref: IssueRef, open: boolean): Promise<void>;
  createPr(pr: NewPr): Promise<PrRef>;
  editPr(ref: PrRef, title: string, body: string): Promise<void>;
  /** Merge only when the PR head still equals `head`. A source-side refusal is `rejected`, not a throw. */
  mergePr(ref: PrRef, head: Sha): Promise<MergeOutcome>;
  /** Re-run the failed check run `runId` of `repo`. */
  rerunCheck(repo: RepoRef, runId: string): Promise<void>;
}
