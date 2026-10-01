// Concrete worlds for the abstraction layer and the model checker (core.md §6.2, §6.3, §6.4).
// A World is one agenda state plus GitHub facts plus the host observation plus the explorer's own counters and budgets.
// `expand` enumerates every edge kind the model checker explores; every reply and effect result goes through `step`.

import { canonical, convene, derive, fnv64, step, stripSuffix } from "../../src/core/index.ts";
import type {
  AgendaId,
  AgendaState,
  AgentId,
  BodyReplacement,
  Caller,
  ChecksState,
  Claim,
  Decision,
  Derived,
  Draft,
  EffectResult,
  EventId,
  Facts,
  FindingVerdict,
  Hash,
  Host,
  IssueFact,
  IssueRef,
  LiveFacts,
  Mergeable,
  Millis,
  Obligation,
  ObligationId,
  Policy,
  PrFact,
  PrRef,
  Reply,
  RepoRef,
  Sha,
} from "../../src/core/index.ts";
import type { Classified } from "../../src/core/classify.ts";
import { MEMBER_STALLS } from "./stalls.ts";

export const repo: RepoRef = { owner: "lab", name: "sandbox" };
export const policy: Policy = { appendSystem: "APPEND", systemBlocks: "BLOCKS", seatAgents: { owner: "task:high", gate: "task:mid" } };
export const issueRef = (n: number): IssueRef => ({ repo, number: n });
export const sha = (s: string): Sha => s as Sha;
export const hash = (s: string): Hash => s as Hash;
export const ms = (n: number): Millis => n as Millis;

export interface Budget {
  /** Human/environment perturbations (push, body edit, close/reopen, checks/mergeable flips, seat parked/aborted, PR closed). */
  readonly perturb: number;
  /** Failing gate verdicts, failing check settlements, effect execution failures. */
  readonly fail: number;
  /** Claims raised by seats. */
  readonly claim: number;
  /** Decisions whose drafts insert agenda entries (split, correction, closure补项). */
  readonly draft: number;
}

export interface World {
  readonly state: AgendaState;
  readonly facts: Facts;
  readonly host: Host;
  /** Head of the default branch (explorer bookkeeping; the core reads only containment and on-default facts). */
  readonly defaultHead: Sha;
  readonly clock: number;
  readonly seq: number;
  readonly budget: Budget;
}

export interface Edge {
  /** Abstract label: kind of edge and variant, never concrete ids. */
  readonly label: string;
  readonly world: World;
  /** Edges that only settle `unknown`/`pending` or restart the process (fairness, core.md §6.4). */
  readonly fairness: boolean;
}

// ------------------------------------------------------------------ builders

export function issue(n: number, over: Partial<IssueFact> = {}): IssueFact {
  return {
    ref: issueRef(n),
    open: true,
    events: [],
    bodyHash: hash(`body-${n}`),
    children: [],
    ...over,
  };
}

export interface AgendaSpec {
  readonly members: readonly number[];
  readonly parent: number | null;
  /** Give the parent a child outside the agenda (explores decide(agendaGap)). */
  readonly outsideChild: boolean;
  readonly budget: Budget;
}

export type WorldMode = "fresh" | "adopted";

export function initialWorld(spec: AgendaSpec, mode: WorldMode = "fresh"): World {
  const members = spec.members.map((n) => issue(n));
  const outside = spec.outsideChild ? [issue(90)] : [];
  const parent =
    spec.parent === null ? [] : [issue(spec.parent, { children: [...spec.members.map(issueRef), ...outside.map((i) => i.ref)] }), ...outside];
  const adopted = mode === "adopted" ? spec.members.map((n, i) => {
    const ref: PrRef = { repo, number: 100 + i };
    const head = sha(`adopt-${n}-${i}`);
    return {
      ref,
      state: { kind: "open" as const },
      headBranch: "feat",
      head,
      target: { repo, base: "main" },
      bodyHash: hash(`adopted-pr-body-${n}`),
      mergeable: "yes" as const,
      checks: { state: "pass" as const, failedRunId: null },
      closes: [issueRef(n)],
    } satisfies PrFact;
  }) : [];
  const adoptedPr = (n: number): PrRef | null => adopted.find((p) => p.closes.some((ref) => ref.number === n))?.ref ?? null;
  const state = convene(
    "agenda-1" as AgendaId,
    ms(1000),
    spec.parent === null ? null : issueRef(spec.parent),
    spec.members.map((n) => ({ issue: issueRef(n), target: { repo, base: "main" }, designOnly: false, adoptPr: adoptedPr(n) })),
  );
  const base = sha("base0");
  return {
    state,
    facts: {
      issues: [...members, ...parent],
      prs: adopted,
      links: [],
      commits: {
        onDefault: [{ repo, sha: base }],
        contains: adopted.map((p) => ({ repo, ancestor: base, descendant: p.head })),
        baseHead: mode === "adopted" ? [{ repo, base: "main", sha: base }] : [],
      },
    },
    host: { agents: [], failures: [] },
    defaultHead: base,
    clock: 2000,
    seq: 0,
    budget: spec.budget,
  };
}

// ------------------------------------------------------------------ small immutable updates

const tick = (w: World): World => ({ ...w, clock: w.clock + 10, seq: w.seq + 1 });
const withFacts = (w: World, facts: Partial<Facts>): World => ({ ...w, facts: { ...w.facts, ...facts } });
const spend = (w: World, k: keyof Budget): World | null => (w.budget[k] <= 0 ? null : { ...w, budget: { ...w.budget, [k]: w.budget[k] - 1 } });

