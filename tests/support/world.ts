// Concrete worlds for the abstraction layer and the model checker (core.md §6.2, §6.3).
// A World is one Snapshot plus the host observation plus the explorer's own counters and budgets.
// `successors` enumerates every edge kind the model checker explores; every reply goes through `admit`.

import { admit, canonical, derive, fnv64, stripSuffix } from "../../src/core/index.ts";
import type {
  AgentId,
  Caller,
  Claim,
  Decision,
  Derived,
  Draft,
  EventId,
  Finding,
  FindingVerdict,
  Hash,
  Host,
  IssueFact,
  IssueRef,
  Millis,
  NewRecord,
  Obligation,
  ObligationId,
  Policy,
  PrFact,
  RecordId,
  Reply,
  RepoRef,
  Sha,
  Snapshot,
  StoredRecord,
  Author,
  BodyReplacement,
  Verdict,
  Observed,
  ChecksState,
  Mergeable,
} from "../../src/core/index.ts";
import type { Classified } from "../../src/core/classify.ts";
import { MEMBER_STALLS } from "./stalls.ts";

export const repo: RepoRef = { owner: "lab", name: "sandbox" };
export const policy: Policy = { appendSystem: "APPEND", systemBlocks: "BLOCKS" };
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
  readonly snap: Snapshot;
  readonly host: Host;
  readonly clock: number;
  readonly seq: number;
  readonly budget: Budget;
}

export interface Edge {
  /** Abstract label: kind of edge and variant, never concrete ids. */
  readonly label: string;
  readonly world: World;
  /** Edges that only settle `unknown`/`pending` or restart the process (fairness, core.md §6.3). */
  readonly fairness: boolean;
}

// ------------------------------------------------------------------ builders

