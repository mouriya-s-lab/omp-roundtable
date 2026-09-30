// Policy text for briefs (core `Policy`): read fresh every round, never cached across rounds.
// `appendSystem`: the agent dir's APPEND_SYSTEM.md. `systemBlocks`: the blocks core.briefs.md names, sliced verbatim
// from the system prompt the main session saw at its latest `before_agent_start`.

import { readFileSync } from "node:fs";
import type { Policy } from "../core/index.ts";

/** Top-level blocks of the host system prompt that seat briefs carry verbatim (core.briefs.md「策略原文」). */
const HEADINGS: readonly RegExp[] = [/^# Engineering\b/, /^§ Workflow\b/, /^§ Delivery\b/, /^§ Critical\b/];

/** A line that starts the next top-level block of the host prompt: `§ X`, `# Word` (not `# 1. …`), or a top-level tag. */
const BLOCK_START = /^(§ |# [^\d\s]|<(generic-rules|project-context|skills|workstation)>)/;

export function systemBlocks(systemPrompt: readonly string[]): string {
  const out: string[] = [];
  for (const part of systemPrompt) {
    const lines = part.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.startsWith("<generic-rules>")) {
        const end = lines.findIndex((l, j) => j >= i && l.includes("</generic-rules>"));
        const last = end === -1 ? lines.length - 1 : end;
        out.push(lines.slice(i, last + 1).join("\n"));
        i = last;
        continue;
      }
      if (!HEADINGS.some((h) => h.test(line))) continue;
      let j = i + 1;
      while (j < lines.length && !BLOCK_START.test(lines[j] ?? "")) j++;
      out.push(cutAtTag(lines.slice(i, j).join("\n").trimEnd()));
      i = j - 1;
    }
  }
  return out.join("\n\n");
}

/** A block's last line may run into the next top-level tag (e.g. `</critical><project-context>`). */
function cutAtTag(block: string): string {
  const at = block.search(/<(project-context|generic-rules|skills|workstation)>/);
  return at === -1 ? block : block.slice(0, at).trimEnd();
}

export function readPolicy(appendSystemPath: string, systemPrompt: readonly string[], seatAgents: Policy["seatAgents"]): Policy {
  let appendSystem = "";
  try {
    appendSystem = readFileSync(appendSystemPath, "utf8");
  } catch (err) {
    if (!(typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT")) throw err;
  }
  return { appendSystem, systemBlocks: systemBlocks(systemPrompt), seatAgents };
}
