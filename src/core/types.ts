// Domain types for the round-table core. Semantics: docs/design/core.md §1 and §3.
// Everything here is plain immutable data; reading GitHub and the local state file happens in store.

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Sha = Brand<string, "Sha">;
export type Hash = Brand<string, "Hash">;
/** Identity of an accepted reply (claim, verdict, decision): hash of the ticket it answered and its payload. */
export type ReplyId = Brand<string, "ReplyId">;
export type EventId = Brand<string, "EventId">;
export type AgentId = Brand<string, "AgentId">;
export type DraftId = Brand<string, "DraftId">;
export type ObligationId = Brand<string, "ObligationId">;
export type AgendaId = Brand<string, "AgendaId">;
export type Millis = Brand<number, "Millis">;

export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

export interface IssueRef {
  readonly repo: RepoRef;
  readonly number: number;
}

export interface PrRef {
  readonly repo: RepoRef;
  readonly number: number;
}

export interface DeliveryTarget {
  readonly repo: RepoRef;
  readonly base: string;
}

export interface ConvenedEntry {
  readonly issue: IssueRef;
  readonly target: DeliveryTarget;
  readonly designOnly: boolean;
  readonly adoptPr: PrRef | null;
}

// ---------------------------------------------------------------- GitHub facts (read each round, never stored)

export interface LifecycleEvent {
  readonly id: EventId;
  readonly kind: "closed" | "reopened";
  readonly at: Millis;
}

export interface IssueFact {
  readonly ref: IssueRef;
  readonly open: boolean;
  /** Chronological close/reopen events. */
  readonly events: readonly LifecycleEvent[];
  readonly bodyHash: Hash;
  readonly children: readonly IssueRef[];
}

export type PrState =
  | { readonly kind: "open" }
  | { readonly kind: "merged"; readonly mergeSha: Sha; readonly mergedAt: Millis }
  | { readonly kind: "closedUnmerged"; readonly closedAt: Millis };

export type Mergeable = "yes" | "no" | "unknown";
export type ChecksState = "pass" | "fail" | "pending" | "unknown";

export interface ChecksFact {
  readonly state: ChecksState;
  readonly failedRunId: string | null;
}

/** A PR as an issue's closing reference shows it: enough for outcomes and for carried design commits. */
export interface PrLink {
  readonly ref: PrRef;
  readonly state: PrState;
  readonly headBranch: string;
  readonly head: Sha;
  readonly target: DeliveryTarget;
  /** Issues in the PR's closing references (kept after merge); empty when the base is not the default branch. */
  readonly closes: readonly IssueRef[];
}

/** A PR the agenda registered or adopted: its link plus what delivery reads (body, mergeability, checks). */
export interface PrFact extends PrLink {
  readonly bodyHash: Hash;
  readonly mergeable: Mergeable;
  readonly checks: ChecksFact;
}

export interface CommitFacts {
  readonly onDefault: readonly { readonly repo: RepoRef; readonly sha: Sha }[];
  /** `descendant` contains `ancestor`. */
  readonly contains: readonly { readonly repo: RepoRef; readonly ancestor: Sha; readonly descendant: Sha }[];
  /** Current head of every delivery target's base branch (start point of a new delivery branch); absent when the branch does not exist. */
  readonly baseHead: readonly { readonly repo: RepoRef; readonly base: string; readonly sha: Sha }[];
}

export interface Facts {
  readonly issues: readonly IssueFact[];
  /** Every registered and adopted PR. */
  readonly prs: readonly PrFact[];
  /** The closing references of every issue read, as links. */
  readonly links: readonly PrLink[];
  readonly commits: CommitFacts;
}

// ---------------------------------------------------------------- reply payloads

export type Anchor =
  | { readonly kind: "before"; readonly entry: IssueRef }
  | { readonly kind: "after"; readonly entry: IssueRef }
  | { readonly kind: "correctionOf"; readonly entry: IssueRef }
  | { readonly kind: "outsideAgenda" };