const sameRef = (a: IssueRef, b: IssueRef): boolean => a.number === b.number && a.repo.owner === b.repo.owner && a.repo.name === b.repo.name;

function updateIssue(w: World, ref: IssueRef, f: (i: IssueFact) => IssueFact): World {
  return withFacts(w, { issues: w.facts.issues.map((i) => (sameRef(i.ref, ref) ? f(i) : i)) });
}

function updatePr(w: World, number: number, f: (p: PrFact) => PrFact): World {
  return withFacts(w, { prs: w.facts.prs.map((p) => (p.ref.number === number ? f(p) : p)) });
}

function lifecycle(w: World, ref: IssueRef, kind: "closed" | "reopened"): World {
  const t = tick(w);
  return updateIssue(t, ref, (i) => ({
    ...i,
    open: kind === "reopened",
    events: [...i.events, { id: `ev-${t.seq}` as EventId, kind, at: ms(t.clock) }],
  }));
}

/** A new commit on top of `parents`: records every (ancestor, commit) pair, as the store reports containment transitively. */
function addCommit(w: World, commit: Sha, parents: readonly (Sha | null)[]): World {
  const all = new Set<Sha>();
  for (const p of parents) if (p !== null) for (const a of ancestors(w, p)) all.add(a);
  let out = w;
  for (const a of all) out = addContains(out, a, commit);
  return out;
}

function addContains(w: World, ancestor: Sha, descendant: Sha): World {
  return withFacts(w, { commits: { ...w.facts.commits, contains: [...w.facts.commits.contains, { repo, ancestor, descendant }] } });
}

/** Every commit `head` contains by the recorded facts (the core only reads direct pairs; we close transitively). */
function ancestors(w: World, head: Sha): Sha[] {
  const out = new Set<Sha>([head]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of w.facts.commits.contains)
      if (out.has(c.descendant) && !out.has(c.ancestor)) {
        out.add(c.ancestor);
        grew = true;
      }
  }
  return [...out];
}

/** External landing used by fairness edges: a new merge commit carries the witnessed design commit onto the default head. */
function landDefault(w: World, commit: Sha): World {
  const t = tick(w);
  const landing = sha(`external-design-${commit}`);
  const next = addCommit(t, landing, [t.defaultHead, commit]);
  const onDefault = ancestors(next, landing).map((sha) => ({ repo, sha }));
  return {
    ...withFacts(next, { commits: { ...next.facts.commits, onDefault: [...next.facts.commits.onDefault, ...onDefault] } }),
    defaultHead: landing,
  };
}

/** External merged child used by the agenda-gap fairness edge; it is a normal fact with ordinary commit ancestry. */
function mergeExternal(w: World, member: IssueRef): World {
  const t = tick(w);
  const mergeSha = sha(`external-merge-${member.number}`);
  let next = addCommit(t, mergeSha, [t.defaultHead]);
  const pr: PrFact = {
    ref: { repo, number: 10_000 + member.number },
    state: { kind: "merged", mergeSha, mergedAt: ms(t.clock) },
    headBranch: `external-${member.number}`,
    head: mergeSha,
    target: { repo, base: "main" },
    bodyHash: hash(`external-merge-${member.number}`),
    mergeable: "yes",
    checks: { state: "pass", failedRunId: null },
    closes: [member],
  };
  const onDefault = ancestors(next, mergeSha).map((s) => ({ repo, sha: s }));
  next = withFacts(next, {
    prs: [...next.facts.prs, pr],
    commits: { ...next.facts.commits, onDefault: [...next.facts.commits.onDefault, ...onDefault] },
  });
  return { ...next, defaultHead: mergeSha };
}

// ------------------------------------------------------------------ replies and effect results through step

export interface Rejection {
  readonly label: string;
  readonly reason: string;
  readonly obligation: string;
}

type Stepped =
  | { readonly kind: "ok"; readonly world: World }
  | { readonly kind: "same" }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "world"; readonly world: World };

const NO_LIVE: LiveFacts = { branchHead: null, branchContains: [] };

/**
 * A reply through `step`. Every accepted reply is also checked against core.md §6.3: the state changed, sending the
 * same reply again is `same`, and the answered ticket is no longer derived (claims are interim and keep it).
 */
function reply(w: World, caller: Caller, r: Reply, live: LiveFacts = NO_LIVE): Stepped {
  const t = tick(w);
  const event = { kind: "reply", caller, reply: r, live, at: ms(t.clock) } as const;
  const s = step(t.state, t.facts, t.host, policy, event);
  switch (s.kind) {
    case "next": {
      if (canonical({ ...s.state, version: 0 }) === canonical({ ...t.state, version: 0 })) throw new Error(`${r.kind}: next without a state change`);
      const again = step(s.state, t.facts, t.host, policy, event);
      if (again.kind !== "same") throw new Error(`${r.kind}: resending an applied reply gave ${again.kind}${again.kind === "rejected" ? ` (${again.reason})` : ""}`);
      if (r.kind !== "claim" && r.obligation !== null && derive(s.state, t.facts, t.host, policy).obligations.some((o) => o.id === r.obligation))
        throw new Error(`${r.kind}: the answered ticket ${r.obligation} is still derived`);
      return { kind: "ok", world: { ...t, state: s.state } };
    }
    case "same":
      return { kind: "same" };
    case "rejected":
      return { kind: "rejected", reason: s.reason };
    default:
      return assertNever(s);
  }
}

