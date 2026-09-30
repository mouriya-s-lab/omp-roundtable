// execute: carry out one program obligation derived by core (omp-roundtable.md §4 C3). The store never decides whether
// it should run: it checks the source first and writes only what is missing. An effect with a result returns it for
// the adapter to write back through `step`; a source fact contradicting the write's premise is a `precondition` error.

import { bodyHash, type AgendaState, type EffectResult, type EffectTarget, type IssueRef, type PrRef, type Sha, type StoreAction, type SubmitState } from "../core/index.ts";
import type { GitHub } from "./github.ts";
import type { StoreError, StoreResult } from "./index.ts";

export type Executed = { readonly kind: "result"; readonly result: EffectResult } | { readonly kind: "done" };

const DONE: StoreResult<Executed> = { ok: true, value: { kind: "done" } };
const result = (r: EffectResult): StoreResult<Executed> => ({ ok: true, value: { kind: "result", result: r } });
const fail = (kind: StoreError["kind"], detail: string): StoreResult<Executed> => ({ ok: false, error: { kind, detail } });
const refKey = (r: IssueRef | PrRef): string => `${r.repo.owner}/${r.repo.name}#${r.number}`;
const sameRef = (a: IssueRef, b: IssueRef): boolean => a.number === b.number && a.repo.owner === b.repo.owner && a.repo.name === b.repo.name;

export async function execute(gh: GitHub, state: AgendaState, action: StoreAction): Promise<StoreResult<Executed>> {
  try {
    switch (action.kind) {
      case "close":
      case "reopen":
      case "closeParent":
      case "reopenParent":
        await gh.setIssueOpen(action.issue, action.kind === "reopen" || action.kind === "reopenParent");
        return DONE;
      case "merge": {
        const pr = await gh.pr(action.pr);
        if (pr.state.kind === "merged") return DONE;
        if (pr.state.kind === "closedUnmerged") return fail("precondition", `${refKey(action.pr)} is closed without merge`);
        const merged = await gh.mergePr(action.pr, action.head);
        return merged.kind === "merged" ? DONE : fail("precondition", `merge of ${refKey(action.pr)} at ${action.head} refused: ${merged.detail}`);
      }
      case "effect":
        return await effect(gh, state, action.target);
      default:
        return assertNever(action);
    }
  } catch (err) {
    return fail("write", err instanceof Error ? err.message : String(err));
  }
}

/** The PR body the program renders: the owner's body, the main-session design credits, and the closing reference. */
export function renderPrBody(submit: SubmitState, member: IssueRef, designCommits: readonly Sha[]): string {
  const design =
    designCommits.length === 0 ? "" : `\n\n## 主会话设计 commit\n\n以下 commit 由主会话提交，不属于本 PR 的 owner：\n\n${designCommits.map((c) => `- ${c}`).join("\n")}`;
  return `${submit.body.trimEnd()}${design}\n\nCloses ${refKey(member)}`;
}

async function effect(gh: GitHub, state: AgendaState, t: EffectTarget): Promise<StoreResult<Executed>> {
  switch (t.kind) {
    case "openPr":
    case "updatePr": {
      const body = renderPrBody(t.submit, t.member, t.designCommits);
      const carries = (title: string, current: string): boolean => title === t.submit.title && bodyHash(current) === bodyHash(body);
      // source check: the PR to maintain is the registered one, or an open PR from this head branch (a create whose
      // result was lost); a second PR is never created
      const candidates = t.pr !== null ? [await gh.pr(t.pr)] : (await gh.openPrsByHead(t.target.repo, t.submit.branch)).filter((p) => p.base === t.target.base);
      const existing = candidates.find((p) => p.state.kind === "open") ?? null;
      if (existing !== null) {
        if (!carries(existing.title, existing.body)) await gh.editPr(existing.ref, t.submit.title, body);
        return result({ kind: "prApplied", pr: existing.ref });
      }
      if (t.pr !== null) return fail("precondition", `${refKey(t.pr)} is no longer open`);
      const pr = await gh.createPr({ repo: t.target.repo, base: t.target.base, head: t.submit.branch, title: t.submit.title, body });
      return result({ kind: "prApplied", pr });
    }
    case "applyBody": {
      const rep = t.replacement;
      const current = bodyHash((await gh.issue(rep.issue)).body);
      if (current === rep.targetHash) return result({ kind: "bodyApplied" });
      if (current !== rep.baseHash) return fail("precondition", `${refKey(rep.issue)} body hash is ${current}, replacement expects ${rep.baseHash}`);
      await gh.editIssueBody(rep.issue, rep.body);
      return result({ kind: "bodyApplied" });
    }
    case "createIssue": {
      const d = t.draft.draft;
      // source check: an issue with this title and body created after the draft was proposed is this draft's issue
      const found = (await gh.issuesCreatedSince(d.repo, t.draft.proposedAt)).find((i) => i.title === d.title && bodyHash(i.body) === bodyHash(d.body));
      const issue = found?.ref ?? (await gh.createIssue(d.repo, d.title, d.body));
      if (d.anchor.kind !== "outsideAgenda" && state.parent !== null && sameRef(state.parent, issue) === false) {
        const parent = state.parent;
        if (!(await gh.issue(parent)).children.some((c) => sameRef(c, issue))) await gh.addSubIssue(parent, issue);
      }
      return result({ kind: "issueCreated", issue });
    }
    case "rerunChecks":
      await gh.rerunCheck(t.pr.repo, t.runId);
      return result({ kind: "checksRerun" });
    default:
      return assertNever(t);
  }
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