export interface Draft {
  readonly index: number;
  readonly repo: RepoRef;
  readonly title: string;
  readonly body: string;
  readonly anchor: Anchor;
  readonly target: DeliveryTarget;
  readonly designOnly: boolean;
}

export interface BodyReplacement {
  readonly issue: IssueRef;
  readonly baseHash: Hash;
  readonly body: string;
}

export type Route =
  | { readonly kind: "defaultFirst"; readonly commit: Sha; readonly migration: IssueRef | null }
  | { readonly kind: "withPr"; readonly commit: Sha; readonly designBranch: string }
  | { readonly kind: "future"; readonly commit: Sha; readonly carrier: IssueRef };

export type Context =
  | { readonly kind: "member"; readonly member: IssueRef }
  | { readonly kind: "unitVerification"; readonly unit: IssueRef }
  | { readonly kind: "agendaClosure" };

export type Claim =
  | {
      readonly kind: "question";
      readonly context: Context;
      readonly reproduction: string;
      readonly readings: readonly [string, string];
      readonly earliestGap: string;
      readonly proposal: string;
    }
  | { readonly kind: "noCode"; readonly member: IssueRef; readonly evidence: string }
  | { readonly kind: "split"; readonly member: IssueRef; readonly proposal: string }
  | { readonly kind: "blocked"; readonly member: IssueRef; readonly category: string; readonly attempts: string };

export interface Observed {
  readonly repo: RepoRef;
  readonly commit: Sha;
}

export type GateKind = "review" | "accept" | "postMerge" | "closure";

/**
 * A gate seat's judgement: ok or not ok, and its words (the reason when not ok). Everything factual — the head, the
 * acceptance rows, the observed commits — is the ticket's pin, stamped by the program (core.md §3 有效性).
 */
export interface Verdict {
  readonly gate: GateKind;
  readonly ok: boolean;
  readonly note: string;
}

export type FindingVerdict =
  | { readonly kind: "upheld"; readonly responsible: "owner" | "main" }
  | { readonly kind: "rejected"; readonly basis: string }
  | { readonly kind: "outOfScope"; readonly draft: Draft }
  | { readonly kind: "designGap"; readonly route: Route }
  | { readonly kind: "acceptanceMethod" };

/** Decision variants per subject: docs/design/core.briefs.md "Decision 变体". */
export type Decision =
  | {
      readonly subject: "question";
      readonly claim: ReplyId;
      readonly verdict:
        | { readonly kind: "answered" | "outOfDomain" | "implDefect" | "acceptanceMethod" }
        | { readonly kind: "designGap"; readonly route: Route };
      readonly affected: readonly IssueRef[];
    }
  | {
      readonly subject: "noCodeClaim" | "splitClaim";
      readonly claim: ReplyId;
      readonly member: IssueRef;
      readonly bodyHash: Hash;
      readonly verdict: "confirmed" | "refuted";
    }
  | { readonly subject: "blockedClaim"; readonly claim: ReplyId; readonly verdict: "replacePr" | "external" | "refuted" }
  | { readonly subject: "findings"; readonly verdictId: ReplyId; readonly verdict: FindingVerdict }
  | { readonly subject: "closed"; readonly member: IssueRef; readonly event: EventId; readonly bodyHash: Hash; readonly verdict: "confirmedNoCode" | "reopen" }
  | { readonly subject: "reopened"; readonly member: IssueRef; readonly event: EventId; readonly verdict: "restore" | "correction" | "reopenAccepted" }
  | { readonly subject: "checks"; readonly pr: PrRef; readonly runId: string; readonly verdict: "rerun" | "fixNeeded" | "external" }
  | { readonly subject: "postMergeFail" | "closureFail"; readonly verdictId: ReplyId; readonly verdict: "correction" | "reverify" }
  | { readonly subject: "orphanDesign" | "migration" | "agendaGap" | "stall"; readonly key: Hash; readonly verdict: "resolved" | "external" }
  | { readonly subject: "effectFailed"; readonly effect: ObligationId; readonly failedAt: Millis; readonly verdict: "retry" | "external" }
  | { readonly subject: "designFix"; readonly verdictId: ReplyId; readonly commit: Sha }
  | { readonly subject: "report"; readonly summary: string }
  | { readonly subject: "noCode"; readonly member: IssueRef; readonly bodyHash: Hash; readonly reason: string }
  | { readonly subject: "seated"; readonly requestName: string; readonly previous: AgentId | null; readonly agentId: AgentId };