/** Writes an effect result back; the effect is current, so anything but `next` is a core defect, and a resend is `same`. */
function writeBack(w: World, effect: ObligationId, result: EffectResult): World {
  const s = step(w.state, w.facts, w.host, policy, { kind: "effectDone", effect, result });
  if (s.kind !== "next") throw new Error(`effect result ${result.kind} not written: ${s.kind === "rejected" ? s.reason : "same"}`);
  const again = step(s.state, w.facts, w.host, policy, { kind: "effectDone", effect, result });
  if (again.kind !== "same") throw new Error(`effect result ${result.kind}: resend gave ${again.kind}`);
  return { ...w, state: s.state };
}

// ------------------------------------------------------------------ successors

export interface Expansion {
  readonly derived: Derived;
  readonly edges: readonly Edge[];
  readonly rejections: readonly Rejection[];
}

export function expand(w: World): Expansion {
  const d = derive(w.state, w.facts, w.host, policy);
  const edges: Edge[] = [];
  const rejections: Rejection[] = [];
  const push = (label: string, next: World | null, fairness = false): void => {
    if (next !== null) edges.push({ label, world: next, fairness });
  };
  const via = (label: string, ob: Obligation, a: Stepped | null): void => {
    if (a === null || a.kind === "same") return;
    if (a.kind === "world") {
      push(label, a.world);
      return;
    }
    if (a.kind === "ok") push(label, a.world);
    else rejections.push({ label, reason: a.reason, obligation: ob.kind });
  };

  for (const ob of d.obligations) {
    switch (ob.holder) {
      case "program":
        for (const [label, next] of programEdges(w, d.classified, ob)) push(label, next);
        break;
      case "main":
        for (const [label, a] of mainEdges(w, d.classified, ob)) via(label, ob, a);
        break;
      case "owner":
      case "gate":
        for (const [label, a] of seatEdges(w, d.classified, ob)) via(label, ob, a);
        break;
      default:
        assertNever(ob.holder);
    }
  }
  for (const [label, next, fair] of environmentEdges(w, d.classified)) push(label, next, fair);
  return { derived: d, edges, rejections };
}

// ---------------------------------------------------------------- program effects

function programEdges(w: World, c: Classified, ob: Obligation): [string, World | null][] {
  const a = ob.action;
  if (a === null) return [];
  const out: [string, World | null][] = [];
  switch (a.kind) {
    case "effect": {
      out.push([`effect ${a.target.kind}`, applyEffect(w, ob.id, a.target)]);
      // the write reached GitHub but the result was not written back (crash window): the next round must not repeat it
      out.push([`effect ${a.target.kind} (result lost)`, effectFacts(tick(w), a.target).world]);
      // execution failure (core.md §3 效应: execution records the failure time). A first failure spends fail budget; a
      // failure again after a `retry` decision is free, so every retry → fail → decide(effectFailed) cycle is explored
      const retried = c.effects.some((e) => e.w.id === ob.id && e.s.failure === "retry");
      const failed = retried ? w : spend(w, "fail");
      if (failed !== null) {
        const t = tick(failed);
        out.push([`effect ${a.target.kind} fails${retried ? " again after retry" : ""}`, { ...t, host: { ...t.host, failures: [...t.host.failures, { effect: ob.id, at: ms(t.clock), error: "boom" }] } }]);
      }
      break;
    }
    case "merge": {
      const t = tick(w);
      const mergeSha = sha(`m${t.seq}`);
      let next = updatePr(t, a.pr.number, (p) => ({ ...p, state: { kind: "merged", mergeSha, mergedAt: ms(t.clock) } }));
      next = addCommit(next, mergeSha, [a.head, next.defaultHead]);
      const onDefault = ancestors(next, mergeSha).map((s) => ({ repo, sha: s }));
      next = { ...withFacts(next, { commits: { ...next.facts.commits, onDefault: [...next.facts.commits.onDefault, ...onDefault] } }), defaultHead: mergeSha };
      const closes = next.facts.prs.find((p) => p.ref.number === a.pr.number)?.closes ?? [];
      let auto = next;
      for (const ref of closes) if (auto.facts.issues.find((i) => sameRef(i.ref, ref))?.open === true) auto = lifecycle(auto, ref, "closed");
      out.push(["merge (issue auto-closed)", auto]);
      out.push(["merge (no auto-close)", next]);
      break;
    }
    case "close":
    case "reopen":
      out.push([`program ${a.kind}`, lifecycle(w, a.issue, a.kind === "close" ? "closed" : "reopened")]);
      break;
    case "closeParent":
    case "reopenParent":
      out.push([`program ${a.kind}`, lifecycle(w, a.issue, a.kind === "closeParent" ? "closed" : "reopened")]);
      break;
    case "wake": {
      out.push(["program wake", wakeAgent(tick(w), a.agent)]);
      // delivery failed (IRC receipt `failed`): the adapter records it, core reads no wake failure, the seat stays
      // parked and the next round wakes it again — the same situation, so it spends no budget
      const t = tick(w);
      out.push(["program wake fails", { ...t, host: { ...t.host, failures: [...t.host.failures, { effect: ob.id, at: ms(t.clock), error: "boom" }] } }]);
      break;
    }
    default:
      assertNever(a);
  }
  return out;
}

type EffectTarget = Extract<NonNullable<Obligation["action"]>, { kind: "effect" }>["target"];

