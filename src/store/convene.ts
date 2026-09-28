// convene: write the agenda once (createAgenda + attachAgenda + closeAgenda, core.md §3 效应).
// Order is create → attach → close, so a half-done convening always leaves the agenda issue open; a re-run finds it
// (open issues of the repo, plus the parent's sub-issues for a finished one) by its signed payload and completes it.

import { canonical, type ConvenedEntry, type IssueRef, type RepoRef } from "../core/index.ts";
import { encodeMarker, scanMarkers, withMarkers } from "./codec.ts";
import type { StoreResult } from "./index.ts";
import type { HmacKey } from "./key.ts";
import { message } from "./records.ts";
import { refKey, sameRef } from "./snapshot.ts";
import type { IssueRaw, Source } from "./source.ts";

export async function convene(
  source: Source,
  key: HmacKey,
  input: { readonly repo: RepoRef; readonly parent: IssueRef | null; readonly convened: readonly ConvenedEntry[] },
): Promise<StoreResult<IssueRef>> {
  const payload = { parent: input.parent, convened: input.convened };
  const identity = canonical(payload);
  try {
    const children = input.parent === null ? [] : await source.subIssues(input.parent);
    const candidates: IssueRaw[] = [
      ...(await source.listOpenIssues(input.repo)),
      ...(await Promise.all(children.map((c) => source.issue(c)))),
    ];
    let agenda =
      candidates.find((raw) =>
        scanMarkers(key, raw.body).some((s) => s.ok && s.marker.kind === "agenda" && canonical(s.marker.payload) === identity),
      ) ?? null;
    if (agenda === null) {
      const lines = input.convened.map((c, i) => {
        const flags = [c.designOnly ? "仅设计" : "", c.adoptPr === null ? "" : `接管 ${refKey(c.adoptPr)}`].filter((f) => f !== "");
        return `${i + 1}. ${refKey(c.issue)} → \`${c.target.repo.owner}/${c.target.repo.name}\` \`${c.target.base}\`${flags.length > 0 ? `（${flags.join("，")}）` : ""}`;
      });
      const intro = input.parent === null ? "圆桌议程（按顺序交付）：" : `圆桌议程，parent ${refKey(input.parent)}（按顺序交付）：`;
      const body = withMarkers(`${intro}\n\n${lines.join("\n")}`, [encodeMarker(key, { kind: "agenda", payload })]);
      agenda = await source.createIssue(input.repo, `圆桌议程：${input.convened.length} 项`, body);
    }
    const ref = agenda.ref;
    if (input.parent !== null && !children.some((c) => sameRef(c, ref))) await source.addSubIssue(input.parent, ref);
    if ((await source.issue(ref)).open) await source.setIssueOpen(ref, false);
    return { ok: true, value: ref };
  } catch (err) {
    return { ok: false, error: { kind: "write", detail: message(err) } };
  }
}