export function issue(n: number, over: Partial<IssueFact> = {}): IssueFact {
  return {
    ref: issueRef(n),
    open: true,
    events: [],
    bodyHash: hash(`body-${n}`),
    appliedDecisions: [],
    acceptanceRows: [`${repo.owner}/${repo.name}#${n}/r1`],
    children: [],
    draftMarker: null,
    isAgendaRecord: false,
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

export function initialWorld(spec: AgendaSpec): World {
  const agenda = issue(1, { isAgendaRecord: true, acceptanceRows: [] });
  const members = spec.members.map((n) => issue(n));
  const outside = spec.outsideChild ? [issue(90)] : [];
  const parent =
    spec.parent === null ? [] : [issue(spec.parent, { children: [...spec.members.map(issueRef), ...outside.map((i) => i.ref)], acceptanceRows: [`${repo.owner}/${repo.name}#${spec.parent}/c1`] }), ...outside];
  return {
    snap: {
      agenda: {
        record: issueRef(1),
        createdAt: ms(1000),
        parent: spec.parent === null ? null : issueRef(spec.parent),
        convened: spec.members.map((n) => ({ issue: issueRef(n), target: { repo, base: "main" }, designOnly: false, adoptPr: null })),
      },
      issues: [agenda, ...members, ...parent],
      prs: [],
      commits: { onDefault: [{ repo, sha: sha("base0") }], contains: [], defaultHead: [{ repo, sha: sha("base0") }] },
      records: [],
      effectMarkers: [],
    },
    host: { agents: [], failures: [] },
    clock: 2000,
    seq: 0,
    budget: spec.budget,
  };
}

// ------------------------------------------------------------------ small immutable updates

const tick = (w: World): World => ({ ...w, clock: w.clock + 10, seq: w.seq + 1 });
const withSnap = (w: World, snap: Partial<Snapshot>): World => ({ ...w, snap: { ...w.snap, ...snap } });
const spend = (w: World, k: keyof Budget): World | null => (w.budget[k] <= 0 ? null : { ...w, budget: { ...w.budget, [k]: w.budget[k] - 1 } });

const sameRef = (a: IssueRef, b: IssueRef): boolean => a.number === b.number && a.repo.owner === b.repo.owner && a.repo.name === b.repo.name;

function updateIssue(w: World, ref: IssueRef, f: (i: IssueFact) => IssueFact): World {
  return withSnap(w, { issues: w.snap.issues.map((i) => (sameRef(i.ref, ref) ? f(i) : i)) });
}

function updatePr(w: World, number: number, f: (p: PrFact) => PrFact): World {
  return withSnap(w, { prs: w.snap.prs.map((p) => (p.ref.number === number ? f(p) : p)) });
}

function lifecycle(w: World, ref: IssueRef, kind: "closed" | "reopened"): World {
  const t = tick(w);
  return updateIssue(t, ref, (i) => ({
    ...i,
    open: kind === "reopened",
    events: [...i.events, { id: `ev-${t.seq}` as EventId, kind, at: ms(t.clock) }],
  }));
}

function append(w: World, rec: NewRecord, author: Author): World {
  const t = tick(w);
  const stored: StoredRecord = { id: `rec-${t.seq}` as RecordId, at: ms(t.clock), author, ...rec };
  return withSnap(t, { records: [...t.snap.records, stored] });
}

/** A new commit on top of `parents`: records every (ancestor, commit) pair, as the store reports containment transitively. */
function addCommit(w: World, commit: Sha, parents: readonly (Sha | null)[]): World {
  const all = new Set<Sha>();
  for (const p of parents) if (p !== null) for (const a of ancestors(w, p)) all.add(a);
  let out = w;
  for (const a of all) out = addContains(out, a, commit);
  return out;
}

const defaultHeadOf = (w: World): Sha | null => w.snap.commits.defaultHead[0]?.sha ?? null;

function addContains(w: World, ancestor: Sha, descendant: Sha): World {
  return withSnap(w, { commits: { ...w.snap.commits, contains: [...w.snap.commits.contains, { repo, ancestor, descendant }] } });
}

/** Every commit `head` contains by the recorded facts (the core only reads direct pairs; we close transitively). */
function ancestors(w: World, head: Sha): Sha[] {
  const out = new Set<Sha>([head]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of w.snap.commits.contains) if (out.has(c.descendant) && !out.has(c.ancestor)) {
      out.add(c.ancestor);
      grew = true;
    }
  }
  return [...out];
}

// ------------------------------------------------------------------ replies through admit

export interface Rejection {
  readonly label: string;
  readonly reason: string;
  readonly obligation: string;
}

type Admitted = { readonly kind: "ok"; readonly world: World } | { readonly kind: "rejected"; readonly reason: string };

function reply(w: World, caller: Caller, r: Reply, facts: { branchHead: Sha | null; branchContains: readonly Sha[] } = { branchHead: null, branchContains: [] }): Admitted {
  const a = admit(w.snap, w.host, policy, caller, r, facts);
  if (a.kind === "rejected") return { kind: "rejected", reason: a.reason };
  if (a.kind === "replayed") return { kind: "rejected", reason: `replayed ${a.existing}` };
  const author: Author = caller.kind === "main" ? { kind: "main" } : { kind: "seat", agentId: caller.agentId, requestName: stripSuffix(caller.agentId) };
  return { kind: "ok", world: append(w, a.record, author) };
}

// ------------------------------------------------------------------ successors

export interface Expansion {
  readonly derived: Derived;
  readonly edges: readonly Edge[];
  readonly rejections: readonly Rejection[];
}

export function expand(w: World): Expansion {
  const d = derive(w.snap, w.host, policy);
  const edges: Edge[] = [];
  const rejections: Rejection[] = [];
  const push = (label: string, next: World | null, fairness = false): void => {
    if (next !== null) edges.push({ label, world: next, fairness });
  };
  const via = (label: string, ob: Obligation, a: Admitted | null): void => {
    if (a === null) return;
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
      out.push([`effect ${a.target.kind}`, applyEffect(w, a.target)]);
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
      next = addCommit(next, mergeSha, [a.head, defaultHeadOf(next)]);
      const onDefault = ancestors(next, mergeSha).map((s) => ({ repo, sha: s }));
      next = withSnap(next, { commits: { ...next.snap.commits, onDefault: [...next.snap.commits.onDefault, ...onDefault], defaultHead: [{ repo, sha: mergeSha }] } });
      const closes = next.snap.prs.find((p) => p.ref.number === a.pr.number)?.closes ?? [];
      let auto = next;
      for (const ref of closes) if (auto.snap.issues.find((i) => sameRef(i.ref, ref))?.open === true) auto = lifecycle(auto, ref, "closed");
      out.push(["merge (issue auto-closed)", auto]);
      out.push(["merge (no auto-close)", next]);
      break;
    }
    case "noticeForeignPr":
      out.push(["noticeForeignPr", withSnap(tick(w), { effectMarkers: [...w.snap.effectMarkers, ob.id] })]);
      break;
    case "close":
    case "reopen":
      out.push([`program ${a.kind}`, lifecycle(w, a.issue, a.kind === "close" ? "closed" : "reopened")]);
      break;
    case "closeParent":
    case "reopenParent":
      out.push([`program ${a.kind}`, lifecycle(w, a.issue, a.kind === "closeParent" ? "closed" : "reopened")]);
      break;
    default:
      assertNever(a);
  }
  return out;
}