/** The GitHub side of an effect, and the result the store writes back. */
function effectFacts(t: World, target: EffectTarget): { world: World; result: EffectResult } {
  switch (target.kind) {
    case "openPr": {
      // the store's source check: an open PR from this head branch closing the member is the one to update and record
      const existing = t.facts.prs.find((p) => p.state.kind === "open" && p.headBranch === target.submit.branch && p.closes.some((c) => sameRef(c, target.member)));
      const number = existing?.ref.number ?? 100 + t.seq;
      const pr: PrFact = {
        ref: { repo, number },
        state: { kind: "open" },
        headBranch: target.submit.branch,
        head: target.submit.head,
        target: target.target,
        bodyHash: fnv64(`pr-body|${target.submit.answered}|${target.submit.body}|${target.designCommits.join(",")}`),
        mergeable: existing?.mergeable ?? "unknown",
        checks: existing?.checks ?? { state: "pending", failedRunId: null },
        closes: [target.member],
      };
      return { world: withFacts(t, { prs: [...t.facts.prs.filter((p) => p.ref.number !== number), pr] }), result: { kind: "prApplied", pr: pr.ref } };
    }
    case "updatePr": {
      const pr = target.pr;
      if (pr === null) throw new Error("updatePr without PR");
      return {
        world: updatePr(t, pr.number, (p) => ({ ...p, bodyHash: fnv64(`pr-body|${target.submit.answered}|${target.submit.body}|${target.designCommits.join(",")}`) })),
        result: { kind: "prApplied", pr },
      };
    }
    case "applyBody":
      return { world: updateIssue(t, target.replacement.issue, (i) => ({ ...i, bodyHash: target.replacement.targetHash })), result: { kind: "bodyApplied" } };
    case "createIssue": {
      // the store's source check finds an issue already created for this draft; the model keys it by the draft id
      const created = issue(200 + (Number.parseInt(fnv64(target.draft.id).slice(0, 6), 16) % 700));
      const exists = t.facts.issues.some((i) => sameRef(i.ref, created.ref));
      return { world: exists ? t : withFacts(t, { issues: [...t.facts.issues, created] }), result: { kind: "issueCreated", issue: created.ref } };
    }
    case "rerunChecks":
      return { world: updatePr(t, target.pr.number, (p) => ({ ...p, checks: { state: "pending", failedRunId: null } })), result: { kind: "checksRerun" } };
    default:
      return assertNever(target);
  }
}

function applyEffect(w: World, id: ObligationId, target: EffectTarget): World {
  const { world, result } = effectFacts(tick(w), target);
  return writeBack(world, id, result);
}

// ---------------------------------------------------------------- main session replies

const MAIN: Caller = { kind: "main" };

function decision(w: World, ob: Obligation, dec: Decision, drafts: readonly Draft[] = [], bodyReplacements: readonly BodyReplacement[] = []): Stepped {
  return reply(w, MAIN, { kind: "decision", obligation: ob.id, decision: dec, rationale: "r", drafts, bodyReplacements });
}

function draft(anchor: Draft["anchor"], designOnly = false): Draft {
  return { index: 0, repo, title: "t", body: "b", anchor, target: { repo, base: "main" }, designOnly };
}

function replaceBody(w: World, ref: IssueRef): BodyReplacement {
  const i = w.facts.issues.find((x) => sameRef(x.ref, ref));
  return { issue: ref, baseHash: i?.bodyHash ?? hash(""), body: `replaced-${w.seq}` };
}

