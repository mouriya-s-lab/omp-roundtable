// Public API of the store (consumed by the seat adapter). It owns the agenda state file and the GitHub reads and
// deliverable writes; it never decides whether a transition or an effect should happen (core does).

import type { AgendaId, AgendaState, Facts, LiveFacts, ProgramAction, RepoRef, Sha } from "../core/index.ts";
import { execute, type Executed } from "./effects.ts";
import { ContainsCache, readFacts, type CommitPair } from "./facts.ts";
import type { GitHub } from "./github.ts";
import { StateFiles } from "./state-file.ts";

export type StoreResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: StoreError };

export type StoreError =
  /** A failed read: the whole read is void, never a partial result. */
  | { readonly kind: "read"; readonly detail: string }
  | { readonly kind: "write"; readonly detail: string }
  /** The source contradicts the write's premise, e.g. a body replacement's base hash or a merge's head. */
  | { readonly kind: "precondition"; readonly detail: string }
  /** The state file is not at the version the transition started from. */
  | { readonly kind: "conflict"; readonly detail: string }
  /** No state file for the agenda (lost, or another machine; crash matrix row 13). */
  | { readonly kind: "missing"; readonly detail: string };

export interface Store {
  /** Writes the convened state (version 1). */
  create(state: AgendaState): Promise<StoreResult<void>>;
  load(id: AgendaId): Promise<StoreResult<AgendaState>>;
  /** Compare-and-set: writes `next` only if the file still holds version `next.version - 1`. */
  save(next: AgendaState): Promise<StoreResult<void>>;
  list(): Promise<StoreResult<readonly AgendaId[]>>;
  /** The GitHub facts of one derivation round. */
  facts(state: AgendaState): Promise<StoreResult<Facts>>;
  /** Live facts `step` checks a PrSubmit on `branch` of `repo` against. */
  live(repo: RepoRef, branch: string, required: readonly Sha[]): Promise<StoreResult<LiveFacts>>;
  execute(state: AgendaState, action: ProgramAction): Promise<StoreResult<Executed>>;
}

export function createStore(gh: GitHub, dir?: string): Store {
  const files = new StateFiles(dir);
  const cache = new ContainsCache();
  return {
    create: (state) => files.create(state),
    load: (id) => files.load(id),
    save: (next) => files.save(next),
    list: () => files.list(),
    facts: (state) => readFacts(gh, cache, state),
    async live(repo, branch, required) {
      try {
        const head = await gh.branchHead(repo, branch);
        const contained: Sha[] = [];
        if (head !== null) for (const sha of required) if (await cache.get(gh, { repo, ancestor: sha, descendant: head })) contained.push(sha);
        return { ok: true, value: { branchHead: head, branchContains: contained } };
      } catch (err) {
        return { ok: false, error: { kind: "read", detail: err instanceof Error ? err.message : String(err) } };
      }
    },
    execute: (state, action) => execute(gh, state, action),
  };
}

export type { Executed } from "./effects.ts";
export type { CommitPair } from "./facts.ts";
export { renderPrBody } from "./effects.ts";
export { GhGitHub } from "./gh.ts";
export { FakeGitHub } from "./fake.ts";
export type { GitHub } from "./github.ts";
export { DEFAULT_STATE_DIR } from "./state-file.ts";
