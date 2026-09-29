// Plugin settings (package.json `omp.settings`). Precedence per key: `omp plugin config --set` value, then the declared
// environment variable, then the default. Parsed once at load; an invalid value fails the load loudly.

import { join } from "node:path";

export interface Settings {
  /** Timer recompute interval (design Q7, default 120 s): picks up changes others make on GitHub. */
  readonly recomputeIntervalMs: number;
  /** Agenda state files live in `<dataDir>/state`. */
  readonly dataDir: string;
}

export const PLUGIN_NAME = "omp-roundtable";

export function parseSettings(configured: Readonly<Record<string, unknown>>, env: Readonly<Record<string, string | undefined>>, agentDir: string): Settings {
  const pick = (key: string, envName: string): unknown => configured[key] ?? env[envName];
  const seconds = pick("recomputeIntervalSeconds", "OMP_ROUNDTABLE_RECOMPUTE_SECONDS");
  let interval = 120;
  if (seconds !== undefined && seconds !== "") {
    const n = typeof seconds === "number" ? seconds : Number(seconds);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${PLUGIN_NAME}: setting recomputeIntervalSeconds (OMP_ROUNDTABLE_RECOMPUTE_SECONDS) must be a positive integer, got ${JSON.stringify(seconds)}`);
    interval = n;
  }
  const dir = pick("dataDir", "OMP_ROUNDTABLE_DIR");
  if (dir !== undefined && (typeof dir !== "string" || dir === "")) throw new Error(`${PLUGIN_NAME}: setting dataDir must be a non-empty path`);
  return { recomputeIntervalMs: interval * 1000, dataDir: typeof dir === "string" ? dir : join(agentDir, PLUGIN_NAME) };
}