function mainEdges(w: World, c: Classified, ob: Obligation): [string, Stepped | null][] {
  const out: [string, Stepped | null][] = [];
  const add = (label: string, a: Stepped | null): void => {
    out.push([`${ob.kind}: ${label}`, a]);
  };
  const m = c.member;
  switch (ob.kind) {
    case "decideClaim": {
      const pending = ob.context === "closure" ? c.closure.w.claim : ob.context.startsWith("verify:") ? (c.verification?.w.claim ?? null) : (m?.w.claim ?? null);
      if (pending === null) break;
      const cl = pending.claim;
      const member = m?.w.entry.issue ?? null;
      switch (cl.kind) {
        case "question": {
          const q = (verdict: Extract<Decision, { subject: "question" }>["verdict"]): Decision => ({ subject: "question", claim: pending.id, verdict, affected: member === null ? [] : [member] });
          add("answered", decision(w, ob, q({ kind: "answered" })));
          add("outOfDomain", decision(w, ob, q({ kind: "outOfDomain" })));
          if (member !== null) {
            add("implDefect", decision(w, ob, q({ kind: "implDefect" })));
            const d = sha(`d${w.seq}`);
            add("designGap(withPr)", decision(w, ob, q({ kind: "designGap", route: { kind: "withPr", commit: d, designBranch: "design" } }), [], [replaceBody(w, member)]));
            add("acceptanceMethod", decision(w, ob, q({ kind: "acceptanceMethod" }), [], [replaceBody(w, member)]));
          }
          break;
        }
        case "noCode":
        case "split": {
          const subject = cl.kind === "noCode" ? "noCodeClaim" : "splitClaim";
          const bodyHashNow = w.facts.issues.find((i) => sameRef(i.ref, cl.member))?.bodyHash ?? hash("");
          const base = { subject, claim: pending.id, member: cl.member, bodyHash: bodyHashNow } as const;
          add("refuted", decision(w, ob, { ...base, verdict: "refuted" }));
          if (cl.kind === "noCode") add("confirmed", decision(w, ob, { ...base, verdict: "confirmed" }));
          else {
            const spent = spend(w, "draft");
            if (spent !== null) {
              add("confirmed(before)", decision(spent, ob, { ...base, verdict: "confirmed" }, [draft({ kind: "before", entry: cl.member })], [replaceBody(spent, cl.member)]));
              add("confirmed(after)", decision(spent, ob, { ...base, verdict: "confirmed" }, [draft({ kind: "after", entry: cl.member })], [replaceBody(spent, cl.member)]));
            }
          }
          break;
        }
        case "blocked":
          for (const verdict of ["replacePr", "external", "refuted"] as const) add(verdict, decision(w, ob, { subject: "blockedClaim", claim: pending.id, verdict }));
          break;
        default:
          assertNever(cl);
      }
      break;
    }
    case "decideFindings": {
      const v = m?.w.unadjudicated ?? null;
      if (v === null || m === null) break;
      const member = m.w.entry.issue;
      const each = (fv: FindingVerdict): Decision => ({ subject: "findings", verdictId: v.id, verdict: fv });
      add("upheld(owner)", decision(w, ob, each({ kind: "upheld", responsible: "owner" })));
      add("upheld(main)", decision(w, ob, each({ kind: "upheld", responsible: "main" })));
      add("rejected", decision(w, ob, each({ kind: "rejected", basis: "b" })));
      add("outOfScope", decision(w, ob, each({ kind: "outOfScope", draft: draft({ kind: "outsideAgenda" }) })));
      add("designGap(withPr)", decision(w, ob, each({ kind: "designGap", route: { kind: "withPr", commit: sha(`d${w.seq}`), designBranch: "design" } }), [], [replaceBody(w, member)]));
      add("acceptanceMethod", decision(w, ob, each({ kind: "acceptanceMethod" }), [], [replaceBody(w, member)]));
      break;
    }
    case "designFix": {
      const v = m?.w.designFixVerdict ?? null;
      if (v !== null) add("commit", decision(w, ob, { subject: "designFix", verdictId: v.id, commit: sha(`df${w.seq}`) }));
      break;
    }
    case "decideChecks": {
      const pr = m?.w.pr ?? null;
      const run = m?.w.failedRun ?? null;
      if (pr !== null && run !== null) for (const verdict of ["rerun", "fixNeeded", "external"] as const) add(verdict, decision(w, ob, { subject: "checks", pr: pr.ref, runId: run, verdict }));
      break;
    }
    case "decideReopened":
    case "decideClosed": {
      const r = c.reconcile.find((x) => x.w.ids.decideReopened === ob.id || x.w.ids.decideClosed === ob.id);
      if (r === undefined || r.w.eventForDecision === null) break;
      const event = r.w.eventForDecision as EventId;
      if (ob.kind === "decideReopened") {
        add("restore", decision(w, ob, { subject: "reopened", member: r.w.member, event, verdict: "restore" }));
        // reopenAccepted revokes a noCode confirmation; it is not a variant for delivered members
        if (r.s.outcome === "noCode") add("reopenAccepted", decision(w, ob, { subject: "reopened", member: r.w.member, event, verdict: "reopenAccepted" }));
        const spent = spend(w, "draft");
        if (spent !== null) add("correction", decision(spent, ob, { subject: "reopened", member: r.w.member, event, verdict: "correction" }, [draft({ kind: "correctionOf", entry: r.w.member })]));
      } else {
        const bodyHashNow = r.w.bodyHash ?? hash("");
        add("confirmedNoCode", decision(w, ob, { subject: "closed", member: r.w.member, event, bodyHash: bodyHashNow, verdict: "confirmedNoCode" }));
        add("reopen", decision(w, ob, { subject: "closed", member: r.w.member, event, bodyHash: bodyHashNow, verdict: "reopen" }));
      }
      break;
    }
    case "decidePostMergeFail":
    case "decideClosureFail": {
      const failing = ob.kind === "decidePostMergeFail" ? c.verification?.w.failing : c.closure.w.failing;
      if (failing === null || failing === undefined) break;
      const subject = ob.kind === "decidePostMergeFail" ? "postMergeFail" : "closureFail";
      add("reverify", decision(w, ob, { subject, verdictId: failing.id, verdict: "reverify" }));
      const spent = spend(w, "draft");
      if (spent !== null) {
        const anchor: Draft["anchor"] =
          ob.kind === "decidePostMergeFail" && c.verification !== null
            ? { kind: "correctionOf", entry: c.verification.w.unit.top.issue }
            : { kind: "after", entry: c.units.at(-1)?.top.issue ?? issueRef(0) };
        add("correction", decision(spent, ob, { subject, verdictId: failing.id, verdict: "correction" }, [draft(anchor)]));
      }
      break;
    }
    case "decide:orphanDesign":
    case "decide:migration":
    case "decide:agendaGap": {
      const sub = c.subjects.find((s) => s.w.id === ob.id);
      if (sub === undefined) break;
      const sw = sub.w;
      const spent = spend(w, "draft");
      if (spent !== null) {
        const remediation = draft({ kind: "after", entry: c.units.at(-1)?.top.issue ?? issueRef(0) }, sw.subject === "orphanDesign");
        add("resolved", decision(spent, ob, { subject: sw.subject, key: sw.key, verdict: "resolved" }, [remediation]));
      }
      add("external", decision(w, ob, { subject: sw.subject, key: sw.key, verdict: "external" }));
      break;
    }
    case "decideEffectFailed": {
      const e = c.effects.find((x) => x.w.failedId === ob.id);
      if (e === undefined) break;
      const effect = e.w.id;
      const failedAt = w.host.failures.filter((f) => f.effect === effect).at(-1)?.at;
      if (failedAt !== undefined) for (const verdict of ["retry", "external"] as const) add(verdict, decision(w, ob, { subject: "effectFailed", effect, failedAt, verdict }));
      break;
    }
    case "decideStall": {
      // a stall ticket is keyed by the stall key; an effect-conflict ticket by its conflict key (its pin). `resolved`
      // must bring the missing fact: for a conflict, a new replacement based on the current body, which replaces the
      // conflicting one. A stall's facts are lifted by the environment after `external` (fairness edges).
      const conflicted = c.effects.find((e) => e.w.conflictId === ob.id);
      if (conflicted === undefined) {
        add("external", decision(w, ob, { subject: "stall", key: c.stall.key, verdict: "external" }));
        break;
      }
      const key = conflicted.w.conflictKey;
      const target = conflicted.w.target;
      if (target.kind === "applyBody") add("resolved(new replacement)", decision(w, ob, { subject: "stall", key, verdict: "resolved" }, [], [replaceBody(w, target.replacement.issue)]));
      add("external", decision(w, ob, { subject: "stall", key, verdict: "external" }));
      break;
    }
    case "report":
      add("summary", decision(w, ob, { subject: "report", summary: "s" }));
      break;
    case "spawn": {
      const seat = c.seats.find((s) => s.w.spawnId === ob.id);
      const pendingAck = seat?.w.pending ?? c.pendingAcks.find((p) => p.id === ob.id)?.agentId ?? null;
      const name = seat?.w.requestName ?? c.pendingAcks.find((p) => p.id === ob.id)?.requestName ?? null;
      if (name === null) break;
      if (pendingAck !== null) {
        const previous = seat?.w.holder ?? c.pendingAcks.find((p) => p.id === ob.id)?.previous ?? null;
        add("seated", decision(w, ob, { subject: "seated", requestName: name, previous, agentId: pendingAck }));
      } else {
        // spawn first (native task), receipt afterwards on the resulting pendingAck obligation
        const n = w.host.agents.filter((a) => stripSuffix(a.id) === name).length;
        const id = (n === 0 ? name : `${name}-${n + 1}`) as AgentId;
        out.push([`spawn: task ${seat?.w.role ?? "?"}`, { kind: "ok", world: { ...tick(w), host: { ...w.host, agents: [...w.host.agents, { id, requestName: name, status: "live", parkedSince: null }] } } }]);
      }
      break;
    }
    default:
      throw new Error(`model: no main edges for obligation kind ${ob.kind}`);
  }
  return out;
}

