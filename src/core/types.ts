// Domain types for the round-table core. Semantics: docs/design/core.md §1 and §3.
// Everything here is plain immutable data; parsing from GitHub or local files happens in store.

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Sha = Brand<string, "Sha">;
export type Hash = Brand<string, "Hash">;
export type RecordId = Brand<string, "RecordId">;
export type EventId = Brand<string, "EventId">;
export type AgentId = Brand<string, "AgentId">;
export type DraftId = Brand<string, "DraftId">;
export type ObligationId = Brand<string, "ObligationId">;
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

// ---------------------------------------------------------------- agenda

export interface ConvenedEntry {
  readonly issue: IssueRef;
  readonly target: DeliveryTarget;
  readonly designOnly: boolean;
  readonly adoptPr: PrRef | null;
}

export interface Agenda {
  readonly record: IssueRef;
  readonly createdAt: Millis;
  readonly parent: IssueRef | null;
  readonly convened: readonly ConvenedEntry[];
}

// ---------------------------------------------------------------- GitHub facts

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
  /** Decision ids whose body replacement markers are present in the hidden block. */
  readonly appliedDecisions: readonly RecordId[];
  /** Row ids parsed from the issue's acceptance table (or the parent's closure table). */
  readonly acceptanceRows: readonly string[];
  readonly children: readonly IssueRef[];
  /** Set when the issue was created from a draft. */
  readonly draftMarker: DraftId | null;
  readonly isAgendaRecord: boolean;
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
  readonly latestRunCreatedAt: Millis | null;
}

export interface PrFact {
  readonly ref: PrRef;
  readonly state: PrState;
  readonly head: Sha;
  readonly target: DeliveryTarget;
  readonly bodyHash: Hash;
  /** PrSubmit record whose applied marker the PR body carries. */
  readonly appliedSubmit: RecordId | null;
  readonly mergeable: Mergeable;
  readonly checks: ChecksFact;
  /** Issues in the PR's closing references (kept after merge). */
  readonly closes: readonly IssueRef[];
  readonly agendaMarker: boolean;
}

export interface CommitFacts {
  readonly onDefault: readonly { readonly repo: RepoRef; readonly sha: Sha }[];
  /** `descendant` contains `ancestor`. */
  readonly contains: readonly { readonly repo: RepoRef; readonly ancestor: Sha; readonly descendant: Sha }[];
  readonly defaultHead: readonly { readonly repo: RepoRef; readonly sha: Sha }[];
}

// ---------------------------------------------------------------- records (replies written as signed comments)

export type Author = { readonly kind: "main" } | { readonly kind: "seat"; readonly agentId: AgentId; readonly requestName: string };

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

export type GateStatus = "pass" | "fail" | "notRun";

export interface Finding {
  readonly id: string;
  readonly location: string;
  readonly consequence: string;
  readonly reproduction: string;
  readonly responsible: "owner" | "main";
}

export interface RowResult {
  readonly rowId: string;
  readonly command: string;
  readonly output: string;
  readonly pass: boolean;
}

export interface UnrelatedFailure {
  readonly description: string;
  readonly reproduction: string;
}

export interface Observed {
  readonly repo: RepoRef;
  readonly commit: Sha;
}

export type Verdict =
  | {
      readonly gate: "review";
      readonly observedHead: Sha;
      readonly gates: readonly [GateStatus, GateStatus, GateStatus, GateStatus, GateStatus];
      readonly findings: readonly Finding[];
    }
  | {
      readonly gate: "accept";
      readonly observedHead: Sha;
      readonly rows: readonly RowResult[];
      readonly findings: readonly Finding[];
      readonly unrelated: readonly UnrelatedFailure[];
    }
  | {
      readonly gate: "postMerge";
      readonly observed: readonly Observed[];
      readonly rows: readonly RowResult[];
      readonly unrelated: readonly UnrelatedFailure[];
    }
  | {
      readonly gate: "closure";
      readonly observed: readonly Observed[];
      readonly rows: readonly RowResult[];
    };

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
      readonly claim: RecordId;
      readonly verdict:
        | { readonly kind: "answered" | "outOfDomain" | "implDefect" | "acceptanceMethod" }
        | { readonly kind: "designGap"; readonly route: Route };
      readonly affected: readonly IssueRef[];
    }
  | {
      readonly subject: "noCodeClaim" | "splitClaim";
      readonly claim: RecordId;
      readonly member: IssueRef;
      readonly bodyHash: Hash;
      readonly verdict: "confirmed" | "refuted";
    }
  | {
      readonly subject: "blockedClaim";
      readonly claim: RecordId;
      readonly verdict: "replacePr" | "external" | "refuted";
      /** Stamped by the program: the maintainable PR abandoned by `replacePr`. */
      readonly abandon: PrRef | null;
    }
  | {
      readonly subject: "findings";
      readonly verdictRecord: RecordId;
      readonly perFinding: readonly { readonly findingId: string; readonly verdict: FindingVerdict }[];
    }
  | { readonly subject: "closed"; readonly member: IssueRef; readonly event: EventId; readonly bodyHash: Hash; readonly verdict: "confirmedNoCode" | "reopen" }
  | { readonly subject: "reopened"; readonly member: IssueRef; readonly event: EventId; readonly verdict: "restore" | "correction" | "reopenAccepted" }
  | { readonly subject: "checks"; readonly pr: PrRef; readonly runId: string; readonly verdict: "rerun" | "fixNeeded" | "external" }
  | { readonly subject: "postMergeFail" | "closureFail"; readonly verdictRecord: RecordId; readonly verdict: "correction" | "reverify" }
  | { readonly subject: "unrelated"; readonly verdictRecord: RecordId }
  | { readonly subject: "orphanDesign" | "migration" | "agendaGap" | "stall"; readonly key: Hash; readonly verdict: "resolved" | "external" }
  | { readonly subject: "effectFailed"; readonly effect: ObligationId; readonly failedAt: Millis; readonly verdict: "retry" | "external" }
  | { readonly subject: "designFix"; readonly verdictRecord: RecordId; readonly commit: Sha }
  | { readonly subject: "report"; readonly summary: string }
  | { readonly subject: "noCode"; readonly member: IssueRef; readonly bodyHash: Hash; readonly reason: string }
  | { readonly subject: "seated"; readonly requestName: string; readonly previous: AgentId | null; readonly agentId: AgentId }
  | { readonly subject: "woken"; readonly agentId: AgentId; readonly count: number };

