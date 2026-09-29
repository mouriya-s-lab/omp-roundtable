// Bounded BFS over concrete worlds, deduplicated by α (classified situations + remaining budget). core.md §6.3.

import { canonical } from "../../src/core/index.ts";
import type { Derived } from "../../src/core/index.ts";
import { advanceDefault, expand, situationKey, type Rejection, type World } from "./world.ts";
import { classify } from "../../src/core/index.ts";
import { missingDesignCommits } from "./invariants.ts";

export interface Node {
  readonly id: number;
  readonly key: string;
  readonly world: World;
  readonly parent: number | null;
  readonly via: string;
  readonly depth: number;
  readonly succ: { readonly label: string; readonly to: number }[];
  derived: Derived | null;
}

export interface Violation {
  readonly property: string;
  readonly node: number;
  readonly detail: string;
}

export interface Exploration {
  readonly nodes: readonly Node[];
  readonly violations: readonly Violation[];
  readonly rejections: readonly (Rejection & { readonly node: number })[];
  readonly truncated: boolean;
  readonly edges: number;
}

export type Invariant = (n: Node, d: Derived) => string | null;

/**
 * State key: α (classified situations) + remaining budget + the concrete fact the merge invariant reads that
 * classify does not surface (design commits missing from our PR head). Without the last part a world violating
 * the invariant would be merged into a clean representative and never checked.
 */
export function keyOf(w: World): string {
  const c = classify(w.state, w.facts, w.host);
  const pr = c.member?.w.pr ?? null;
  const hidden = c.member === null || pr === null ? 0 : missingDesignCommits(w, c.member.w.entry.issue, pr.head).length;
  return canonical({ s: situationKey(c), budget: w.budget, missingDesign: hidden > 0 });
}

export function explore(init: World, invariants: readonly { readonly name: string; readonly check: Invariant }[], maxNodes: number): Exploration {
  const nodes: Node[] = [];
  const index = new Map<string, number>();
  const violations: Violation[] = [];
  const rejections: (Rejection & { node: number })[] = [];
  let edges = 0;
  const add = (world: World, parent: number | null, via: string, depth: number): number => {
    const key = keyOf(world);
    const known = index.get(key);
    if (known !== undefined) return known;
    const id = nodes.length;
    nodes.push({ id, key, world, parent, via, depth, succ: [], derived: null });
    index.set(key, id);
    return id;
  };
  add(init, null, "init", 0);
  let truncated = false;
  for (let i = 0; i < nodes.length; i++) {
    if (i >= maxNodes) {
      truncated = true;
      break;
    }
    const n = nodes[i];
    if (n === undefined) break;
    const x = expand(n.world);
    n.derived = x.derived;
    for (const inv of invariants) {
      const bad = inv.check(n, x.derived);
      if (bad !== null) violations.push({ property: inv.name, node: n.id, detail: bad });
    }
    // default branch advancing by an unreferenced commit must not change α
    if (keyOf(advanceDefault(n.world)) !== n.key) violations.push({ property: "default-branch advance changes Situation", node: n.id, detail: "" });
    for (const r of x.rejections) rejections.push({ ...r, node: n.id });
    for (const e of x.edges) {
      edges++;
      const to = add(e.world, n.id, e.label, n.depth + 1);
      n.succ.push({ label: e.label, to });
    }
  }
  return { nodes, violations, rejections, truncated, edges };
}

/** Node ids from which some path reaches a node satisfying `goal` (reverse reachability over expanded nodes). */
export function canReach(nodes: readonly Node[], goal: (n: Node) => boolean): Set<number> {
  const preds = new Map<number, number[]>();
  for (const n of nodes) for (const s of n.succ) {
    const list = preds.get(s.to) ?? [];
    list.push(n.id);
    preds.set(s.to, list);
  }
  const ok = new Set<number>();
  const queue: number[] = [];
  for (const n of nodes) if (n.derived !== null && goal(n)) {
    ok.add(n.id);
    queue.push(n.id);
  }
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    for (const p of preds.get(id) ?? []) if (!ok.has(p)) {
      ok.add(p);
      queue.push(p);
    }
  }
  return ok;
}

/** The path of edge labels from the initial node to `id`, each with the obligation kinds at its source. */
export function trace(nodes: readonly Node[], id: number): string[] {
  const out: string[] = [];
  let cur: Node | undefined = nodes[id];
  while (cur !== undefined) {
    const obligations = cur.derived === null ? "(unexpanded)" : cur.derived.obligations.map((o) => o.kind).join(",") || "-";
    out.unshift(`  [${cur.id}] via «${cur.via}» → obligations {${obligations}} done=${cur.derived?.done ?? "?"} waiting=${cur.derived?.waiting ?? "?"}`);
    cur = cur.parent === null ? undefined : nodes[cur.parent];
  }
  return out;
}
