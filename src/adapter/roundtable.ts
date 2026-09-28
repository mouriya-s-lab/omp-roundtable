// The seat adapter's process-wide driver: one serial derivation loop, the port operations, and delivery.
//
// What lives in process, and why (design「进程视图」, core.md §1 host):
// - `failures` (`host.failures` / execution): the only fact this process is the source of.
// - `active`: which agenda this process drives — an index set by convene/resume, never a fact.
// - `latest`: the output of the latest completed round (tickets are derived, not state). Only the `context` hook reads it,
//   so each model request carries the current briefs without a GitHub read per request; every round replaces it, a halted
//   agenda clears it, and admission, yield interception and main reminders always run a fresh round first.
// - `systemPrompt`: what the main session saw at its latest `before_agent_start` (policy source, design「策略原文」).
// - `bindings`: each live session's own `sendUserMessage`, refreshed on session_start; a parked session's binding goes stale
//   and is replaced when the host rebinds it.
// Protocol decisions are all core's: this module only reads, derives, executes program obligations, and delivers.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  admit,
  derive,
  requestName,
  stripSuffix,
  workDir,
  type AdmitFacts,
  type Caller,
  type Derived,
  type EffectFailure,
  type Host,
  type IssueRef,
  type Millis,
  type Obligation,
} from "../core/index.ts";
import type { Store, StoreError } from "../store/index.ts";
import type { GhCounter } from "./gh-counter.ts";
import { authorOf, callerOf, idleSubagents, readAgents, spawnPremise } from "./host.ts";
import { parseConvene, parseResume, parseReply } from "./parse.ts";
import { readPolicy } from "./policy.ts";
import type { Settings } from "./settings.ts";

export interface Binding {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
}

export type PortResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string };

type Round =
  | { readonly kind: "noAgenda" }
  | { readonly kind: "derived"; readonly agenda: IssueRef; readonly derived: Derived }
  | { readonly kind: "failed"; readonly agenda: IssueRef; readonly error: StoreError }
  | { readonly kind: "quota"; readonly agenda: IssueRef; readonly until: number }
  /** An unexpected exception inside the round (a program error, not a store result). */
  | { readonly kind: "error"; readonly message: string };

type Trigger = "timer" | "registry" | "reply" | "convene" | "resume" | "yield" | "agentEnd" | "tickets";

const HOUR = 3_600_000;

/** `owner/name#N`, as agenda and member references appear in messages. */
const refText = (i: IssueRef): string => `${i.repo.owner}/${i.repo.name}#${i.number}`;

export class Roundtable {
  readonly #store: Store;
  readonly #counter: GhCounter | null;
  readonly #settings: Settings;
  readonly #appendSystemPath: string;
  readonly #failures: EffectFailure[] = [];
  readonly #bindings = new Map<string, Binding>();
  #main: Binding | null = null;
  #active: IssueRef | null = null;
  #latest: { readonly agenda: IssueRef; readonly derived: Derived } | null = null;
  #systemPrompt: readonly string[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  #queuedRound: Promise<Round> | null = null;
  #quotaNoticeUntil = 0;

  constructor(deps: { readonly store: Store; readonly counter: GhCounter | null; readonly settings: Settings; readonly appendSystemPath: string }) {
    this.#store = deps.store;
    this.#counter = deps.counter;
    this.#settings = deps.settings;
    this.#appendSystemPath = deps.appendSystemPath;
  }

  get recomputeIntervalMs(): number {
    return this.#settings.recomputeIntervalMs;
  }

  hasAgenda(): boolean {
    return this.#active !== null;
  }

  // ------------------------------------------------------------------ bindings and host observations

  bind(pi: ExtensionAPI, ctx: ExtensionContext): void {
    const binding = { pi, ctx };
    this.#bindings.set(ctx.agent.id, binding);
    if (ctx.agent.kind === "main") this.#main = binding;
  }