export interface DecisionRecordBody {
  readonly kind: "decision";
  readonly decision: Decision;
  readonly rationale: string;
  readonly drafts: readonly Draft[];
  readonly bodyReplacements: readonly BodyReplacement[];
}

export type RecordBody =
  | {
      readonly kind: "prSubmit";
      readonly member: IssueRef;
      readonly branch: string;
      readonly head: Sha;
      readonly title: string;
      readonly body: string;
      readonly template: "fourLayer" | "docOnly";
      readonly retryNote: string | null;
    }
  | { readonly kind: "claim"; readonly claim: Claim }
  | { readonly kind: "verdict"; readonly obligation: ObligationId; readonly verdict: Verdict }
  | DecisionRecordBody;

/** Inputs a gate verdict observed; stamped by the program at admission (core.md §3 有效性). */
export type Manifest =
  | {
      readonly gate: "review";
      readonly head: Sha;
      readonly target: DeliveryTarget;
      readonly prBodyHash: Hash;
      readonly memberBodyHash: Hash;
      readonly contractDecisions: readonly RecordId[];
      readonly designCommits: readonly Sha[];
      readonly rejectedFindings: readonly string[];
    }
  | {
      readonly gate: "accept";
      readonly head: Sha;
      readonly target: DeliveryTarget;
      readonly memberBodyHash: Hash;
      readonly contractDecisions: readonly RecordId[];
      readonly designCommits: readonly Sha[];
    }
  | {
      readonly gate: "postMerge";
      readonly merges: readonly Observed[];
      readonly memberBodyHashes: readonly Hash[];
      readonly contractDecisions: readonly RecordId[];
      readonly designCommits: readonly Sha[];
    }
  | {
      readonly gate: "closure";
      readonly merges: readonly Observed[];
      readonly parentBodyHash: Hash;
      readonly children: readonly { readonly issue: IssueRef; readonly terminal: "merged" | "noCode" }[];
      readonly strandedDesign: readonly Sha[];
    };

/** A signed record as read back from the store (only records whose stamp verified). */
export interface StoredRecord {
  readonly id: RecordId;
  readonly at: Millis;
  readonly author: Author;
  /** The obligation this record answers, when it answers one. */
  readonly obligation: ObligationId | null;
  readonly idempotencyKey: string;
  /** Gate inputs stamped at admission; present on verdicts only. */
  readonly manifest: Manifest | null;
  readonly payloadHash: Hash;
  readonly body: RecordBody;
}

// ---------------------------------------------------------------- snapshot and host observation

export interface Snapshot {
  readonly agenda: Agenda;
  readonly issues: readonly IssueFact[];
  readonly prs: readonly PrFact[];
  readonly commits: CommitFacts;
  /** Verified records in write order. */
  readonly records: readonly StoredRecord[];
  /** Program effects whose marker object (e.g. a notice comment) exists at the source. */
  readonly effectMarkers: readonly ObligationId[];
}

export type RegistryStatus = "live" | "parked" | "aborted";

export interface RegisteredAgent {
  readonly id: AgentId;
  readonly requestName: string;
  readonly status: RegistryStatus;
}

export interface EffectFailure {
  readonly effect: ObligationId;
  readonly at: Millis;
  readonly error: string;
}

export interface Policy {
  readonly appendSystem: string;
  readonly systemBlocks: string;
}

export interface Host {
  readonly agents: readonly RegisteredAgent[];
  readonly failures: readonly EffectFailure[];
}