export interface PrSubmit {
  readonly branch: string;
  readonly head: Sha;
  readonly title: string;
  readonly body: string;
  readonly template: "fourLayer" | "docOnly";
  readonly retryNote: string | null;
}

/** Inputs a gate verdict observed; stamped by the program when the verdict is accepted (core.md §3 有效性). */
export type Manifest =
  | {
      readonly gate: "review";
      readonly head: Sha;
      readonly target: DeliveryTarget;
      readonly prBodyHash: Hash;
      readonly memberBodyHash: Hash;
      readonly contractDecisions: readonly ReplyId[];
      readonly designCommits: readonly Sha[];
      readonly rejectedFindings: readonly string[];
    }
  | {
      readonly gate: "accept";
      readonly head: Sha;
      readonly target: DeliveryTarget;
      readonly memberBodyHash: Hash;
      readonly contractDecisions: readonly ReplyId[];
      readonly designCommits: readonly Sha[];
    }
  | {
      readonly gate: "postMerge";
      readonly merges: readonly Observed[];
      readonly memberBodyHashes: readonly Hash[];
      readonly contractDecisions: readonly ReplyId[];
      readonly designCommits: readonly Sha[];
    }
  | {
      readonly gate: "closure";
      readonly merges: readonly Observed[];
      readonly parentBodyHash: Hash;
      readonly children: readonly { readonly issue: IssueRef; readonly terminal: "merged" | "noCode" }[];
      readonly strandedDesign: readonly Sha[];
    };

// ---------------------------------------------------------------- agenda state (the local state file; core.md §1)

export interface DraftState {
  readonly id: DraftId;
  readonly draft: Draft;
  /** When the deciding reply was accepted; the store looks for an issue created after it before creating one. */
  readonly proposedAt: Millis;
  readonly issue: IssueRef | null;
}

export interface SubmitState extends PrSubmit {
  /** The deliver/fix ticket this submit completed. */
  readonly answered: ObligationId;
  /** The current PR carries this submit, crediting `appliedDesign`. */
  readonly applied: boolean;
  readonly appliedDesign: readonly Sha[];
}

export interface StoredVerdict {
  readonly id: ReplyId;
  readonly ticket: ObligationId;
  readonly attempt: number;
  readonly manifest: Manifest;
  readonly verdict: Verdict;
  /** The main session's ruling on this verdict when it is not ok. */
  readonly adjudication: FindingVerdict | null;
  /** postMerge / closure only. */
  readonly failDecision: "correction" | "reverify" | null;
}

export interface GateSlot {
  readonly attempt: number;
  readonly verdict: StoredVerdict | null;
}

export interface PendingClaim {
  readonly id: ReplyId;
  readonly claim: Claim;
}

/** A contract-changing decision in force: designGap or acceptanceMethod (core.md §3). */
export interface ContractDecision {
  readonly id: ReplyId;
  readonly affected: readonly IssueRef[];
  readonly routes: readonly { readonly route: Route; readonly carrier: IssueRef | null }[];
}

export interface ReplacementState {
  readonly decision: ReplyId;
  readonly issue: IssueRef;
  readonly baseHash: Hash;
  readonly body: string;
  readonly targetHash: Hash;
  readonly applied: boolean;
}