  unbind(ctx: ExtensionContext): void {
    const current = this.#bindings.get(ctx.agent.id);
    if (current?.ctx === ctx) this.#bindings.delete(ctx.agent.id);
    if (this.#main?.ctx === ctx) this.#main = null;
  }

  observeSystemPrompt(systemPrompt: readonly string[]): void {
    this.#systemPrompt = systemPrompt;
  }

  #host(): Host {
    return { agents: readAgents(), failures: [...this.#failures] };
  }

  #policy() {
    return readPolicy(this.#appendSystemPath, this.#systemPrompt);
  }

  // ------------------------------------------------------------------ tickets held by a caller

  /** Obligations the caller holds in `derived`: main holds `main` obligations; a subagent holds its seat's obligations
   * when it is that seat's holder or the agent awaiting its `seated` receipt (the same binding `admit` checks). */
  static held(derived: Derived, caller: { readonly kind: "main" } | { readonly kind: "sub"; readonly agentId: string }): readonly Obligation[] {
    if (caller.kind === "main") return derived.obligations.filter((o) => o.holder === "main");
    const name = stripSuffix(caller.agentId);
    const seat = derived.classified.seats.find((s) => s.w.requestName === name);
    if (seat === undefined || (seat.w.holder !== caller.agentId && seat.w.pending !== caller.agentId)) return [];
    return derived.obligations.filter((o) => o.seat?.requestName === name && (o.holder === "owner" || o.holder === "gate"));
  }

  /** Briefs to inject into this session's next model request (context hook). */
  injection(ctx: ExtensionContext): string | null {
    const latest = this.#latest;
    if (latest === null) return null;
    const held = Roundtable.held(latest.derived, ctx.agent.kind === "main" ? { kind: "main" } : { kind: "sub", agentId: ctx.agent.id });
    if (held.length === 0) return null;
    return [
      `<roundtable-tickets agenda="${refText(latest.agenda)}">`,
      `你在圆桌上持有 ${held.length} 张票据。下面是每张票据的完整简报；按简报工作，并用 \`roundtable\` 工具（op: "reply"，ticket: 票据 id）回复。只有写入圆桌的回复才算完成票据。`,
      ...held.map((o) => `---\n${o.brief}`),
      "</roundtable-tickets>",
    ].join("\n\n");
  }

  // ------------------------------------------------------------------ the serial loop

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Request a round; triggers arriving while one is queued (not yet started) join it. The hourly GitHub-call ceiling
   * (design Q7) gates the timer's full recompute only: rounds caused by a reply, yield, turn end, convene/resume or a
   * registry change still run, so the ceiling never starves the protocol.
   */
  trigger(reason: Trigger): Promise<Round> {
    const agenda = this.#active;
    const until = reason === "timer" && agenda !== null ? this.#quotaUntil() : null;
    if (agenda !== null && until !== null) {
      const round: Round = { kind: "quota", agenda, until };
      this.#report(round, reason);
      return Promise.resolve(round);
    }
    if (this.#queuedRound !== null) return this.#queuedRound;
    const queued = this.#serial(async () => {
      this.#queuedRound = null;
      return this.#roundAndDeliver(reason, reason !== "agentEnd");
    });
    this.#queuedRound = queued;
    return queued;
  }

  /** Delivery to main is skipped when the caller answers main itself (port operations, agent_end reminder). */
  async #roundAndDeliver(reason: Trigger, deliverMain: boolean): Promise<Round> {
    let round: Round;
    try {
      round = await this.#round();
    } catch (err) {
      round = { kind: "error", message: err instanceof Error ? err.stack ?? err.message : String(err) };
    }
    this.#report(round, reason);
    if (round.kind === "derived") this.#deliver(round.derived, deliverMain);
    return round;
  }

  /**
   * One derivation round: read, derive, execute every program obligation; re-read after any effect changed the source
   * or failed, until a round executes nothing new. `alreadyDone` means the store found the effect at the source.
   */
  async #round(): Promise<Round> {
    const agenda = this.#active;
    if (agenda === null) return { kind: "noAgenda" };
    for (;;) {
      const read = await this.#store.readSnapshot(agenda);
      if (!read.ok) return { kind: "failed", agenda, error: read.error };
      const derived = derive(read.value.snapshot, this.#host(), this.#policy());
      this.#latest = { agenda, derived };
      let changed = false;
      for (const o of derived.obligations) {
        if (o.holder !== "program" || o.action === null) continue;
        const result = await this.#store.execute(agenda, o.id, o.action);
        if (result.ok) {
          if (result.value === "done") changed = true;
        } else {
          this.#failures.push({ effect: o.id, at: Date.now() as Millis, error: `${result.error.kind}: ${result.error.detail}` });
          changed = true;
        }
      }
      if (!changed) return { kind: "derived", agenda, derived };
    }
  }

