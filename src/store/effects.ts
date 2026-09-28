// execute: carry out one program obligation derived by core (C3). The store never decides whether it should run:
// it reads the source, returns `alreadyDone` when the effect's completion check (core.md §3 效应) already holds,
// and otherwise writes. A source fact that contradicts the write's premise is a `precondition` error, never a write.

import { computeUnits, type IssueRef, type ObligationId, type PrRef, type ProgramAction, type RecordId, type StoredRecord } from "../core/index.ts";
import { encodeMarker, rawEnvelopes, scanMarkers, withMarkers, bodyHash } from "./codec.ts";
import type { StoreError, StoreResult } from "./index.ts";
import type { HmacKey } from "./key.ts";
import { message } from "./records.ts";
import { readAgenda, readRecords, readSnapshot, refKey, sameRef } from "./snapshot.ts";
import type { Source } from "./source.ts";

type Outcome = StoreResult<"done" | "alreadyDone">;

const DONE: Outcome = { ok: true, value: "done" };
const ALREADY: Outcome = { ok: true, value: "alreadyDone" };
const fail = (kind: StoreError["kind"], detail: string): Outcome => ({ ok: false, error: { kind, detail } });

export async function execute(source: Source, key: HmacKey, agenda: IssueRef, obligationId: ObligationId, action: ProgramAction): Promise<Outcome> {
  try {
    // Every marker this write leaves is signed with `key`; a key the agenda does not verify would make them invisible
    // to the next read and the effect would repeat (crash matrix row 10).
    const head = await readAgenda(source, key, agenda);
    if (head.kind === "keyMismatch") return fail("keyMismatch", head.detail);
    if (head.kind === "notAgenda") return fail("precondition", head.detail);
    return await run(source, key, agenda, obligationId, action);
  } catch (err) {
    return fail("write", message(err));
  }
}

async function run(source: Source, key: HmacKey, agenda: IssueRef, obligationId: ObligationId, action: ProgramAction): Promise<Outcome> {
  switch (action.kind) {
    case "close":
    case "reopen":
    case "closeParent":
    case "reopenParent":
      return setOpen(source, action.issue, action.kind === "reopen" || action.kind === "reopenParent");
    case "merge": {
      const pr = await source.pr(action.pr);
      if (pr.state.kind === "merged") return ALREADY;
      if (pr.state.kind === "closedUnmerged") return fail("precondition", `${refKey(action.pr)} is closed without merge`);
      const merged = await source.mergePr(action.pr, action.head);
      return merged.kind === "merged" ? DONE : fail("precondition", `merge of ${refKey(action.pr)} at ${action.head} refused: ${merged.detail}`);
    }
    case "noticeForeignPr":
      return noticeForeign(source, key, agenda, obligationId, action.pr, action.foreign);
    case "effect":
      break;
    default:
      return assertNever(action);
  }

  const t = action.target;
  switch (t.kind) {
    case "closeAgenda":
      return setOpen(source, agenda, false);
    case "attachAgenda":
      if ((await source.subIssues(t.parent)).some((c) => sameRef(c, agenda))) return ALREADY;
      await source.addSubIssue(t.parent, agenda);
      return DONE;
    case "openPr":
    case "updatePr":
      return materializePr(source, key, agenda, t.kind, t.submit, t.pr);
    case "applyBody": {
      const rep = t.replacement;
      const issue = await source.issue(rep.issue);
      const applied = scanMarkers(key, issue.body).flatMap((s) => (s.ok && s.marker.kind === "applied" ? s.marker.payload.decisions : []));
      if (applied.includes(t.decision)) return ALREADY;
      const current = bodyHash(issue.body);
      if (current !== rep.baseHash) return fail("precondition", `${refKey(rep.issue)} body hash is ${current}, replacement expects ${rep.baseHash}`);
      // Keep every other hidden block verbatim; the one `applied` block keeps all earlier decisions and adds this one.
      const kept = rawEnvelopes(issue.body).filter((e) => e.kind !== "applied").map((e) => e.block);
      const decisions = [...new Set([...applied, t.decision])];
      await source.editIssueBody(rep.issue, withMarkers(rep.body, [...kept, encodeMarker(key, { kind: "applied", payload: { decisions } })]));
      return DONE;
    }
    case "createIssue": {
      const read = await readSnapshot(source, key, agenda);
      if (!read.ok) return read;
      const snap = read.value.snapshot;
      const attachTo = t.draft.anchor.kind !== "outsideAgenda" ? snap.agenda.parent : null;
      const existing = snap.issues.find((i) => i.draftMarker === t.draftId);
      if (existing !== undefined) {
        // Created before a crash but not yet attached: finish the effect instead of creating a second issue.
        if (attachTo === null || (snap.issues.find((i) => sameRef(i.ref, attachTo))?.children ?? []).some((c) => sameRef(c, existing.ref))) return ALREADY;
        await source.addSubIssue(attachTo, existing.ref);
        return DONE;
      }
      const marker = encodeMarker(key, { kind: "draft", payload: { agenda, draftId: t.draftId } });
      const created = await source.createIssue(t.draft.repo, t.draft.title, withMarkers(t.draft.body, [marker]));
      if (attachTo !== null) await source.addSubIssue(attachTo, created.ref);
      return DONE;
    }
    case "noticeDecision": {
      if (await hasNotice(source, key, agenda, t.issue, obligationId)) return ALREADY;
      const text = `**omp-roundtable 通知** · 议程 ${refKey(agenda)} 的裁定记录 \`${t.decision}\` 影响本 issue，请按裁定核对正文与交付。`;
      await source.comment(t.issue, withMarkers(text, [encodeMarker(key, { kind: "notice", payload: { agenda, obligation: obligationId } })]));
      return DONE;
    }
    case "rerunChecks": {
      const decision = (await readRecords(source, key, agenda, [])).find((r) => r.id === t.decision);
      if (decision === undefined) return fail("precondition", `decision record ${t.decision} is not on ${refKey(agenda)}`);
      const checks = (await source.pr(t.pr)).checks;
      const fact = checks.kind === "rollup" ? checks.fact : null;
      if (fact !== null && fact.latestRunCreatedAt !== null && fact.latestRunCreatedAt > decision.at) return ALREADY;
      if (fact === null || fact.failedRunId === null) return fail("precondition", `${refKey(t.pr)} has no failed check run to re-run`);
      await source.rerunCheck(t.pr.repo, fact.failedRunId);
      return DONE;
    }
    default:
      return assertNever(t);
  }
}

