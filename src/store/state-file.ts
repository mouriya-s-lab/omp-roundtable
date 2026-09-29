// The agenda state file (omp-roundtable.md §4 持久化): one JSON file per agenda, mode 0600, written only by this
// process, only on a real transition. A write replaces the whole file through a temp file and an atomic rename, after
// comparing the version on disk with the version the transition started from.

import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgendaId, AgendaState } from "../core/index.ts";
import type { StoreResult } from "./index.ts";

export const DEFAULT_STATE_DIR = join(homedir(), ".omp", "agent", "omp-roundtable", "state");

/** On-disk envelope; `format` changes only with an incompatible AgendaState change. */
interface Envelope {
  readonly format: 1;
  readonly state: AgendaState;
}

const fileOf = (dir: string, id: AgendaId): string => join(dir, `${encodeURIComponent(id)}.json`);

const fail = <T>(kind: "read" | "write" | "conflict" | "missing", detail: string): StoreResult<T> => ({ ok: false, error: { kind, detail } });

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Boundary parse. The file is written only by this process, so the check is the envelope and the fields every reader
 * relies on first (identity and version); the nested shape is the one `serialize` wrote.
 */
function parse(text: string, id: AgendaId): AgendaState {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object") throw new Error("state file is not an object");
  const env = value as { format?: unknown; state?: unknown };
  if (env.format !== 1) throw new Error(`unsupported state file format ${String(env.format)}`);
  const state = env.state as { id?: unknown; version?: unknown; members?: unknown; convened?: unknown } | null;
  if (state === null || typeof state !== "object") throw new Error("state file has no state");
  if (state.id !== id) throw new Error(`state file holds agenda ${String(state.id)}, expected ${id}`);
  if (typeof state.version !== "number" || !Number.isSafeInteger(state.version) || state.version < 1) throw new Error("state file has no valid version");
  if (!Array.isArray(state.members) || !Array.isArray(state.convened)) throw new Error("state file lacks members or convened list");
  return env.state as AgendaState;
}

const serialize = (state: AgendaState): string => `${JSON.stringify({ format: 1, state } satisfies Envelope, null, 1)}\n`;

async function readVersion(path: string, id: AgendaId): Promise<number | null> {
  try {
    return parse(await readFile(path, "utf8"), id).version;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function replace(dir: string, path: string, state: AgendaState): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(serialize(state), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export class StateFiles {
  constructor(readonly dir: string = DEFAULT_STATE_DIR) {}

  async load(id: AgendaId): Promise<StoreResult<AgendaState>> {
    try {
      return { ok: true, value: parse(await readFile(fileOf(this.dir, id), "utf8"), id) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return fail("missing", `agenda ${id} has no state file in ${this.dir}`);
      return fail("read", message(err));
    }
  }

  /** Writes the initial state (version 1); an existing file for the id is a conflict. */
  async create(state: AgendaState): Promise<StoreResult<void>> {
    if (state.version !== 1) return fail("write", `initial state must be version 1, got ${state.version}`);
    const path = fileOf(this.dir, state.id);
    try {
      if ((await readVersion(path, state.id)) !== null) return fail("conflict", `agenda ${state.id} already has a state file`);
      await replace(this.dir, path, state);
      return { ok: true, value: undefined };
    } catch (err) {
      return fail("write", message(err));
    }
  }

  /** Writes `next` if the file still holds version `next.version - 1` (the state the transition started from). */
  async save(next: AgendaState): Promise<StoreResult<void>> {
    const path = fileOf(this.dir, next.id);
    try {
      const onDisk = await readVersion(path, next.id);
      if (onDisk !== next.version - 1) return fail("conflict", `agenda ${next.id} is at version ${onDisk ?? "none"}, transition expects ${next.version - 1}`);
      await replace(this.dir, path, next);
      return { ok: true, value: undefined };
    } catch (err) {
      return fail("write", message(err));
    }
  }

  /** Agenda ids with a state file (resume). */
  async list(): Promise<StoreResult<readonly AgendaId[]>> {
    try {
      const names = await readdir(this.dir);
      return { ok: true, value: names.filter((n) => n.endsWith(".json")).map((n) => decodeURIComponent(n.slice(0, -5)) as AgendaId) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: [] };
      return fail("read", message(err));
    }
  }
}