function applyEffect(w: World, target: Extract<Obligation["action"], { kind: "effect" }>["target"]): World {
  const t = tick(w);
  switch (target.kind) {
    case "closeAgenda":
      return updateIssue(t, w.snap.agenda.record, (i) => ({ ...i, open: false }));
    case "attachAgenda":
      return updateIssue(t, target.parent, (i) => ({ ...i, children: [...i.children, w.snap.agenda.record] }));
    case "openPr": {
      const body = target.submit.body;
      if (body.kind !== "prSubmit") throw new Error("openPr without prSubmit");
      const number = 100 + t.seq;
      const pr: PrFact = {
        ref: { repo, number },
        state: { kind: "open" },
        head: body.head,
        target: { repo, base: "main" },
        bodyHash: fnv64(`pr-body|${target.submit.id}`),
        appliedSubmit: target.submit.id,
        mergeable: "unknown",
        checks: { state: "pending", failedRunId: null, latestRunCreatedAt: ms(t.clock) },
        closes: [body.member],
        agendaMarker: true,
      };
      return withSnap(t, { prs: [...t.snap.prs, pr] });
    }
    case "updatePr": {
      const body = target.submit.body;
      if (body.kind !== "prSubmit" || target.pr === null) throw new Error("updatePr without PR");
      return updatePr(t, target.pr.number, (p) => ({ ...p, bodyHash: fnv64(`pr-body|${target.submit.id}`), appliedSubmit: target.submit.id }));
    }
    case "applyBody":
      return updateIssue(t, target.replacement.issue, (i) => ({
        ...i,
        bodyHash: fnv64(`body|${target.decision}|${target.replacement.body}`),
        appliedDecisions: [...i.appliedDecisions, target.decision],
      }));
    case "createIssue": {
      const number = 200 + t.seq;
      return withSnap(t, { issues: [...t.snap.issues, issue(number, { draftMarker: target.draftId })] });
    }
    case "noticeDecision":
      return withSnap(t, { effectMarkers: [...t.snap.effectMarkers, obligationIdOfNotice(w, target.decision, target.issue)] });
    case "rerunChecks":
      return updatePr(t, target.pr.number, (p) => ({ ...p, checks: { state: "pending", failedRunId: null, latestRunCreatedAt: ms(t.clock) } }));
    default:
      return assertNever(target);
  }
}

/** The noticeDecision effect's id is its marker; recover it from the derived obligation list. */
function obligationIdOfNotice(w: World, decision: RecordId, target: IssueRef): ObligationId {
  const d = derive(w.snap, w.host, policy);
  const e = d.classified.effects.find((x) => x.w.target.kind === "noticeDecision" && x.w.target.decision === decision && sameRef(x.w.target.issue, target));
  if (e === undefined) throw new Error("noticeDecision effect not found");
  return e.w.id;
}

// ---------------------------------------------------------------- main session replies

const MAIN: Caller = { kind: "main" };

function decision(w: World, ob: Obligation, dec: Decision, drafts: readonly Draft[] = [], bodyReplacements: readonly BodyReplacement[] = []): Admitted {
  return reply(w, MAIN, { kind: "decision", obligation: ob.id, decision: dec, rationale: "r", drafts, bodyReplacements });
}

function draft(anchor: Draft["anchor"]): Draft {
  return { index: 0, repo, title: "t", body: "b", anchor, target: { repo, base: "main" }, designOnly: false };
}