const wakeAgent = (w: World, id: AgentId): World => ({ ...w, host: { ...w.host, agents: w.host.agents.map((x) => (x.id === id ? { ...x, status: "live", parkedSince: null } : x)) } });

// ---------------------------------------------------------------- owner and gate replies

function seatEdges(w: World, c: Classified, ob: Obligation): [string, Stepped | null][] {
  if (ob.seat === null) {
    // designOnly: owner-class obligation held by Main
    return ownerEdges(w, c, ob, MAIN);
  }
  const seat = c.seats.find((s) => s.w.requestName === ob.seat?.requestName);
  if (seat === undefined || seat.state !== "live" || seat.w.holder === null) return [];
  const caller: Caller = { kind: "sub", agentId: seat.w.holder, sessionMatches: true };
  return ob.holder === "owner" ? ownerEdges(w, c, ob, caller) : gateEdges(w, c, ob, caller);
}

function claimEdge(w: World, ob: Obligation, caller: Caller, claim: Claim): Stepped | null {
  const spent = spend(w, "claim");
  return spent === null ? null : reply(spent, caller, { kind: "claim", obligation: ob.id, claim });
}

function ownerPush(w: World, member: Classified["member"]): World | null {
  if (member === null || member.w.pr === null) return null;
  const t = tick(w);
  const head = sha(`h${t.seq}`);
  const pushed = addCommit(t, head, [t.defaultHead, member.w.pr.head, ...member.w.designCommits]);
  return updatePr(pushed, member.w.pr.ref.number, (p) => ({ ...p, head, mergeable: "unknown", checks: { state: "pending", failedRunId: null } }));
}

