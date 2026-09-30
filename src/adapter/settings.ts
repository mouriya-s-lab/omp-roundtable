// Plugin settings (package.json `omp.settings`). Precedence per key: `omp plugin config --set` value, then the declared
// environment variable, then the default. Parsed once at load; an invalid value fails the load loudly.

import { join } from "node:path";

export interface Settings {
  /** Timer recompute interval (design Q7, default 120 s): picks up changes others make on GitHub. */
  readonly recomputeIntervalMs: number;
  /** Agenda state files live in `<dataDir>/state`. */
  readonly dataDir: string;
  /** Native `task` agent types seats are spawned as (R2, R3; a test run sets both to the free tier). */
  readonly seatAgents: { readonly owner: string; readonly gate: string };
}

export const PLUGIN_NAME = "omp-roundtable";

export function parseSettings(configured: Readonly<Record<string, unknown>>, env: Readonly<Record<string, string | undefined>>, agentDir: string): Settings {
  const pick = (key: string, envName: string): unknown => configured[key] ?? env[envName];
  const text = (key: string, envName: string, fallback: string): string => {
    const raw = pick(key, envName);
    if (raw === undefined || raw === "") return fallback;
    if (typeof raw !== "string") throw new Error(`${PLUGIN_NAME}: setting ${key} (${envName}) must be a non-empty string`);
    return raw;
  };
  const seconds = pick("recomputeIntervalSeconds", "OMP_ROUNDTABLE_RECOMPUTE_SECONDS");
  let interval = 120;
  if (seconds !== undefined && seconds !== "") {
    const n = typeof seconds === "number" ? seconds : Number(seconds);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${PLUGIN_NAME}: setting recomputeIntervalSeconds (OMP_ROUNDTABLE_RECOMPUTE_SECONDS) must be a positive integer, got ${JSON.stringify(seconds)}`);
    interval = n;
  }
  return {
    recomputeIntervalMs: interval * 1000,
    dataDir: text("dataDir", "OMP_ROUNDTABLE_DIR", join(agentDir, PLUGIN_NAME)),
    seatAgents: { owner: text("ownerAgent", "OMP_ROUNDTABLE_OWNER_AGENT", "task:high"), gate: text("gateAgent", "OMP_ROUNDTABLE_GATE_AGENT", "task:mid") },
  };
}