function replaceBody(w: World, ref: IssueRef): BodyReplacement {
  const i = w.snap.issues.find((x) => sameRef(x.ref, ref));
  return { issue: ref, baseHash: i?.bodyHash ?? hash(""), body: `replaced-${w.seq}` };
}

function mainEdges(w: World, c: Classified, ob: Obligation): [string, Admitted | null][] {
  const out: [string, Admitted | null][] = [];
  const add = (label: string, a: Admitted | null): void => {
    out.push([`${ob.kind}: ${label}`, a]);
  };
  const m = c.member;
  switch (ob.kind) {
    case "decideClaim": {
      const claimRec = ob.context === "closure" ? c.closure.w.claim : ob.context.startsWith("verify:") ? (c.verification?.w.claim ?? null) : (m?.w.claim ?? null);
      if (claimRec === null || claimRec.body.kind !== "claim") break;
      const cl = claimRec.body.claim;
      const member = m?.w.entry.issue ?? null;
      switch (cl.kind) {
        case "question": {
          const q = (verdict: Extract<Decision, { subject: "question" }>["verdict"]): Decision => ({ subject: "question", claim: claimRec.id, verdict, affected: member === null ? [] : [member] });
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
          const base = { subject, claim: claimRec.id, member: cl.member, bodyHash: hash("") } as const;
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
          for (const verdict of ["replacePr", "external", "refuted"] as const) add(verdict, decision(w, ob, { subject: "blockedClaim", claim: claimRec.id, verdict, abandon: null }));
          break;
        default:
          assertNever(cl);
      }
      break;
    }
    case "decideFindings": {
      const v = m?.w.unadjudicated ?? null;
      if (v === null || v.body.kind !== "verdict" || m === null) break;
      const findings: readonly Finding[] = v.body.verdict.gate === "review" || v.body.verdict.gate === "accept" ? v.body.verdict.findings : [];
      const member = m.w.entry.issue;
      const each = (fv: FindingVerdict): Decision => ({ subject: "findings", verdictRecord: v.id, perFinding: findings.map((f) => ({ findingId: f.id, verdict: fv })) });
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
      if (v !== null) add("commit", decision(w, ob, { subject: "designFix", verdictRecord: v.id, commit: sha(`df${w.seq}`) }));
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
        const bodyHash = r.w.bodyHash ?? hash("");
        add("confirmedNoCode", decision(w, ob, { subject: "closed", member: r.w.member, event, bodyHash, verdict: "confirmedNoCode" }));
        add("reopen", decision(w, ob, { subject: "closed", member: r.w.member, event, bodyHash, verdict: "reopen" }));
      }
      break;
    }
    case "decidePostMergeFail":
    case "decideClosureFail": {
      const verdictRecord = ob.kind === "decidePostMergeFail" ? c.verification?.w.failing : c.closure.w.failing;
      if (verdictRecord === null || verdictRecord === undefined) break;
      const subject = ob.kind === "decidePostMergeFail" ? "postMergeFail" : "closureFail";
      add("reverify", decision(w, ob, { subject, verdictRecord: verdictRecord.id, verdict: "reverify" }));
      const spent = spend(w, "draft");
      if (spent !== null) {
        const anchor: Draft["anchor"] =
          ob.kind === "decidePostMergeFail" && c.verification !== null
            ? { kind: "correctionOf", entry: c.verification.w.unit.top.issue }
            : { kind: "after", entry: c.units.at(-1)?.top.issue ?? issueRef(0) };
        add("correction", decision(spent, ob, { subject, verdictRecord: verdictRecord.id, verdict: "correction" }, [draft(anchor)]));
      }
      break;
    }
    case "decide:unrelated":
    case "decide:orphanDesign":
    case "decide:migration":
    case "decide:agendaGap": {
      const sub = c.subjects.find((s) => s.w.id === ob.id);
      if (sub === undefined) break;
      const sw = sub.w;
      if (sw.subject === "unrelated") add("unrelated", decision(w, ob, { subject: "unrelated", verdictRecord: sw.verdict.id }, [draft({ kind: "outsideAgenda" })]));
      else for (const verdict of ["resolved", "external"] as const) add(verdict, decision(w, ob, { subject: sw.subject, key: sw.key, verdict }));
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
      // a stall ticket is keyed by the stall key; an effect-conflict ticket by its conflict key (its pin)
      const conflicted = c.effects.find((e) => e.w.conflictId === ob.id);
      const key = conflicted === undefined ? c.stall.key : conflicted.w.conflictKey;
      for (const verdict of ["resolved", "external"] as const) add(verdict, decision(w, ob, { subject: "stall", key, verdict }));
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
        add("seated", decision(w, ob, { subject: "seated", requestName: name, previous: seat?.w.holder ?? null, agentId: pendingAck }));
      } else {
        // spawn first (native task), receipt afterwards on the resulting pendingAck obligation
        const n = w.host.agents.filter((a) => stripSuffix(a.id) === name).length;
        const id = (n === 0 ? name : `${name}-${n + 1}`) as AgentId;
        out.push([`spawn: task ${seat?.w.role ?? "?"}`, { kind: "ok", world: { ...tick(w), host: { ...w.host, agents: [...w.host.agents, { id, requestName: name, status: "live" }] } } }]);
      }
      break;
    }
    case "wake": {
      const seat = c.seats.find((s) => s.w.wakeId === ob.id);
      if (seat === undefined || seat.w.holder === null) break;
      const holder = seat.w.holder;
      const a = decision(w, ob, { subject: "woken", agentId: holder, count: seat.w.wokenCount });
      add("woken", a.kind === "ok" ? { kind: "ok", world: { ...a.world, host: { ...a.world.host, agents: a.world.host.agents.map((x) => (x.id === holder ? { ...x, status: "live" } : x)) } } } : a);
      break;
    }
    default:
      throw new Error(`model: no main edges for obligation kind ${ob.kind}`);
  }
  return out;
}

