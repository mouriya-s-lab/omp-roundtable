// Store on the in-memory GitHub: the state file is written only on a transition and with a version compare; a round
// reads GitHub once; effects check the source before writing, so a lost result never duplicates a deliverable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyHash, convene, derive, step, type AgendaId, type AgendaState, type Caller, type Host, type Millis, type Obligation, type Policy, type ReplyId, type Sha, type StepEvent } from "../../src/core/index.ts";
import { createStore, FakeGitHub, type Store } from "../../src/store/index.ts";
import { factsQuery } from "../../src/store/gh.ts";

const repo = { owner: "lab", name: "sandbox" };
const policy: Policy = { appendSystem: "A", systemBlocks: "B", seatAgents: { owner: "task:high", gate: "task:mid" } };
const NO_HOST: Host = { agents: [], failures: [] };
const sha = (c: string): Sha => c.repeat(40).slice(0, 40) as Sha;

let dir: string;
let gh: FakeGitHub;
let store: Store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rt-store-"));
  gh = new FakeGitHub();
  gh.addRepo(repo, "main", sha("0"));
  store = createStore(gh, dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { kind: string; detail: string } }): T {
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.detail}`);
  return r.value;
}

async function convened(): Promise<AgendaState> {
  const issue = gh.seedIssue(repo, "task", "## 验收标准\n\n| # | check |\n|---|---|\n| 1 | a |");
  const state = convene("ag-1" as AgendaId, gh.now(), null, [{ issue, target: { repo, base: "main" }, designOnly: false, adoptPr: null }]);
  unwrap(await store.create(state));
  return state;
}

/** One adapter round: read facts once, derive, and return the obligations. */
async function derived(state: AgendaState, host: Host = NO_HOST): Promise<Obligation[]> {
  const facts = unwrap(await store.facts(state));
  return [...derive(state, facts, host, policy).obligations];
}

/** A transition: step, and write the state file only on `next`. */
async function apply(state: AgendaState, event: StepEvent, host: Host = NO_HOST): Promise<{ state: AgendaState; wrote: boolean; kind: string }> {
  const facts = unwrap(await store.facts(state));
  const t = step(state, facts, host, policy, event);
  if (t.kind === "rejected") throw new Error(t.reason);
  if (t.kind === "same") return { state, wrote: false, kind: "same" };
  unwrap(await store.save(t.state));
  return { state: t.state, wrote: true, kind: "next" };
}

describe("state file", () => {
  test("round-trips, is 0600, and a second create is a conflict", async () => {
    const state = await convened();
    expect(unwrap(await store.load(state.id))).toEqual(state);
    const mode = (await stat(join(dir, "ag-1.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    const again = await store.create(state);
    expect(again.ok ? "ok" : again.error.kind).toBe("conflict");
  });

  test("save compares the version on disk; a stale transition is a conflict and leaves no temp file", async () => {
    const state = await convened();
    unwrap(await store.save({ ...state, version: 2, reported: true }));
    const stale = await store.save({ ...state, version: 2, reported: false });
    expect(stale.ok ? "ok" : stale.error.kind).toBe("conflict");
    expect(unwrap(await store.load(state.id)).reported).toBe(true);
    expect((await readdir(dir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("a missing agenda is `missing`, not an empty state", async () => {
    const r = await store.load("nope" as AgendaId);
    expect(r.ok ? "ok" : r.error.kind).toBe("missing");
  });
});

describe("one delivery round trip on the in-memory GitHub", () => {
  test("deliver → PrSubmit → openPr: each transition writes once, resends write nothing, a lost result never makes a second PR", async () => {
    let state = await convened();
    const owner = "rt-sandbox-1-owner";
    const host: Host = { agents: [{ id: owner as never, requestName: owner, status: "live", parkedSince: null }], failures: [] };

    // the main session records the owner it spawned
    let obs = await derived(state, host);
    const spawn = obs.find((o) => o.kind === "spawn");
    if (spawn === undefined) throw new Error("no spawn ticket");
    const seated: StepEvent = {
      kind: "reply",
      caller: { kind: "main" },
      reply: { kind: "decision", obligation: spawn.id, decision: { subject: "seated", requestName: owner, previous: null, agentId: owner as never }, rationale: "", drafts: [], bodyReplacements: [] },
      live: { branchHead: null, branchContains: [] },
      at: gh.now(),
    };
    const s1 = await apply(state, seated, host);
    expect(s1.wrote).toBe(true);
    state = s1.state;
    const resent = await apply(state, seated, host);
    expect(resent).toMatchObject({ kind: "same", wrote: false });

    // the owner pushes and submits
    const head = sha("a");
    gh.setBranch(repo, "feat", head, [sha("0")]);
    obs = await derived(state, host);
    const deliver = obs.find((o) => o.kind === "deliver");
    if (deliver === undefined) throw new Error("no deliver ticket");
    const caller: Caller = { kind: "sub", agentId: owner as never, sessionMatches: true };
    const submit: StepEvent = {
      kind: "reply",
      caller,
      reply: { kind: "prSubmit", obligation: deliver.id, branch: "feat", head, title: "feat: task", body: "evidence", template: "fourLayer", retryNote: null },
      live: unwrap(await store.live(repo, "feat", [])),
      at: gh.now(),
    };
    state = (await apply(state, submit, host)).state;
    expect((await apply(state, submit, host)).kind).toBe("same");

    // openPr: the result is lost after the GitHub write; the next execution finds the PR by its head branch
    obs = await derived(state, host);
    const openPr = obs.find((o) => o.kind === "effect:openPr");
    if (openPr === undefined || openPr.action === null || openPr.action.kind === "wake") throw new Error("no openPr effect");
    const first = unwrap(await store.execute(state, openPr.action));
    expect(first.kind).toBe("result");
    expect(gh.count("createPr")).toBe(1);
    const second = unwrap(await store.execute(state, openPr.action));
    expect(gh.count("createPr")).toBe(1);
    expect(gh.count("editPr")).toBe(0);
    if (second.kind !== "result") throw new Error("no result");
    state = (await apply(state, { kind: "effectDone", effect: openPr.id, result: second.result }, host)).state;
    expect((await apply(state, { kind: "effectDone", effect: openPr.id, result: second.result }, host)).kind).toBe("same");

    // the PR is maintained: gate tickets now; GitHub saw exactly one deliverable write
    obs = await derived(state, host);
    expect(obs.map((o) => o.kind).sort()).toEqual(expect.arrayContaining(["review", "accept"]));
    expect(gh.writes()).toBe(1);
    expect(unwrap(await store.load(state.id)).version).toBe(state.version);
  });

  test("a round reads GitHub once; commit containment is answered from the cache on later rounds", async () => {
    const state0 = await convened();
    const d = sha("d");
    const state: AgendaState = { ...state0, contracts: [{ id: "re-1" as never, affected: [], routes: [{ route: { kind: "withPr", commit: d, designBranch: "design" }, carrier: null }] }] };
    unwrap(await store.facts(state));
    const firstContains = gh.count("contains");
    unwrap(await store.facts(state));
    expect(gh.count("facts")).toBe(2);
    expect(gh.count("contains")).toBe(firstContains);
    expect(gh.count("issue") + gh.count("pr") + gh.count("branchHead")).toBe(0);
  });
});

describe("effect source checks", () => {
  test("applyBody writes nothing when the body already equals the target, and refuses a moved base", async () => {
    const issue = gh.seedIssue(repo, "t", "old");
    const rep = { decision: "re-1" as ReplyId, issue, baseHash: bodyHash("old"), body: "new", targetHash: bodyHash("new"), applied: false };
    const state = convene("ag-2" as AgendaId, gh.now(), null, []);
    expect(unwrap(await store.execute(state, { kind: "effect", target: { kind: "applyBody", replacement: rep } })).kind).toBe("result");
    expect(gh.count("editIssueBody")).toBe(1);
    expect(unwrap(await store.execute(state, { kind: "effect", target: { kind: "applyBody", replacement: rep } })).kind).toBe("result");
    expect(gh.count("editIssueBody")).toBe(1);
    gh.row(issue).body = "someone else";
    const moved = await store.execute(state, { kind: "effect", target: { kind: "applyBody", replacement: rep } });
    expect(moved.ok ? "ok" : moved.error.kind).toBe("precondition");
  });

  test("createIssue finds the issue a lost result already created instead of creating another", async () => {
    const proposedAt = gh.now();
    const draft = { index: 0, repo, title: "follow-up", body: "b", anchor: { kind: "outsideAgenda" } as const, target: { repo, base: "main" }, designOnly: false };
    const target = { kind: "createIssue" as const, draft: { id: "re-1#0" as never, draft, proposedAt: proposedAt as Millis, issue: null } };
    const state = convene("ag-3" as AgendaId, gh.now(), null, []);
    const a = unwrap(await store.execute(state, { kind: "effect", target }));
    const b = unwrap(await store.execute(state, { kind: "effect", target }));
    expect(gh.count("createIssue")).toBe(1);
    expect(a).toEqual(b);
  });
});

describe("gh facts query", () => {
  test("one GraphQL document carries every issue, the parent tree, PRs, branch and default heads", () => {
    const q = factsQuery({
      issues: [{ repo, number: 1 }, { repo, number: 2 }],
      parent: { repo, number: 9 },
      prs: [{ repo, number: 5 }],
      branches: [{ repo, branch: "main" }],
      repos: [repo],
    });
    for (const alias of ["i0:", "i1:", "parent:", "p0:", "b0:", "d0:"]) expect(q).toContain(alias);
    expect(q.match(/^query \{/gm)).toHaveLength(1);
    expect(q).toContain("subIssues(first: 100)");
    expect(q).toContain("closedByPullRequestsReferences");
  });
});
