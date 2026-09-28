// Codec: stamps verify only with the writing key and untouched payload; visible bodies ignore hidden blocks.

import { describe, expect, test } from "bun:test";
import type { Hash, IssueRef, NewRecord, RecordId } from "../../src/core/index.ts";
import { acceptanceRows, bodyHash, encodeMarker, encodeRecordComment, scanMarkers, visibleBody, withMarkers } from "../../src/store/codec.ts";
import { parseKey } from "../../src/store/key.ts";

const key = parseKey("11".repeat(32));
const otherKey = parseKey("22".repeat(32));
const agenda: IssueRef = { repo: { owner: "o", name: "r" }, number: 7 };

const record: NewRecord = {
  obligation: null,
  idempotencyKey: "k-1",
  manifest: null,
  payloadHash: "00000000000000ff" as Hash,
  body: {
    kind: "decision",
    decision: { subject: "report", summary: "done" },
    rationale: "closing --> <!-- omp-roundtable:v1 record AAAA 00 --> text",
    drafts: [],
    bodyReplacements: [],
  },
};

describe("record comment", () => {
  test("round-trips through scan with the writing key", () => {
    const text = encodeRecordComment(key, agenda, record, { kind: "main" });
    const scanned = scanMarkers(key, text);
    expect(scanned).toHaveLength(1);
    const s = scanned[0];
    expect(s?.ok).toBe(true);
    if (s?.ok !== true || s.marker.kind !== "record") throw new Error("not a record");
    expect(s.marker.payload.agenda).toEqual(agenda);
    expect(s.marker.payload.idempotencyKey).toBe("k-1");
    expect(s.marker.payload.body).toEqual(record.body);
  });

  test("user text cannot open or close a hidden block in the visible summary", () => {
    const text = encodeRecordComment(key, agenda, record, { kind: "main" });
    expect(text.match(/<!--/g)).toHaveLength(1);
    expect(visibleBody(text)).toContain("closing --&gt;");
  });

  test("another key, a tampered payload or a tampered mac is rejected as signature invalid", () => {
    const text = encodeRecordComment(key, agenda, record, { kind: "main" });
    const [, data = "", mac = ""] = / record ([A-Za-z0-9_-]+) ([0-9a-f]{64}) -->/.exec(text) ?? [];
    const flipped = (s: string, i: number, a: string, b: string): string => s.slice(0, i) + (s[i] === a ? b : a) + s.slice(i + 1);
    const cases = [
      scanMarkers(otherKey, text),
      scanMarkers(key, text.replace(data, flipped(data, 10, "A", "B"))),
      scanMarkers(key, text.replace(mac, flipped(mac, 0, "a", "b"))),
    ];
    for (const scanned of cases) expect(scanned).toEqual([{ ok: false, kind: "record", reason: "signature invalid" }]);
  });

  test("a validly signed block whose payload has the wrong shape is rejected", () => {
    const forged = encodeMarker(key, { kind: "pr", payload: { agenda, member: agenda, appliedSubmit: "1" as RecordId } }).replace(" pr ", " draft ");
    expect(scanMarkers(key, forged)).toEqual([{ ok: false, kind: "draft", reason: "payload does not match the draft schema" }]);
  });
});

describe("body hash", () => {
  test("hidden blocks, CRLF and trailing whitespace do not change the hash; visible edits do", () => {
    const visible = "## 目标\n\n做一件事";
    const marker = encodeMarker(key, { kind: "applied", payload: { decisions: ["9" as RecordId] } });
    const stamped = withMarkers(visible, [marker]);
    expect(visibleBody(stamped)).toBe(visible);
    expect(bodyHash(stamped)).toBe(bodyHash(visible));
    expect(bodyHash(`${visible.replace(/\n/g, "\r\n")}  \n\n`)).toBe(bodyHash(visible));
    expect(bodyHash(withMarkers(`${visible}!`, [marker]))).not.toBe(bodyHash(visible));
  });

  test("a forged block (bad mac) is stripped from the visible body too", () => {
    expect(visibleBody("text\n<!-- omp-roundtable:v1 record AAAA 00 -->")).toBe("text");
  });
});

describe("acceptance rows", () => {
  const body = [
    "## 验收标准",
    "",
    "| # | Check |",
    "|---|---|",
    "| 1 | a |",
    "| 2 | b |",
    "| x | not a row |",
    "",
    "| 9 | second table is ignored |",
    "## 依赖",
    "| 5 | other section |",
  ].join("\n");

  test("first table under the heading, integer first cells, global ids", () => {
    expect(acceptanceRows(agenda, body)).toEqual(["o/r#7/1", "o/r#7/2"]);
  });

  test("parent closure table and missing section", () => {
    expect(acceptanceRows(agenda, "## 关闭验证\n| # | x |\n|---|---|\n| 3 | y |")).toEqual(["o/r#7/3"]);
    expect(acceptanceRows(agenda, "## 其他\n| 1 | y |")).toEqual([]);
  });
});