// ---------------------------------------------------------------- owner and gate replies

function seatEdges(w: World, c: Classified, ob: Obligation): [string, Admitted | null][] {
  if (ob.seat === null) {
    // designOnly: owner-class obligation held by Main
    return ownerEdges(w, c, ob, MAIN);
  }
  const seat = c.seats.find((s) => s.w.requestName === ob.seat?.requestName);
  if (seat === undefined || seat.state !== "live" || seat.w.holder === null) return [];
  const caller: Caller = { kind: "sub", agentId: seat.w.holder, sessionMatches: true };
  return ob.holder === "owner" ? ownerEdges(w, c, ob, caller) : gateEdges(w, c, ob, caller);
}

function claimEdge(w: World, ob: Obligation, caller: Caller, claim: Claim): Admitted | null {
  const spent = spend(w, "claim");
  return spent === null ? null : reply(spent, caller, { kind: "claim", obligation: ob.id, claim });
}

function ownerEdges(w: World, c: Classified, ob: Obligation, caller: Caller): [string, Admitted | null][] {
  const m = c.member;
  if (m === null) return [];
  const member = m.w.entry.issue;
  const out: [string, Admitted | null][] = [];
  const submit = (label: string, newHead: boolean): void => {
    const pr = m.w.pr;
    if (!newHead && pr === null) return;
    let t = tick(w);
    const head = newHead ? sha(`h${t.seq}`) : (pr?.head ?? sha("none"));
    if (newHead) {
      // the owner merges every required design commit, then pushes (a native git action)
      t = addCommit(t, head, [defaultHeadOf(t), pr?.head ?? null, ...m.w.designCommits]);
      if (pr !== null) t = updatePr(t, pr.ref.number, (p) => ({ ...p, head, mergeable: "unknown", checks: { state: "pending", failedRunId: null, latestRunCreatedAt: ms(t.clock) } }));
    }
    // the owner re-reads its injected ticket after the push: the push itself may re-pin the fix (headMoved)
    const after = derive(t.snap, t.host, policy);
    const ticket = after.obligations.find((o) => (o.kind === "deliver" || o.kind === "fix") && o.context === ob.context && o.holder === ob.holder);
    if (ticket === undefined) return;
    const required = after.classified.member?.w.designCommits ?? [];
    const contained = ancestors(t, head);
    // an owner never re-submits a head that lacks a required design commit (admit would reject it)
    if (!newHead && required.some((d) => !contained.includes(d))) return;
    out.push([
      `${ob.kind}: prSubmit(${label})`,
      reply(t, caller, { kind: "prSubmit", obligation: ticket.id, branch: "feat", head, title: "t", body: "b", template: "fourLayer", retryNote: null }, { branchHead: head, branchContains: required.filter((d) => contained.includes(d)) }),
    ]);
  };
  submit("new head", true);
  submit("same head", false);
  out.push([`${ob.kind}: claim(question)`, claimEdge(w, ob, caller, { kind: "question", context: { kind: "member", member }, reproduction: "p", readings: ["a", "b"], earliestGap: "g", proposal: "x" })]);
  out.push([`${ob.kind}: claim(noCode)`, claimEdge(w, ob, caller, { kind: "noCode", member, evidence: "e" })]);
  out.push([`${ob.kind}: claim(split)`, claimEdge(w, ob, caller, { kind: "split", member, proposal: "p" })]);
  out.push([`${ob.kind}: claim(blocked)`, claimEdge(w, ob, caller, { kind: "blocked", member, category: "push rejected", attempts: "a" })]);
  return out;
}