async function setOpen(source: Source, issue: IssueRef, open: boolean): Promise<Outcome> {
  if ((await source.issue(issue)).open === open) return ALREADY;
  await source.setIssueOpen(issue, open);
  return DONE;
}

async function hasNotice(source: Source, key: HmacKey, agenda: IssueRef, target: IssueRef, obligation: ObligationId): Promise<boolean> {
  return (await source.comments(target)).some((c) =>
    scanMarkers(key, c.body).some((s) => s.ok && s.marker.kind === "notice" && sameRef(s.marker.payload.agenda, agenda) && s.marker.payload.obligation === obligation),
  );
}

async function noticeForeign(source: Source, key: HmacKey, agenda: IssueRef, obligation: ObligationId, ours: PrRef, foreign: readonly PrRef[]): Promise<Outcome> {
  let wrote = false;
  for (const pr of foreign) {
    if (await hasNotice(source, key, agenda, pr, obligation)) continue;
    const text = `**omp-roundtable 通知** · 议程 ${refKey(agenda)} 由 ${refKey(ours)} 交付同一个 issue；本 PR 不由圆桌维护，也不会被圆桌合并。`;
    await source.comment(pr, withMarkers(text, [encodeMarker(key, { kind: "notice", payload: { agenda, obligation } })]));
    wrote = true;
  }
  return wrote ? DONE : ALREADY;
}

/** openPr / updatePr from the member's latest PrSubmit; complete when a PR body carries this submit's `pr` marker. */
async function materializePr(
  source: Source,
  key: HmacKey,
  agenda: IssueRef,
  kind: "openPr" | "updatePr",
  submit: StoredRecord,
  pr: PrRef | null,
): Promise<Outcome> {
  if (submit.body.kind !== "prSubmit") return fail("precondition", `record ${submit.id} is not a PrSubmit`);
  const s = submit.body;
  const carries = (body: string): boolean =>
    scanMarkers(key, body).some((m) => m.ok && m.marker.kind === "pr" && sameRef(m.marker.payload.agenda, agenda) && m.marker.payload.appliedSubmit === submit.id);
  const render = (): string =>
    withMarkers(`${s.body.trimEnd()}\n\nCloses ${refKey(s.member)}`, [
      encodeMarker(key, { kind: "pr", payload: { agenda, member: s.member, appliedSubmit: submit.id as RecordId } }),
    ]);

  if (kind === "updatePr") {
    if (pr === null) return fail("precondition", "updatePr without a PR");
    if (carries((await source.pr(pr)).body)) return ALREADY;
    await source.editPr(pr, s.title, render());
    return DONE;
  }

  const read = await readSnapshot(source, key, agenda);
  if (!read.ok) return read;
  const entry = computeUnits(read.value.snapshot)
    .flatMap((u) => u.members)
    .find((m) => sameRef(m.issue, s.member));
  if (entry === undefined) return fail("precondition", `${refKey(s.member)} is not a member of agenda ${refKey(agenda)}`);
  const target = entry.target;
  for (const ref of await source.prsByHead(target.repo, s.branch)) {
    if (carries((await source.pr(ref)).body)) return ALREADY;
  }
  await source.createPr({ repo: target.repo, base: target.base, head: s.branch, title: s.title, body: render() });
  return DONE;
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
