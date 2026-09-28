// readAdmitFacts: the live branch facts `admit` checks for a PrSubmit (core.md §4 admit step 5), read from the source.
// Which commits are required is core's decision; the store reports, for every design commit the records reference,
// whether the branch head contains it.

import type { AdmitFacts, RepoRef, Snapshot } from "../core/index.ts";
import type { StoreResult } from "./index.ts";
import { message } from "./records.ts";
import { designCommits, mapLimit } from "./snapshot.ts";
import type { Source } from "./source.ts";

export async function readAdmitFacts(source: Source, snapshot: Snapshot, repo: RepoRef, branch: string): Promise<StoreResult<AdmitFacts>> {
  try {
    const branchHead = await source.branchHead(repo, branch);
    if (branchHead === null) return { ok: true, value: { branchHead: null, branchContains: [] } };
    const candidates = designCommits(snapshot.records);
    const held = await mapLimit(candidates, 8, (sha) => (sha === branchHead ? Promise.resolve(true) : source.contains(repo, sha, branchHead)));
    return { ok: true, value: { branchHead, branchContains: candidates.filter((_, i) => held[i] === true) } };
  } catch (err) {
    return { ok: false, error: { kind: "read", detail: message(err) } };
  }
}
