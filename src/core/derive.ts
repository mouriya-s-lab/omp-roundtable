// derive = classify → rules → realize (core.md §4). realize only reads witnesses; it never re-decides.

import { briefFor, type BriefInput } from "./briefs.ts";
import { classify, rowOwners, type Classified, type EffectTarget } from "./classify.ts";
import { issueKey, sameIssue, workDir, type SeatRole } from "./identity.ts";
import {
  closureDone,
  closureRules,
  effectRules,
  effectWaiting,
  memberRules,
  memberWaiting,
  reconcileRules,
  seatRules,
  subjectRules,
  verificationRules,
  type Holder,
} from "./rules.ts";
import type { AgendaState, AgentId, Facts, Hash, Host, IssueRef, ObligationId, PendingClaim, Policy, PrRef, Sha } from "./types.ts";

export type ReplyKind = "prSubmit" | "claim" | "verdict" | "decision";

/** Program actions the store executes against GitHub. */
export type StoreAction =
  | { readonly kind: "effect"; readonly target: EffectTarget }
  | { readonly kind: "merge"; readonly pr: PrRef; readonly head: Sha }
  | { readonly kind: "close" | "reopen"; readonly issue: IssueRef }
  | { readonly kind: "closeParent" | "reopenParent"; readonly issue: IssueRef };

/** Every program action: the GitHub ones, and waking a parked seat, which the adapter executes against the host. */
export type ProgramAction = StoreAction | { readonly kind: "wake"; readonly agent: AgentId; readonly requestName: string };

export interface SeatBinding {
  readonly role: SeatRole;
  readonly requestName: string;
  readonly workDir: string;
  readonly agent: string;
}

export interface Obligation {
  readonly id: ObligationId;
  readonly kind: string;
  readonly holder: Holder;
  readonly context: string;
  /** Seat that must hold this obligation (owner/gate holders only). */
  readonly seat: SeatBinding | null;
  /** Program action (program holders only). */
  readonly action: ProgramAction | null;
  /** Reply kinds that complete (or, for claims, are admitted interim for) this obligation. */
  readonly accepts: readonly ReplyKind[];
  /** The holder may yield while this obligation stands (its own claim is pending). */
  readonly yieldAllowed: boolean;
  readonly brief: string;
}

export interface Derived {
  readonly classified: Classified;
  readonly obligations: readonly Obligation[];
  readonly waiting: boolean;
  readonly done: boolean;
}

