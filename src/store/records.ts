// writeRecord: idempotent write of an admitted record as one signed comment on the agenda issue (C2, R18).
// The source is searched by idempotency key first; an existing record is returned instead of writing again.

import type { Author, IssueRef, NewRecord, RecordId, StoredRecord } from "../core/index.ts";
import { encodeRecordComment } from "./codec.ts";
import type { Diagnostic, StoreResult } from "./index.ts";
import type { HmacKey } from "./key.ts";
import { readAgenda, readRecords } from "./snapshot.ts";
import type { Source } from "./source.ts";

export async function writeRecord(source: Source, key: HmacKey, agenda: IssueRef, record: NewRecord, author: Author): Promise<StoreResult<StoredRecord>> {
  let existing: StoredRecord[];
  try {
    // A key that cannot verify the agenda cannot see earlier records either: writing now would duplicate them (crash matrix row 10).
    const head = await readAgenda(source, key, agenda);
    if (head.kind === "keyMismatch") return { ok: false, error: { kind: "keyMismatch", detail: head.detail } };
    if (head.kind === "notAgenda") return { ok: false, error: { kind: "precondition", detail: head.detail } };
    const ignored: Diagnostic[] = [];
    existing = await readRecords(source, key, agenda, ignored);
  } catch (err) {
    return { ok: false, error: { kind: "read", detail: message(err) } };
  }
  const same = existing.find((r) => r.idempotencyKey === record.idempotencyKey);
  if (same !== undefined) {
    return same.payloadHash === record.payloadHash
      ? { ok: true, value: same }
      : { ok: false, error: { kind: "precondition", detail: `record ${same.id} already holds idempotency key ${record.idempotencyKey} with a different payload` } };
  }
  try {
    const c = await source.comment(agenda, encodeRecordComment(key, agenda, record, author));
    return {
      ok: true,
      value: {
        id: c.id as RecordId,
        at: c.createdAt,
        author,
        obligation: record.obligation,
        idempotencyKey: record.idempotencyKey,
        manifest: record.manifest,
        payloadHash: record.payloadHash,
        body: record.body,
      },
    };
  } catch (err) {
    return { ok: false, error: { kind: "write", detail: message(err) } };
  }
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
