// Public API of the store (consumed by the seat adapter). The store holds no facts in process:
// every call reads the Source and returns; it never decides whether an effect should run (core does).

import type { AdmitFacts, Author, ConvenedEntry, IssueRef, NewRecord, ObligationId, ProgramAction, RepoRef, Snapshot, StoredRecord } from "../core/index.ts";
import { readAdmitFacts } from "./admit-facts.ts";
import { convene } from "./convene.ts";
import { execute } from "./effects.ts";
import type { HmacKey } from "./key.ts";
import { writeRecord } from "./records.ts";
import { readSnapshot } from "./snapshot.ts";
import type { Source } from "./source.ts";

export type StoreResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: StoreError };

export type StoreError =
  /** Any failure while building a Snapshot: the whole read is void (never a partial Snapshot). */
  | { readonly kind: "read"; readonly detail: string }
  | { readonly kind: "write"; readonly detail: string }
  /** The source contradicts the write's premise, e.g. applyBody base hash mismatch or merge head mismatch. */
  | { readonly kind: "precondition"; readonly detail: string }
  /** Signed system records on the agenda fail verification (crash matrix row 10). */
  | { readonly kind: "keyMismatch"; readonly detail: string };

export interface Diagnostic {
  readonly where: string;
  readonly reason: string;
}

export interface Store {
  readSnapshot(agenda: IssueRef): Promise<StoreResult<{ readonly snapshot: Snapshot; readonly diagnostics: readonly Diagnostic[] }>>;
  writeRecord(agenda: IssueRef, record: NewRecord, author: Author): Promise<StoreResult<StoredRecord>>;
  execute(agenda: IssueRef, obligationId: ObligationId, action: ProgramAction): Promise<StoreResult<"done" | "alreadyDone">>;
  convene(input: { readonly repo: RepoRef; readonly parent: IssueRef | null; readonly convened: readonly ConvenedEntry[] }): Promise<StoreResult<IssueRef>>;
  /** Live facts `admit` needs for a PrSubmit on `branch` of `repo`; a failed read is `read`, never a partial result. */
  readAdmitFacts(snapshot: Snapshot, repo: RepoRef, branch: string): Promise<StoreResult<AdmitFacts>>;
}

export function createStore(source: Source, key: HmacKey): Store {
  return {
    readSnapshot: (agenda) => readSnapshot(source, key, agenda),
    writeRecord: (agenda, record, author) => writeRecord(source, key, agenda, record, author),
    execute: (agenda, obligationId, action) => execute(source, key, agenda, obligationId, action),
    convene: (input) => convene(source, key, input),
    readAdmitFacts: (snapshot, repo, branch) => readAdmitFacts(source, snapshot, repo, branch),
  };
}

export { GhSource } from "./gh.ts";
export { DEFAULT_KEY_PATH, loadOrCreateKey, type HmacKey } from "./key.ts";
export { DEFAULT_STATE_DIR, LocalSource } from "./local.ts";
export type { Source } from "./source.ts";
