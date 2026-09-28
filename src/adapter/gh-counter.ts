import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface GhCounter {
  readonly shimPath: string;
  readonly logPath: string;
  /** Epoch ms timestamps of logged invocations >= sinceMs, ascending (used to compute when the window frees up). */
  timestampsSince(sinceMs: number): readonly number[];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

interface LogEntry { readonly timestamp: number; readonly line: string }

function readEntries(logPath: string): readonly LogEntry[] {
  let contents: string;
  try {
    contents = readFileSync(logPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const lines = contents.split("\n");
  // An unterminated final line may be a partial append; only committed lines count.
  lines.pop();
  const entries: LogEntry[] = [];
  for (const line of lines) {
    const match = /^(\d+) ([^\s]{0,200}) ([^\s]{0,200})$/.exec(line);
    if (!match) continue;
    const timestamp = Number(match[1]);
    if (Number.isSafeInteger(timestamp)) entries.push({ timestamp, line });
  }
  return entries;
}

/** Writes `<dir>/gh-counted` (mode 0755, atomically) wrapping `realGh` (absolute path), logging to `<dir>/gh-calls.log`; rotates the log (keeps entries with ts >= nowMs - 24h). Creates `dir` (0700) if missing. */
export function installGhCounter(dir: string, realGh: string, nowMs: number): GhCounter {
  if (!isAbsolute(realGh)) throw new Error("realGh must be an absolute path");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const shimPath = join(dir, "gh-counted");
  const logPath = join(dir, "gh-calls.log");
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  const rotated = readEntries(logPath).filter((entry) => entry.timestamp >= cutoff).map((entry) => `${entry.line}\n`).join("");

  const script = `#!/bin/sh
LOG=${shellQuote(logPath)}
if [ "$#" -gt 0 ]; then
  ARG1=$(printf '%s' "$1" | LC_ALL=C tr '[:space:]' '_' | LC_ALL=C cut -c 1-200)
else
  ARG1=-
fi
if [ "$#" -gt 1 ]; then
  ARG2=$(printf '%s' "$2" | LC_ALL=C tr '[:space:]' '_' | LC_ALL=C cut -c 1-200)
else
  ARG2=-
fi
# macOS date lacks %N. Perl's Time::HiRes gives milliseconds on macOS and Linux;
# seconds from date are a fallback when Perl or Time::HiRes is unavailable.
if TS=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000' 2>/dev/null); then
  :
else
  TS=$(date +%s)000
fi
printf '%s %s %s\\n' "$TS" "$ARG1" "$ARG2" >> "$LOG"
exec ${shellQuote(realGh)} "$@"
`;

  const temporaryDir = mkdtempSync(join(dir, ".gh-counter-"));
  try {
    const temporaryLog = join(temporaryDir, "gh-calls.log");
    writeFileSync(temporaryLog, rotated, { mode: 0o600 });
    chmodSync(temporaryLog, 0o600);
    renameSync(temporaryLog, logPath);
    const temporaryShim = join(temporaryDir, "gh-counted");
    writeFileSync(temporaryShim, script, { mode: 0o755 });
    chmodSync(temporaryShim, 0o755);
    renameSync(temporaryShim, shimPath);
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }

  return {
    shimPath,
    logPath,
    timestampsSince(sinceMs) { return readEntries(logPath).filter((entry) => entry.timestamp >= sinceMs).map((entry) => entry.timestamp).sort((a, b) => a - b); },
  };
}