export function derive(state: AgendaState, facts: Facts, host: Host, policy: Policy): Derived {
  const c = classify(state, facts, host);
  const out: Obligation[] = [];
  const needed = new Set<string>();
  const ownersOf = (claim: PendingClaim): { issue: IssueRef; bodyHash: Hash | null }[] =>
    claim.claim.kind === "question"
      ? rowOwners(state, claim.claim.context).map((issue) => ({ issue, bodyHash: facts.issues.find((i) => sameIssue(i.ref, issue))?.bodyHash ?? null }))
      : [];
  // body hash of the member a noCode or split claim names: its decision is pinned to it
  const claimBodyHash = ({ claim }: PendingClaim): Hash | null =>
    claim.kind === "noCode" || claim.kind === "split" ? (facts.issues.find((i) => sameIssue(i.ref, claim.member))?.bodyHash ?? null) : null;
  const base = (
    id: ObligationId,
    kind: string,
    holder: Holder,
    context: string,
    input: BriefInput,
    opts: { readonly seat?: SeatBinding } = {},
  ): Obligation => ({
    id,
    kind,
    holder,
    context,
    seat: opts.seat ?? null,
    action: null,
    accepts: holder === "program" ? [] : holder === "main" ? ["decision"] : [],
    yieldAllowed: false,
    brief: briefFor(
      input,
      { id, kind, context, requestName: opts.seat?.requestName ?? null, workDir: opts.seat?.workDir ?? null, pin: c.pins.get(id) ?? null, parent: state.parent },
      policy,
    ),
  });

  // member
  if (c.member !== null) {
    const { s, w } = c.member;
    const ctx = issueKey(w.entry.issue);
    for (const sp of memberRules(s)) {
      switch (sp.kind) {
        case "decideClaim":
          if (w.ids.decideClaim !== null && w.claim !== null)
            out.push(base(w.ids.decideClaim, "decideClaim", "main", ctx, { kind: "decideClaim", member: w, claim: w.claim, claimBodyHash: claimBodyHash(w.claim) }));
          break;
        case "deliver":
        case "fix": {
          const id = sp.kind === "deliver" ? w.ids.deliver : w.ids.fix;
          if (id === null) break;
          const owner = sp.holder === "owner";
          const seat: SeatBinding | undefined = owner
            ? { role: "owner", requestName: w.names.owner, workDir: workDir(w.entry.issue, w.names.owner), agent: policy.seatAgents.owner }
            : undefined;
          if (owner) needed.add(w.names.owner);
          out.push({
            ...base(id, sp.kind, sp.holder, ctx, { kind: sp.kind, member: w, situation: s }, seat === undefined ? {} : { seat }),
            accepts: ["prSubmit", "claim"],
            yieldAllowed: s.claim === "noCode" || s.claim === "split" || s.claim === "blocked",
          });
          break;
        }
        case "decideFindings":
          if (w.ids.decideFindings !== null && w.unadjudicated !== null)
            out.push(base(w.ids.decideFindings, sp.kind, "main", ctx, { kind: "decideFindings", member: w, verdict: w.unadjudicated }));
          break;
        case "designFix":
          if (w.ids.designFix !== null && w.designFixVerdict !== null)
            out.push(base(w.ids.designFix, sp.kind, "main", ctx, { kind: "designFix", member: w, verdict: w.designFixVerdict }));
          break;
        case "decideChecks":
          if (w.ids.decideChecks !== null && w.pr !== null && w.failedRun !== null)
            out.push(base(w.ids.decideChecks, sp.kind, "main", ctx, { kind: "decideChecks", member: w, pr: w.pr.ref, runId: w.failedRun }));
          break;
        case "review":
        case "accept": {
          const id = sp.kind === "review" ? w.ids.review : w.ids.accept;
          const name = sp.kind === "review" ? w.names.review : w.names.accept;
          if (id === null || name === null) break;
          needed.add(name);
          const seat: SeatBinding = { role: sp.kind, requestName: name, workDir: workDir(w.entry.issue, name), agent: policy.seatAgents.gate };
          out.push({ ...base(id, sp.kind, "gate", ctx, { kind: sp.kind, member: w }, { seat }), accepts: ["verdict", "claim"] });
          break;
        }
        case "merge":
          if (w.ids.merge !== null && w.pr !== null)
            out.push({ ...base(w.ids.merge, sp.kind, "program", ctx, { kind: "program", what: "merge" }), action: { kind: "merge", pr: w.pr.ref, head: w.pr.head } });
          break;
        default:
          assertNever(sp.kind);
      }
    }
  }

  // reconcile
  for (const { s, w } of c.reconcile) {
    const ctx = issueKey(w.member);
    for (const sp of reconcileRules(s)) {
      switch (sp.kind) {
        case "close":
        case "reopen":
          out.push({ ...base(sp.kind === "close" ? w.ids.close : w.ids.reopen, sp.kind, "program", ctx, { kind: "program", what: sp.kind }), action: { kind: sp.kind, issue: w.member } });
          break;
        case "decideReopened":
          if (w.ids.decideReopened !== null && w.eventForDecision !== null)
            out.push(base(w.ids.decideReopened, sp.kind, "main", ctx, { kind: "decideReopened", reconcile: w, event: w.eventForDecision }));
          break;
        case "decideClosed":
          if (w.ids.decideClosed !== null && w.eventForDecision !== null && w.bodyHash !== null)
            out.push(base(w.ids.decideClosed, sp.kind, "main", ctx, { kind: "decideClosed", reconcile: w, event: w.eventForDecision, bodyHash: w.bodyHash }));
          break;
        default:
          assertNever(sp.kind);
      }
    }
  }

  // unit verification
  if (c.verification !== null) {
    const { s, w } = c.verification;
    const ctx = `verify:${issueKey(w.unit.top.issue)}`;
    for (const sp of verificationRules(s)) {
      switch (sp.kind) {
        case "decideClaim":
          if (w.ids.decideClaim !== null && w.claim !== null)
            out.push(base(w.ids.decideClaim, sp.kind, "main", ctx, { kind: "decideVerificationClaim", claim: w.claim, claimBodyHash: claimBodyHash(w.claim), rowOwners: ownersOf(w.claim) }));
          break;
        case "postMerge":
          needed.add(w.name);
          out.push({
            ...base(w.ids.postMerge, sp.kind, "gate", ctx, { kind: "postMerge", verification: w }, {
              seat: { role: "postMerge", requestName: w.name, workDir: workDir(w.unit.top.issue, w.name), agent: policy.seatAgents.gate },
            }),
            accepts: ["verdict", "claim"],
          });
          break;
        case "decidePostMergeFail":
          if (w.ids.decidePostMergeFail !== null && w.failing !== null)
            out.push(base(w.ids.decidePostMergeFail, sp.kind, "main", ctx, { kind: "decidePostMergeFail", verification: w, verdict: w.failing }));
          break;
        default:
          assertNever(sp.kind);
      }
    }
  }

  // agenda closure
  {
    const { s, w } = c.closure;
    for (const sp of closureRules(s)) {
      switch (sp.kind) {
        case "decideClaim":
          if (w.ids.decideClaim !== null && w.claim !== null)
            out.push(base(w.ids.decideClaim, sp.kind, "main", "closure", { kind: "decideVerificationClaim", claim: w.claim, claimBodyHash: claimBodyHash(w.claim), rowOwners: ownersOf(w.claim) }));
          break;
        case "closure":
          if (w.ids.closure !== null && w.name !== null && w.parent !== null) {
            needed.add(w.name);
            out.push({
              ...base(w.ids.closure, sp.kind, "gate", "closure", { kind: "closure", closure: w }, {
                seat: { role: "closure", requestName: w.name, workDir: workDir(w.parent, w.name), agent: policy.seatAgents.gate },
              }),
              accepts: ["verdict", "claim"],
            });
          }
          break;
        case "decideClosureFail":
          if (w.ids.decideClosureFail !== null && w.failing !== null)
            out.push(base(w.ids.decideClosureFail, sp.kind, "main", "closure", { kind: "decideClosureFail", closure: w, verdict: w.failing }));
          break;
        case "closeParent":
        case "reopenParent":
          if (w.parent !== null)
            out.push({
              ...base(sp.kind === "closeParent" ? w.ids.closeParent : w.ids.reopenParent, sp.kind, "program", "closure", { kind: "program", what: sp.kind }),
              action: { kind: sp.kind, issue: w.parent },
            });
          break;
        case "report":
          out.push(base(w.ids.report, sp.kind, "main", "closure", { kind: "report", units: c.units }));
          break;
        default:
          assertNever(sp.kind);
      }
    }
  }

  // subjects
  for (const { s, w } of c.subjects) {
    for (const sp of subjectRules(s)) {
      if (sp.kind === "decideSubject") out.push(base(w.id, `decide:${w.subject}`, "main", "agenda", { kind: "decideSubject", subject: w }));
    }
  }

  // effects
  for (const { s, w } of c.effects) {
    for (const sp of effectRules(s)) {
      switch (sp.kind) {
        case "execute":
          out.push({ ...base(w.id, `effect:${w.target.kind}`, "program", "agenda", { kind: "program", what: w.target.kind }), action: { kind: "effect", target: w.target } });
          break;
        case "decideEffectFailed":
          if (w.failedId !== null && w.failure !== null) out.push(base(w.failedId, sp.kind, "main", "agenda", { kind: "decideEffectFailed", effect: w, failure: w.failure }));
          break;
        case "decideStall":
          out.push(base(w.conflictId, sp.kind, "main", "agenda", { kind: "decideEffectConflict", effect: w }));
          break;
        default:
          assertNever(sp.kind);
      }
    }
  }

  // seats: spawn / wake for seats needed by the obligations above, plus pending receipts
  for (const seat of c.seats) {
    const needs = needed.has(seat.w.requestName);
    for (const sp of seatRules({ seat: seat.state, needed: needs })) {
      if (sp.kind === "spawn") {
        const acknowledgeOnly = seat.state === "pendingAck";
        out.push(
          base(seat.w.spawnId, "spawn", "main", "seat", {
            kind: "spawn",
            seat: seat.w,
            acknowledgeOnly,
            pending: seat.w.pending,
            agent: out.find((o) => o.seat?.requestName === seat.w.requestName)?.seat?.agent ?? null,
            assignment: out.find((o) => o.seat?.requestName === seat.w.requestName)?.brief ?? null,
          }),
        );
      } else if (seat.w.wakeId !== null && seat.w.holder !== null) {
        out.push({
          ...base(seat.w.wakeId, "wake", "program", "seat", { kind: "program", what: "wake" }),
          action: { kind: "wake", agent: seat.w.holder, requestName: seat.w.requestName },
        });
      }
    }
  }
  for (const p of c.pendingAcks) {
    out.push(base(p.id, "spawn", "main", "seat", { kind: "acknowledge", requestName: p.requestName, agent: p.agentId as AgentId, previous: p.previous }));
  }

  // Completion lives in state: an answered ticket's slot changes, so rules no longer produce it (core.md §3 完结).
  const obligations = out;
  const waiting =
    (c.member !== null && memberWaiting(c.member.s)) ||
    c.effects.some((e) => effectWaiting(e.s)) ||
    c.stall.decided === "external" ||
    obligations.some((o) => o.holder === "program");
  const done = c.currentUnit === null && closureDone(c.closure.s);
  if (!done && obligations.length === 0 && !waiting && c.stall.decided === "none") {
    obligations.push(base(c.stall.id, "decideStall", "main", "agenda", { kind: "stall", classified: c }));
  }
  return { classified: c, obligations, waiting, done };
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