function ownerEdges(w: World, c: Classified, ob: Obligation, caller: Caller): [string, Stepped | null][] {
  const m = c.member;
  if (m === null) return [];
  const member = m.w.entry.issue;
  const out: [string, Stepped | null][] = [];
  const submit = (label: string, newHead: boolean): void => {
    const pr = m.w.pr;
    if (!newHead && pr === null) return;
    let t = tick(w);
    const head = newHead ? sha(`h${t.seq}`) : (pr?.head ?? sha("none"));
    if (newHead) {
      // the owner merges every required design commit, then pushes (a native git action)
      t = addCommit(t, head, [t.defaultHead, pr?.head ?? null, ...m.w.designCommits]);
      if (pr !== null) t = updatePr(t, pr.ref.number, (p) => ({ ...p, head, mergeable: "unknown", checks: { state: "pending", failedRunId: null } }));
    }
    // the owner re-reads its injected ticket after the push: the push itself may re-pin the fix (headMoved)
    const after = derive(t.state, t.facts, t.host, policy);
    const ticket = after.obligations.find((o) => (o.kind === "deliver" || o.kind === "fix") && o.context === ob.context && o.holder === ob.holder);
    if (ticket === undefined) return;
    const required = after.classified.member?.w.designCommits ?? [];
    const contained = ancestors(t, head);
    // an owner never re-submits a head that lacks a required design commit (step would reject it)
    if (!newHead && required.some((d) => !contained.includes(d))) return;
    out.push([
      `${ob.kind}: prSubmit(${label})`,
      reply(t, caller, { kind: "prSubmit", obligation: ticket.id, branch: "feat", head, title: "t", body: `b${t.seq}`, template: "fourLayer", retryNote: null }, { branchHead: head, branchContains: required.filter((d) => contained.includes(d)) }),
    ]);
  };
  // The source push is its own successor; it must not disappear merely because the later reply loses its ticket.
  if (ob.kind === "fix" && caller.kind === "sub") {
    const pushed = ownerPush(w, m);
    if (pushed !== null) out.push([`${ob.kind}: owner push`, { kind: "world", world: pushed }]);
  } else {
    submit("new head", true);
  }
  submit("same head", false);
  out.push([`${ob.kind}: claim(question)`, claimEdge(w, ob, caller, { kind: "question", context: { kind: "member", member }, reproduction: "p", readings: ["a", "b"], earliestGap: "g", proposal: "x" })]);
  out.push([`${ob.kind}: claim(noCode)`, claimEdge(w, ob, caller, { kind: "noCode", member, evidence: "e" })]);
  out.push([`${ob.kind}: claim(split)`, claimEdge(w, ob, caller, { kind: "split", member, proposal: "p" })]);
  out.push([`${ob.kind}: claim(blocked)`, claimEdge(w, ob, caller, { kind: "blocked", member, category: "push rejected", attempts: "a" })]);
  return out;
}

function gateEdges(w: World, c: Classified, ob: Obligation, caller: Caller): [string, Stepped | null][] {
  const out: [string, Stepped | null][] = [];
  const question = (context: Extract<Claim, { kind: "question" }>["context"]): Claim => ({ kind: "question", context, reproduction: "p", readings: ["a", "b"], earliestGap: "g", proposal: "x" });
  const context: Extract<Claim, { kind: "question" }>["context"] | null =
    ob.kind === "review" || ob.kind === "accept"
      ? c.member === null
        ? null
        : { kind: "member", member: c.member.w.entry.issue }
      : ob.kind === "postMerge"
        ? c.verification === null
          ? null
          : { kind: "unitVerification", unit: c.verification.w.unit.top.issue }
        : ob.kind === "closure"
          ? { kind: "agendaClosure" }
          : null;
  if (context === null) throw new Error(`model: no gate edges for obligation kind ${ob.kind}`);
  out.push([`${ob.kind}: ok`, reply(w, caller, { kind: "verdict", obligation: ob.id, ok: true, note: "ok" })]);
  const failing = spend(w, "fail");
  out.push([`${ob.kind}: not ok`, failing === null ? null : reply(failing, caller, { kind: "verdict", obligation: ob.id, ok: false, note: "a.ts:1 breaks" })]);
  out.push([`${ob.kind}: claim(question)`, claimEdge(w, ob, caller, question(context))]);
  return out;
}

// ---------------------------------------------------------------- environment: perturbations and fairness