  /** Read failures void the round (crash matrix 12); a key mismatch halts the agenda (crash matrix 10). Both go to main. */
  #report(round: Round, reason: Trigger): void {
    switch (round.kind) {
      case "noAgenda":
      case "derived":
        return;
      case "failed": {
        const { kind, detail } = round.error;
        if (kind === "keyMismatch") {
          this.#active = null;
          this.#latest = null;
          this.#tellMain(
            `圆桌已停止推进议程 ${refText(round.agenda)}：store 报告 keyMismatch（${detail}）。议程上已有的签名记录无法用本机密钥验证，不能当作没有发生过而重新开始。按崩溃矩阵第 10 行作为阻塞报告操作员；密钥迁移归 omp-config。`,
          );
        } else {
          this.#tellMain(`圆桌本轮推导作废（触发：${reason}）：store 报告 ${kind}（${detail}）。本轮不产生任何义务；下一次触发时重读。`);
        }
        return;
      }
      case "quota": {
        if (Date.now() < this.#quotaNoticeUntil) return;
        this.#quotaNoticeUntil = round.until;
        this.#tellMain(
          `圆桌已达到每小时 GitHub API 调用上限 ${this.#settings.hourlyGhCallCeiling}（计数日志 ${this.#counter?.logPath ?? "-"}）。在 ${new Date(round.until).toISOString()} 之前暂停定时全量重算；回复准入与事件触发的推导照常进行。`,
        );
        return;
      }
      case "error":
        this.#tellMain(`圆桌推导出错（触发：${reason}）：${round.message}`);
        return;
      default:
        assertNever(round);
    }
  }

  /** When the calls in the last hour reach the ceiling: the time the window frees one slot. */
  #quotaUntil(): number | null {
    if (this.#counter === null) return null;
    const now = Date.now();
    const calls = this.#counter.timestampsSince(now - HOUR);
    const ceiling = this.#settings.hourlyGhCallCeiling;
    if (calls.length < ceiling) return null;
    return (calls[calls.length - ceiling] ?? now) + HOUR;
  }

  // ------------------------------------------------------------------ delivery

  /** Start a turn in each idle session that holds a ticket it may not wait on. */
  #deliver(derived: Derived, deliverMain: boolean): void {
    const main = this.#main;
    if (main !== null && deliverMain && main.ctx.isIdle()) {
      const held = Roundtable.held(derived, { kind: "main" });
      if (held.length > 0) main.pi.sendUserMessage(nudge(held));
    }
    for (const id of idleSubagents()) {
      const binding = this.#bindings.get(id);
      if (binding === undefined) continue;
      const held = Roundtable.held(derived, { kind: "sub", agentId: id }).filter((o) => !o.yieldAllowed);
      if (held.length > 0) binding.pi.sendUserMessage(nudge(held));
    }
  }

  #tellMain(text: string): void {
    const main = this.#main;
    if (main === null) {
      console.error(`[omp-roundtable] ${text}`);
      return;
    }
    main.pi.sendUserMessage(`[圆桌] ${text}`, { deliverAs: "followUp" });
  }

  // ------------------------------------------------------------------ receipt interception

  /** `tool_call` on `yield` in a subagent: a fresh round, then block while the caller holds a ticket it must answer. */
  async yieldBlock(ctx: ExtensionContext): Promise<string | null> {
    if (this.#active === null) return null;
    const round = await this.trigger("yield");
    const derived = round.kind === "derived" ? round.derived : this.#latest?.derived ?? null;
    if (derived === null) return null;
    const held = Roundtable.held(derived, { kind: "sub", agentId: ctx.agent.id }).filter((o) => !o.yieldAllowed);
    if (held.length === 0) return null;
    return [
      "圆桌拦下了这次 yield：你持有的票据还没有回执。投递出去不算完成，只有用端口回复才算。",
      ...held.map((o) => `- 票据 ${o.id}（${o.kind}）：用 \`roundtable\` 工具 op "reply"、ticket "${o.id}" 回复 ${o.accepts.map((k) => `\`${k}\``).join(" 或 ")}。完整简报已附在你的上下文里。`),
      "回复写入后再 yield。",
    ].join("\n");
  }

  /** `agent_end` in the main session: a fresh round, then a reminder while main still holds tickets. */
  async remindMain(): Promise<void> {
    if (this.#active === null) return;
    const round = await this.trigger("agentEnd");
    if (round.kind !== "derived" || this.#main === null) return;
    const held = Roundtable.held(round.derived, { kind: "main" });
    if (held.length > 0) this.#main.pi.sendUserMessage(nudge(held), { deliverAs: "followUp" });
  }

  // ------------------------------------------------------------------ port operations

  async tickets(ctx: ExtensionContext): Promise<PortResult> {
    if (this.#active === null) return { ok: true, text: "本进程当前没有进行中的议程。" };
    const round = await this.trigger("tickets");
    if (round.kind !== "derived") return { ok: false, text: roundProblem(round) };
    const held = Roundtable.held(round.derived, ctx.agent.kind === "main" ? { kind: "main" } : { kind: "sub", agentId: ctx.agent.id });
    if (held.length === 0) return { ok: true, text: `议程 ${refText(round.agenda)}：你当前不持有票据。${round.derived.done ? "交付已完成。" : round.derived.waiting ? "议程在等待外部状态（checks、mergeable 或效应）。" : ""}` };
    return { ok: true, text: [`议程 ${refText(round.agenda)}：你持有 ${held.length} 张票据。`, ...held.map((o) => `---\n${o.brief}`)].join("\n\n") };
  }

  async convene(ctx: ExtensionContext, input: unknown): Promise<PortResult> {
    if (ctx.agent.kind !== "main") return { ok: false, text: "只有主会话可以召集议程。" };
    const parsed = parseConvene(input);
    if (!parsed.ok) return { ok: false, text: parsed.error };
    const refusal = await spawnPremise(ctx);
    if (refusal !== null) return { ok: false, text: refusal };
    const { mode, repo, parent, entries } = parsed.value;
    if (mode === "plan") {
      const lines = entries.map(
        (e, i) =>
          `${i + 1}. ${refText(e.issue)} → ${e.target.repo.owner}/${e.target.repo.name}@${e.target.base}${e.designOnly ? "（仅设计，owner 义务由主会话持有）" : `，owner 席位 ${requestName("owner", e.issue, null, 1)}，工作目录 ${workDir(e.issue, requestName("owner", e.issue, null, 1))}`}${e.adoptPr === null ? "" : `，接管 PR ${refText(e.adoptPr)}`}`,
      );
      return { ok: true, text: [`计划（未写入存储）：议程 issue 将建在 ${repo.owner}/${repo.name}${parent === null ? "" : `，挂到 parent ${refText(parent)} 下`}，按以下顺序交付：`, ...lines].join("\n") };
    }
    return this.#serial(async () => {
      if (this.#active !== null) return { ok: false, text: `本进程已在推进议程 ${refText(this.#active)}；一个进程只推进一份议程。` };
      const result = await this.#store.convene({ repo, parent, convened: entries });
      if (!result.ok) return { ok: false, text: `召集失败：${result.error.kind}（${result.error.detail}）` };
      this.#active = result.value;
      return this.#started(ctx, result.value, "convene");
    });
  }

  async resume(ctx: ExtensionContext, input: unknown): Promise<PortResult> {
    if (ctx.agent.kind !== "main") return { ok: false, text: "只有主会话可以恢复议程。" };
    const parsed = parseResume(input);
    if (!parsed.ok) return { ok: false, text: parsed.error };
    const refusal = await spawnPremise(ctx);
    if (refusal !== null) return { ok: false, text: refusal };
    return this.#serial(async () => {
      if (this.#active !== null) return { ok: false, text: `本进程已在推进议程 ${refText(this.#active)}。` };
      this.#active = parsed.value.agenda;
      return this.#started(ctx, parsed.value.agenda, "resume");
    });
  }

  /** First round after convene/resume, inside the serial section. */
  async #started(ctx: ExtensionContext, agenda: IssueRef, reason: Trigger): Promise<PortResult> {
    const round = await this.#roundAndDeliver(reason, false);
    if (round.kind !== "derived")
      return { ok: false, text: `议程 ${refText(agenda)} 已${reason === "convene" ? "召集" : "接手"}，但首轮推导没有结果：${roundProblem(round)}` };
    const held = Roundtable.held(round.derived, ctx.agent.kind === "main" ? { kind: "main" } : { kind: "sub", agentId: ctx.agent.id });
    return {
      ok: true,
      text: [
        `议程 ${refText(agenda)}（https://github.com/${agenda.repo.owner}/${agenda.repo.name}/issues/${agenda.number}）已${reason === "convene" ? "召集" : "接手"}。此后按注入的票据行动。`,
        held.length === 0 ? "你当前不持有票据。" : `你当前持有 ${held.length} 张票据：`,
        ...held.map((o) => `---\n${o.brief}`),
      ].join("\n\n"),
    };
  }

  /** C2: `(ctx.agent, payload)` → admit → write; then a round so the reply's consequences run before returning. */
  async reply(ctx: ExtensionContext, ticket: unknown, payload: unknown): Promise<PortResult> {
    const parsed = parseReply(ticket, payload);
    if (!parsed.ok) return { ok: false, text: `回复格式不符：${parsed.error}` };
    const reply = parsed.value;
    const caller: Caller = callerOf(ctx);
    return this.#serial(async () => {
      const agenda = this.#active;
      if (agenda === null) return { ok: false, text: "本进程当前没有进行中的议程，无法准入回复。" };
      const read = await this.#store.readSnapshot(agenda);
      if (!read.ok) {
        this.#report({ kind: "failed", agenda, error: read.error }, "reply");
        return { ok: false, text: `读取存储失败（${read.error.kind}：${read.error.detail}），回复没有写入；稍后重发同一回复。` };
      }
      const snapshot = read.value.snapshot;
      const host = this.#host();
      const policy = this.#policy();
      let facts: AdmitFacts = { branchHead: null, branchContains: [] };
      if (reply.kind === "prSubmit") {
        const member = derive(snapshot, host, policy).classified.member;
        if (member !== null) {
          const live = await this.#store.readAdmitFacts(snapshot, member.w.entry.target.repo, reply.branch);
          if (!live.ok) return { ok: false, text: `读取分支 ${reply.branch} 的实时事实失败（${live.error.kind}：${live.error.detail}）；稍后重发同一回复。` };
          facts = live.value;
        }
      }
      const admission = admit(snapshot, host, policy, caller, reply, facts);
      switch (admission.kind) {
        case "rejected":
          return { ok: false, text: `圆桌拒绝了这条回复：${admission.reason}` };
        case "replayed":
          return { ok: true, text: `已写入：相同的回复此前已写成记录 ${admission.existing}，没有重复写入。` };
        case "record": {
          const written = await this.#store.writeRecord(agenda, admission.record, authorOf(caller));
          if (!written.ok) return { ok: false, text: `写入失败（${written.error.kind}：${written.error.detail}）；票据仍未完结，请重发同一回复。` };
          const round = await this.#roundAndDeliver("reply", caller.kind !== "main");
          const remaining = round.kind === "derived" ? Roundtable.held(round.derived, caller.kind === "main" ? { kind: "main" } : { kind: "sub", agentId: caller.agentId }) : [];
          return {
            ok: true,
            text: [
              `已写入记录 ${written.value.id}（议程 issue ${refText(agenda)} 上的签名评论）。`,
              remaining.length === 0 ? "你当前不再持有票据。" : `你仍持有 ${remaining.length} 张票据：${remaining.map((o) => `${o.id}（${o.kind}）`).join("、")}；完整简报随下一次请求注入。`,
            ].join("\n"),
          };
        }
        default:
          return assertNever(admission);
      }
    });
  }
}

function nudge(held: readonly Obligation[]): string {
  return [
    `[圆桌] 你持有 ${held.length} 张待回复的票据：${held.map((o) => `${o.id}（${o.kind}）`).join("、")}。`,
    "完整简报已随每次请求注入你的上下文。按简报行动，完成后用 `roundtable` 工具 op \"reply\" 回复；只有写入圆桌的回复才算消费票据。",
  ].join("\n");
}

function roundProblem(round: Round): string {
  switch (round.kind) {
    case "noAgenda":
      return "没有进行中的议程。";
    case "derived":
      return "";
    case "failed":
      return `store 报告 ${round.error.kind}（${round.error.detail}）。`;
    case "quota":
      return `已达到每小时 GitHub API 调用上限，${new Date(round.until).toISOString()} 之后恢复。`;
    case "error":
      return `推导出错：${round.message}`;
    default:
      return assertNever(round);
  }
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
