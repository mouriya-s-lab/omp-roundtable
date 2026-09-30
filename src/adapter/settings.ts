// Plugin settings (package.json `omp.settings`). Precedence per key: `omp plugin config --set` value, then the declared
// environment variable, then the default. Parsed once at load; an invalid value fails the load loudly.

import { join } from "node:path";

export interface Settings {
  /** Full-recompute interval (design Q7, default 120 s). */
  readonly recomputeIntervalMs: number;
  /** Hourly ceiling of GitHub API calls made by this plugin (design Q7, default 1500). */
  readonly hourlyGhCallCeiling: number;
  /** HMAC key, local state table, gh call log and shim live here. */
  readonly dataDir: string;
}

export const PLUGIN_NAME = "omp-roundtable";

export function parseSettings(configured: Readonly<Record<string, unknown>>, env: Readonly<Record<string, string | undefined>>, agentDir: string): Settings {
  const pick = (key: string, envName: string): unknown => configured[key] ?? env[envName];
  const positiveInt = (key: string, envName: string, fallback: number): number => {
    const raw = pick(key, envName);
    if (raw === undefined || raw === "") return fallback;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${PLUGIN_NAME}: setting ${key} (${envName}) must be a positive integer, got ${JSON.stringify(raw)}`);
    return n;
  };
  const dir = pick("dataDir", "OMP_ROUNDTABLE_DIR");
  if (dir !== undefined && (typeof dir !== "string" || dir === "")) throw new Error(`${PLUGIN_NAME}: setting dataDir must be a non-empty path`);
  return {
    recomputeIntervalMs: positiveInt("recomputeIntervalSeconds", "OMP_ROUNDTABLE_RECOMPUTE_SECONDS", 120) * 1000,
    hourlyGhCallCeiling: positiveInt("hourlyGhCallCeiling", "OMP_ROUNDTABLE_HOURLY_GH_CALLS", 1500),
    dataDir: typeof dir === "string" ? dir : join(agentDir, PLUGIN_NAME),
  };
}
