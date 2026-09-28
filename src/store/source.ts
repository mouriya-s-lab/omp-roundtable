// Source port: the backend primitives that differ between GitHub (gh.ts) and the local state table (local.ts).
// Raw facts only. No markers, no signatures, no protocol logic: codec/snapshot/effects build everything else on top.

import type { ChecksFact, IssueRef, LifecycleEvent, Mergeable, Millis, PrRef, RepoRef, Sha } from "../core/index.ts";

export interface IssueRaw {
  readonly ref: IssueRef;
  readonly title: string;
  readonly open: boolean;
  readonly body: string;
  readonly createdAt: Millis;
}

export interface CommentRaw {
  /** Source-assigned comment id (GitHub REST comment id, or the local sequential id). */
  readonly id: string;
  readonly body: string;
  readonly createdAt: Millis;
}

export type PrStateRaw =
  | { readonly kind: "open" }
  | { readonly kind: "merged"; readonly mergeSha: Sha; readonly mergedAt: Millis }
  | { readonly kind: "closedUnmerged"; readonly closedAt: Millis };

/**
 * Checks as the source reports them for the PR head. `none`: the head has no status-check rollup at all
 * (snapshot.ts decides pass/pending from `requiresChecks`).
 */
export type ChecksRaw = { readonly kind: "rollup"; readonly fact: ChecksFact } | { readonly kind: "none" };

export interface PrRaw {
  readonly ref: PrRef;
  readonly title: string;
  readonly body: string;
  readonly state: PrStateRaw;
  readonly headRef: string;
  readonly head: Sha;
  /** Base repository and base branch. */
  readonly baseRepo: RepoRef;
  readonly base: string;
  readonly mergeable: Mergeable;
  readonly checks: ChecksRaw;
  /** Issues the PR closes (GitHub `closingIssuesReferences`). */
  readonly closes: readonly IssueRef[];
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

/**
 * Every method either resolves with the fact or rejects (throws); callers turn a rejection into a StoreError.
 * Comments on a PR use the PR's number as an IssueRef (GitHub models PR conversations as issue comments).
 */
export interface Source {
  // ------------------------------------------------------------ reads
  issue(ref: IssueRef): Promise<IssueRaw>;
  /** Chronological `closed` / `reopened` events. */
  issueEvents(ref: IssueRef): Promise<readonly LifecycleEvent[]>;
  subIssues(parent: IssueRef): Promise<readonly IssueRef[]>;
  /** Comments in creation order. */
  comments(ref: IssueRef): Promise<readonly CommentRaw[]>;
  /** Issues (never PRs) updated at or after `since`, any state. */
  listIssuesSince(repo: RepoRef, since: Millis): Promise<readonly IssueRaw[]>;
  /** Open issues (never PRs). */
  listOpenIssues(repo: RepoRef): Promise<readonly IssueRaw[]>;
  /** PRs, in any state, whose closing references include `issue`. */
  closingPrs(issue: IssueRef): Promise<readonly PrRef[]>;
  /** PRs, in any state, whose head is branch `head` of `repo`. */
  prsByHead(repo: RepoRef, head: string): Promise<readonly PrRef[]>;
  pr(ref: PrRef): Promise<PrRaw>;
  defaultHead(repo: RepoRef): Promise<Sha>;
  /** Current head of branch `branch` in `repo`; null when the branch does not exist. */
  branchHead(repo: RepoRef, branch: string): Promise<Sha | null>;
  /** `descendant` contains `ancestor`; false when either commit is unknown to `repo`. */
  contains(repo: RepoRef, ancestor: Sha, descendant: Sha): Promise<boolean>;
  /**
   * `base` requires status checks before merging (branch protection or rulesets). Decides what a PR head without
   * any rollup means, the way GitHub's merge button does.
   */
  requiresChecks(repo: RepoRef, base: string): Promise<boolean>;

  // ------------------------------------------------------------ writes
  createIssue(repo: RepoRef, title: string, body: string): Promise<IssueRaw>;
  editIssueBody(ref: IssueRef, body: string): Promise<void>;
  setIssueOpen(ref: IssueRef, open: boolean): Promise<void>;
  addSubIssue(parent: IssueRef, child: IssueRef): Promise<void>;
  comment(ref: IssueRef, body: string): Promise<CommentRaw>;
  createPr(pr: NewPr): Promise<PrRef>;
  editPr(ref: PrRef, title: string, body: string): Promise<void>;
  /** Merge only when the PR head still equals `head`. A source-side refusal is `rejected`, not a throw. */
  mergePr(ref: PrRef, head: Sha): Promise<MergeOutcome>;
  /** Re-run the failed check run `runId` of `repo`. */
  rerunCheck(repo: RepoRef, runId: string): Promise<void>;
}