function gateEdges(w: World, c: Classified, ob: Obligation, caller: Caller): [string, Admitted | null][] {
  const out: [string, Admitted | null][] = [];
  const verdict = (label: string, v: Verdict, failing: boolean): void => {
    const base = failing ? spend(w, "fail") : w;
    out.push([`${ob.kind}: ${label}`, base === null ? null : reply(base, caller, { kind: "verdict", obligation: ob.id, verdict: v })]);
  };
  const finding: Finding = { id: "f1", location: "a.ts:1", consequence: "c", reproduction: "r", responsible: "owner" };
  const rows = (ids: readonly string[], pass: boolean) => ids.map((rowId) => ({ rowId, command: "c", output: "o", pass }));
  const question = (context: Extract<Claim, { kind: "question" }>["context"]): Claim => ({ kind: "question", context, reproduction: "p", readings: ["a", "b"], earliestGap: "g", proposal: "x" });
  switch (ob.kind) {
    case "review":
    case "accept": {
      const m = c.member;
      if (m === null || m.w.pr === null) break;
      const head = m.w.pr.head;
      const rowIds = m.w.issue?.acceptanceRows ?? [];
      if (ob.kind === "review") {
        verdict("pass", { gate: "review", observedHead: head, gates: ["pass", "pass", "pass", "pass", "pass"], findings: [] }, false);
        verdict("fail", { gate: "review", observedHead: head, gates: ["pass", "fail", "notRun", "notRun", "notRun"], findings: [finding] }, true);
      } else {
        verdict("pass", { gate: "accept", observedHead: head, rows: rows(rowIds, true), findings: [], unrelated: [] }, false);
        verdict("pass+unrelated", { gate: "accept", observedHead: head, rows: rows(rowIds, true), findings: [], unrelated: [{ description: "u", reproduction: "r" }] }, true);
        verdict("fail", { gate: "accept", observedHead: head, rows: rows(rowIds, false), findings: [finding], unrelated: [] }, true);
      }
      out.push([`${ob.kind}: claim(question)`, claimEdge(w, ob, caller, question({ kind: "member", member: m.w.entry.issue }))]);
      break;
    }
    case "postMerge": {
      const v = c.verification;
      if (v === null || v.w.manifest.gate !== "postMerge") break;
      // one observed commit per delivery repo: the latest merge (core.md §3 有效性, R5); merges are in unit order
      const mergedAt = (commit: Sha): number => {
        const st = w.snap.prs.find((p) => p.state.kind === "merged" && p.state.mergeSha === commit)?.state;
        return st !== undefined && st.kind === "merged" ? st.mergedAt : -1;
      };
      const latest = new Map<string, Observed>();
      for (const mm of v.w.manifest.merges) {
        const k = `${mm.repo.owner}/${mm.repo.name}`;
        const cur = latest.get(k);
        if (cur === undefined || mergedAt(mm.commit) > mergedAt(cur.commit)) latest.set(k, mm);
      }
      const observed = [...latest.values()];
      const rowIds = v.w.unit.members.flatMap((mm) => w.snap.issues.find((i) => sameRef(i.ref, mm.issue))?.acceptanceRows ?? []);
      verdict("pass", { gate: "postMerge", observed, rows: rows(rowIds, true), unrelated: [] }, false);
      verdict("fail", { gate: "postMerge", observed, rows: rows(rowIds, false), unrelated: [] }, true);
      out.push([`${ob.kind}: claim(question)`, claimEdge(w, ob, caller, question({ kind: "unitVerification", unit: v.w.unit.top.issue }))]);
      break;
    }
    case "closure": {
      const cm = c.closure.w.manifest;
      if (cm === null || cm.gate !== "closure" || c.closure.w.parent === null) break;
      const parentRef = c.closure.w.parent;
      const rowIds = w.snap.issues.find((i) => sameRef(i.ref, parentRef))?.acceptanceRows ?? [];
      verdict("pass", { gate: "closure", observed: cm.merges, rows: rows(rowIds, true) }, false);
      verdict("fail", { gate: "closure", observed: cm.merges, rows: rows(rowIds, false) }, true);
      out.push([`${ob.kind}: claim(question)`, claimEdge(w, ob, caller, question({ kind: "agendaClosure" }))]);
      break;
    }
    default:
      throw new Error(`model: no gate edges for obligation kind ${ob.kind}`);
  }
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
      return updatePr(addCommit(t, head, [ours.head]), num, (p) => ({ ...p, head, mergeable: "unknown", checks: { state: "pending", failedRunId: null, latestRunCreatedAt: ms(t.clock) } }));
    });
    perturb("PR closed unmerged", (x) => {
      const t = tick(x);
      return updatePr(t, num, (p) => ({ ...p, state: { kind: "closedUnmerged", closedAt: ms(t.clock) } }));
    });
    const setChecks = (state: ChecksState) => (x: World): World => {
      const t = tick(x);
      return updatePr(t, num, (p) => ({ ...p, checks: { state, failedRunId: state === "fail" ? `run${t.seq}` : null, latestRunCreatedAt: ms(t.clock) } }));
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
    const i = w.snap.issues.find((x) => sameRef(x.ref, r.w.member));
    if (i === undefined) continue;
    perturb(`human ${i.open ? "close" : "reopen"} member`, (x) => lifecycle(x, r.w.member, i.open ? "closed" : "reopened"));
  }
  for (const a of w.host.agents) {
    if (a.status !== "live") continue;
    for (const status of ["parked", "aborted"] as const) {
      perturb(`seat ${status}`, (x) => ({ ...tick(x), host: { ...x.host, agents: x.host.agents.map((y) => (y.id === a.id ? { ...y, status } : y)) } }));
    }
  }
  // fairness: an `external` checks decision is eventually lifted by a new check run
  if (ours !== null && c.member?.s.checksDecided === "external") {
    const t = tick(w);
    out.push(["lift external checks: new run", updatePr(t, ours.ref.number, (p) => ({ ...p, checks: { state: "pending", failedRunId: null, latestRunCreatedAt: ms(t.clock) } })), true]);
  }
  // fairness: an external stall on an enumerated stall is eventually lifted by the fact change it names
  const stalled = c.member === null ? undefined : MEMBER_STALLS.find((x) => c.member !== null && x.holds(c.member.s));
  if (c.stall.external && stalled !== undefined && ours !== null) {
    switch (stalled.lift) {
      case "pushNewHead": {
        const t = tick(w);
        const head = sha(`hl${t.seq}`);
        out.push([`lift stall «${stalled.name}»: new head pushed`, updatePr(addCommit(t, head, [ours.head]), ours.ref.number, (p) => ({ ...p, head, mergeable: "unknown", checks: { state: "pending", failedRunId: null, latestRunCreatedAt: ms(t.clock) } })), true]);
        break;
      }
      default:
        assertNever(stalled.lift);
    }
  }
  if (w.host.failures.length > 0) out.push(["restart (execution failures forgotten)", { ...tick(w), host: { ...w.host, failures: [] } }, true]);
  return out;
}

/** Default branch advances by a commit no record references: the classified situation must not change (core.md §6.3). */
export function advanceDefault(w: World): World {
  const t = tick(w);
  const s = sha(`unref${t.seq}`);
  return withSnap(t, { commits: { ...t.snap.commits, onDefault: [...t.snap.commits.onDefault, { repo, sha: s }], defaultHead: [{ repo, sha: s }] } });
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
    stallExternal: c.stall.external,
  });
}

export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