function environmentEdges(w: World, c: Classified): [string, World | null, boolean][] {
  const out: [string, World | null, boolean][] = [];
  const perturb = (label: string, f: (x: World) => World | null): void => {
    const spent = spend(w, "perturb");
    out.push([`perturb: ${label}`, spent === null ? null : f(spent), false]);
  };
  const ours = c.member?.w.pr ?? null;
  if (ours !== null) {
    const num = ours.ref.number;
    perturb("push new head", (x) => {
      const t = tick(x);
      const head = sha(`hp${t.seq}`);
      return updatePr(addCommit(t, head, [ours.head]), num, (p) => ({ ...p, head, mergeable: "unknown", checks: { state: "pending", failedRunId: null } }));
    });
    perturb("PR closed unmerged", (x) => {
      const t = tick(x);
      return updatePr(t, num, (p) => ({ ...p, state: { kind: "closedUnmerged", closedAt: ms(t.clock) } }));
    });
    const setChecks = (state: ChecksState) => (x: World): World => {
      const t = tick(x);
      return updatePr(t, num, (p) => ({ ...p, checks: { state, failedRunId: state === "fail" ? `run${t.seq}` : null } }));
    };
    const setMergeable = (m: Mergeable) => (x: World): World => updatePr(tick(x), num, (p) => ({ ...p, mergeable: m }));
    if (ours.checks.state === "pass") perturb("checks -> fail", setChecks("fail"));
    if (ours.checks.state === "fail") perturb("checks -> pass", setChecks("pass"));
    if (ours.mergeable === "yes") perturb("mergeable -> no", setMergeable("no"));
    if (ours.mergeable === "no") perturb("mergeable -> yes", setMergeable("yes"));
    // fairness: unknown and pending eventually settle (either way; a failing settlement costs fail budget)
    if (ours.checks.state === "pending" || ours.checks.state === "unknown") {
      out.push(["settle: checks -> pass", setChecks("pass")(w), true]);
      const f = spend(w, "fail");
      out.push(["settle: checks -> fail", f === null ? null : setChecks("fail")(f), false]);
    }
    if (ours.mergeable === "unknown") {
      out.push(["settle: mergeable -> yes", setMergeable("yes")(w), true]);
      const f = spend(w, "fail");
      out.push(["settle: mergeable -> no", f === null ? null : setMergeable("no")(f), false]);
    }
  }
  const active = c.member?.w.entry.issue ?? null;
  if (active !== null) {
    perturb("member body edited", (x) => updateIssue(tick(x), active, (i) => ({ ...i, bodyHash: hash(`edited-${x.seq}`) })));
  }
  for (const r of c.reconcile) {
    const i = w.facts.issues.find((x) => sameRef(x.ref, r.w.member));
    if (i === undefined) continue;
    perturb(`human ${i.open ? "close" : "reopen"} member`, (x) => lifecycle(x, r.w.member, i.open ? "closed" : "reopened"));
  }
  for (const a of w.host.agents) {
    if (a.status !== "live") continue;
    for (const status of ["parked", "aborted"] as const) {
      perturb(`seat ${status}`, (x) => {
        const t = tick(x);
        return { ...t, host: { ...t.host, agents: t.host.agents.map((y) => (y.id === a.id ? { ...y, status, parkedSince: status === "parked" ? ms(t.clock) : null } : y)) } };
      });
    }
  }
  // Fairness: external subject decisions are lifted by the authoritative fact that resolves each subject.
  for (const subject of c.subjects) {
    if (subject.s.decided !== "external") continue;
    switch (subject.w.subject) {
      case "orphanDesign":
        out.push(["lift external orphan design", landDefault(w, subject.w.commit), true]);
        break;
      case "migration":
        out.push(["lift external migration", lifecycle(w, subject.w.migration, "reopened"), true]);
        break;
      case "agendaGap":
        out.push(["lift external agenda gap", mergeExternal(w, subject.w.child), true]);
        break;
      default:
        assertNever(subject.w);
    }
  }

  // Fairness: an external applyBody conflict is lifted when the source body returns to either pinned hash.
  for (const effect of c.effects) {
    if (effect.s.conflict !== "external" || effect.w.target.kind !== "applyBody") continue;
    const replacement = effect.w.target.replacement;
    out.push([
      "lift external body conflict: base",
      updateIssue(tick(w), replacement.issue, (i) => ({ ...i, bodyHash: replacement.baseHash })),
      true,
    ]);
    out.push([
      "lift external body conflict: target",
      updateIssue(tick(w), replacement.issue, (i) => ({ ...i, bodyHash: replacement.targetHash })),
      true,
    ]);
  }

  // fairness: an `external` checks decision is eventually lifted by a new check run
  if (ours !== null && c.member?.s.checksDecided === "external") {
    out.push(["lift external checks: new run", updatePr(tick(w), ours.ref.number, (p) => ({ ...p, checks: { state: "pending", failedRunId: null } })), true]);
  }
  // fairness: an external stall on an enumerated stall is eventually lifted by the fact change it names
  const stalled = c.member === null ? undefined : MEMBER_STALLS.find((x) => c.member !== null && x.holds(c.member.s));
  if (c.stall.decided === "external" && stalled !== undefined && ours !== null) {
    switch (stalled.lift) {
      case "pushNewHead": {
        const t = tick(w);
        const head = sha(`hl${t.seq}`);
        out.push([`lift stall «${stalled.name}»: new head pushed`, updatePr(addCommit(t, head, [ours.head]), ours.ref.number, (p) => ({ ...p, head, mergeable: "unknown", checks: { state: "pending", failedRunId: null } })), true]);
        break;
      }
      default:
        assertNever(stalled.lift);
    }
  }
  if (w.host.failures.length > 0) out.push(["restart (execution failures forgotten)", { ...tick(w), host: { ...w.host, failures: [] } }, true]);
  return out;
}

/** Default branch advances by a commit the state does not reference: the classified situation must not change (core.md §6.4). */
export function advanceDefault(w: World): World {
  const t = tick(w);
  const s = sha(`unref${t.seq}`);
  return { ...withFacts(t, { commits: { ...t.facts.commits, onDefault: [...t.facts.commits.onDefault, { repo, sha: s }] } }), defaultHead: s };
}

// ------------------------------------------------------------------ abstraction key

/**
 * α: the classified situations, plus where the current unit sits in the agenda. Concrete ids never enter the key.
 * The unit position is explorer state, not a Situation dimension: without it the last unit of an agenda and an
 * earlier unit with identical situations merge, and the path to `done` through the remaining units is lost.
 */
export function situationKey(c: Classified): string {
  const sorted = (xs: readonly string[]): string[] => [...xs].sort();
  return canonical({
    units: c.units.length,
    current: c.currentUnit === null ? -1 : c.units.indexOf(c.currentUnit),
    phase: c.currentUnit === null ? "none" : c.member !== null ? "member" : c.verification !== null ? "verification" : "blocked",
    member: c.member?.s ?? null,
    reconcile: sorted(c.reconcile.map((r) => canonical(r.s))),
    verification: c.verification?.s ?? null,
    closure: c.closure.s,
    subjects: sorted(c.subjects.map((s) => canonical({ subject: s.w.subject, s: s.s }))),
    effects: sorted(c.effects.filter((e) => !e.s.fulfilled).map((e) => canonical({ kind: e.w.target.kind, s: e.s }))),
    seats: sorted(c.seats.map((s) => `${s.w.role}:${s.state}`)),
    pendingAcks: c.pendingAcks.length,
    stall: c.stall.decided,
  });
}

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
