// Port payload parsing: the shapes the state model changed (reply ids, woken parked episode, local agenda id).

import { describe, expect, test } from "bun:test";
import { parseConvene, parseReply, parseResume } from "../../src/adapter/parse.ts";

const ticket = "ob-0123456789abcdef";
const decision = (d: unknown) => ({ kind: "decision", decision: d, rationale: "r" });

describe("reply parsing", () => {
  test("woken names the parked episode; the old count or since field is an unknown key", () => {
    expect(parseReply(ticket, decision({ subject: "woken", agentId: "rt-x-owner", parkedSince: 1700 }))).toMatchObject({ ok: true, value: { decision: { parkedSince: 1700 } } });
    expect(parseReply(ticket, decision({ subject: "woken", agentId: "rt-x-owner", since: 1700 })).ok).toBe(false);
  });

  test("decisions name claims and verdicts by reply id; a comment-era record id is refused", () => {
    expect(parseReply(ticket, decision({ subject: "findings", verdictId: "re-00000000000000aa", perFinding: [] })).ok).toBe(true);
    const old = parseReply(ticket, decision({ subject: "findings", verdictRecord: "123456", perFinding: [] }));
    expect(old.ok ? "" : old.error).toContain("verdictRecord");
    expect(parseReply(ticket, decision({ subject: "blockedClaim", claim: "re-00000000000000bb", verdict: "replacePr", abandon: null })).ok).toBe(false);
  });
});

describe("convene and resume parsing", () => {
  test("convene has no agenda repository: the agenda lives in the local state file", () => {
    const entries = [{ issue: "lab/sandbox#1", target: { repo: "lab/sandbox", base: "main" } }];
    expect(parseConvene({ mode: "execute", parent: null, entries }).ok).toBe(true);
    expect(parseConvene({ mode: "execute", repo: "lab/sandbox", parent: null, entries }).ok).toBe(false);
  });

  test("resume takes the agenda id convene returned, and the operator's confirmation", () => {
    expect(parseResume({ agenda: "ag-m1abc-x9", operatorConfirmedOriginalSessionEnded: true })).toMatchObject({ ok: true, value: { agenda: "ag-m1abc-x9", operatorConfirmedOriginalSessionEnded: true } });
    expect(parseResume({ agenda: "lab/sandbox#12", operatorConfirmedOriginalSessionEnded: true }).ok).toBe(false);
    expect(parseResume({ agenda: "ag-m1abc-x9" }).ok).toBe(false);
  });
});