export interface Repair {
  readonly id: ReplyId;
  readonly rationale: string;
}

export interface MemberState {
  readonly issue: IssueRef;
  readonly submit: SubmitState | null;
  /** PRs the program created for this member, plus the PR adopted at convening. */
  readonly prs: readonly PrRef[];
  /** PRs given up by `replacePr`. */
  readonly replaced: readonly PrRef[];
  readonly review: GateSlot;
  readonly accept: GateSlot;
  /** Ids of not-ok review verdicts the main session adjudicated `rejected`. */
  readonly rejectedFindings: readonly string[];
  /** Open repair items from decisions, with the decision's rationale for the fix brief; cleared by the next `PrSubmit`. */
  readonly implDefect: Repair | null;
  readonly fixNeeded: Repair | null;
  readonly designFixes: readonly { readonly verdictId: ReplyId; readonly commit: Sha }[];
  readonly checks: { readonly runId: string; readonly verdict: "rerun" | "fixNeeded" | "external"; readonly rerunDone: boolean } | null;
  /** The failing check run whose `fix` was completed most recently. */
  readonly fixedRun: string | null;
  readonly noCode: { readonly bodyHash: Hash; readonly at: Millis } | null;
  readonly closed: { readonly event: EventId; readonly bodyHash: Hash; readonly verdict: "confirmedNoCode" | "reopen" } | null;
  readonly reopened: { readonly event: EventId; readonly verdict: "restore" | "correction" | "reopenAccepted" } | null;
  readonly external: boolean;
}

export interface UnitState {
  readonly top: IssueRef;
  readonly postMerge: GateSlot;
}

export interface SeatRecord {
  readonly requestName: string;
  readonly holder: AgentId | null;
}

export interface SubjectDecision {
  readonly subject: "orphanDesign" | "migration" | "agendaGap" | "stall";
  readonly key: Hash;
  readonly verdict: "resolved" | "external";
}

export interface AgendaState {
  /** Incremented on every write; the store compares it before replacing the file. */
  readonly version: number;
  readonly id: AgendaId;
  readonly convenedAt: Millis;
  readonly parent: IssueRef | null;
  readonly convened: readonly ConvenedEntry[];
  readonly drafts: readonly DraftState[];
  readonly members: readonly MemberState[];
  readonly units: readonly UnitState[];
  readonly closure: GateSlot;
  readonly claims: readonly PendingClaim[];
  readonly contracts: readonly ContractDecision[];
  readonly replacements: readonly ReplacementState[];
  readonly subjects: readonly SubjectDecision[];
  readonly effectDecisions: readonly { readonly effect: ObligationId; readonly failedAt: Millis; readonly verdict: "retry" | "external" }[];
  readonly seats: readonly SeatRecord[];
  /** The main session's most recent accepted decision: a resend of it after a lost response is answered `same`. */
  readonly lastDecision: ReplyId | null;
  readonly reported: boolean;
}

// ---------------------------------------------------------------- host observation

export type RegistryStatus = "live" | "parked" | "aborted";

export interface RegisteredAgent {
  readonly id: AgentId;
  readonly requestName: string;
  readonly status: RegistryStatus;
  /** Start of the current parked episode; null unless parked. */
  readonly parkedSince: Millis | null;
}

export interface EffectFailure {
  readonly effect: ObligationId;
  readonly at: Millis;
  readonly error: string;
}

/** What realize takes from outside the agenda: policy text for briefs and the agent types seats are spawned as. */
export interface Policy {
  readonly appendSystem: string;
  readonly systemBlocks: string;
  /** Native `task` agent types: owner seats (default task:high) and gate seats (default task:mid). */
  readonly seatAgents: { readonly owner: string; readonly gate: string };
}

export interface Host {
  readonly agents: readonly RegisteredAgent[];
  readonly failures: readonly EffectFailure[];
}
