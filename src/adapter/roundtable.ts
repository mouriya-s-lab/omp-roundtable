// The seat adapter's process-wide driver: one serial derivation loop, the port operations, and delivery.
//
// What lives in process, and why (design「进程视图」, core.md §1 host):
// - `failures` (`host.failures` / execution): the only fact this process is the source of.
// - `active`: which agenda this process drives — an index set by convene/resume, never a fact.
// - `latest`: the output of the latest round (tickets are derived, not state), a near copy of what the state file and
//   GitHub gave then. Read-only consumers use it (the `context` hook, `tickets`, the main reminder; design Q7); every round
//   replaces it, and every transition or effect runs a new round before anything reads it again.
// - `systemPrompt`: what the main session saw at its latest `before_agent_start` (policy source, design「策略原文」).
// - `bindings`: each live session's own `sendUserMessage`, refreshed on session_start.
// The agenda state itself is read from the state file every round and written only when `step` says `next`.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  convene,
  derive,
  requestName,
  step,
  stripSuffix,
  workDir,
  type AgendaId,
  type AgendaState,
  type Derived,
  type EffectFailure,
  type Facts,
  type Host,
  type IssueRef,
  type LiveFacts,
  type Millis,
  type Obligation,
  type Reply,
  type StepEvent,
  type Transition,
} from "../core/index.ts";
import type { CommitPair, Store, StoreError } from "../store/index.ts";
import { callerOf, idleSubagents, readAgents, spawnPremise } from "./host.ts";
import { parseConvene, parseReply, parseResume } from "./parse.ts";
import { readPolicy } from "./policy.ts";
import type { Settings } from "./settings.ts";

export interface Binding {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionContext;
}

export type PortResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly text: string };

type Round =
  | { readonly kind: "noAgenda" }
  | { readonly kind: "derived"; readonly agenda: AgendaId; readonly derived: Derived }
  | { readonly kind: "failed"; readonly agenda: AgendaId; readonly error: StoreError }
  /** An unexpected exception inside the round (a program error, not a store result). */
  | { readonly kind: "error"; readonly message: string };

type Trigger = "timer" | "registry" | "reply" | "convene" | "resume" | "yield" | "tickets" | "agentEnd";

const refText = (i: IssueRef): string => `${i.repo.owner}/${i.repo.name}#${i.number}`;

export class Roundtable {
  readonly #store: Store;
  readonly #settings: Settings;
  readonly #appendSystemPath: string;
  readonly #failures: EffectFailure[] = [];
  readonly #bindings = new Map<string, Binding>();
  #main: Binding | null = null;
  #active: AgendaId | null = null;
  #latest: { readonly agenda: AgendaId; readonly derived: Derived; readonly seen: ReadonlySet<string> } | null = null;
  #systemPrompt: readonly string[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  #queuedRound: Promise<Round> | null = null;

  constructor(deps: { readonly store: Store; readonly settings: Settings; readonly appendSystemPath: string }) {
    this.#store = deps.store;
    this.#settings = deps.settings;
    this.#appendSystemPath = deps.appendSystemPath;
  }

  get recomputeIntervalMs(): number {
    return this.#settings.recomputeIntervalMs;
  }

  // ------------------------------------------------------------------ bindings and host observations

  bind(pi: ExtensionAPI, ctx: ExtensionContext): void {
    const binding = { pi, ctx };
    this.#bindings.set(ctx.agent.id, binding);
    if (ctx.agent.kind === "main") this.#main = binding;
  }

  unbind(ctx: ExtensionContext): void {
    if (this.#bindings.get(ctx.agent.id)?.ctx === ctx) this.#bindings.delete(ctx.agent.id);
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

  /** Obligations the caller holds: main holds `main` obligations; a subagent holds its seat's obligations when it is the
   * seat's recorded holder or the agent awaiting its `seated` receipt (the binding `step` checks). */
  static held(derived: Derived, caller: { readonly kind: "main" } | { readonly kind: "sub"; readonly agentId: string }): readonly Obligation[] {
    if (caller.kind === "main") return derived.obligations.filter((o) => o.holder === "main");
    const name = stripSuffix(caller.agentId);
    const seat = derived.classified.seats.find((s) => s.w.requestName === name);
    if (seat === undefined || (seat.w.holder !== caller.agentId && seat.w.pending !== caller.agentId)) return [];
    return derived.obligations.filter((o) => o.seat?.requestName === name && (o.holder === "owner" || o.holder === "gate"));
  }

  /** Briefs to inject into this session's next model request (context hook). */
  async injection(ctx: ExtensionContext): Promise<string | null> {
    let latest = this.#latest;
    if (latest === null) return null;
    const id = ctx.agent.id;
    // A seat's first request races the round its spawn triggered: wait for the round that sees it.
    if (ctx.agent.kind === "sub" && !latest.seen.has(id) && readAgents().some((a) => a.id === id)) {
      await this.trigger("registry");
      latest = this.#latest;
      if (latest === null) return null;
    }
    const held = Roundtable.held(latest.derived, ctx.agent.kind === "main" ? { kind: "main" } : { kind: "sub", agentId: id });
    if (held.length === 0) return null;
    return [
      `<roundtable-tickets agenda="${latest.agenda}">`,
      `你在圆桌上持有 ${held.length} 张票据。下面是每张票据的完整简报；按简报工作，并用 \`roundtable\` 工具（op: "reply"，ticket: 票据 id）回复。只有被圆桌接受的回复才算完成票据。`,
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

  /** Request a round; triggers arriving while one is queued (not yet started) join it. */
  trigger(reason: Trigger): Promise<Round> {
    if (this.#queuedRound !== null) return this.#queuedRound;
    const queued = this.#serial(async () => {
      this.#queuedRound = null;
      return this.#roundAndDeliver(reason, reason !== "agentEnd");
    });
    this.#queuedRound = queued;
    return queued;
  }

  /** The latest round's result for a read-only consumer, or a fresh round when there is none yet. */
  async #current(reason: Trigger): Promise<Round> {
    const latest = this.#latest;
    if (latest !== null && latest.agenda === this.#active) return { kind: "derived", agenda: latest.agenda, derived: latest.derived };
    return this.trigger(reason);
  }

  async #roundAndDeliver(reason: Trigger, deliverMain: boolean): Promise<Round> {
    let round: Round;
    try {
      round = await this.#round();
    } catch (err) {
      round = { kind: "error", message: err instanceof Error ? (err.stack ?? err.message) : String(err) };
    }
    this.#report(round, reason);
    if (round.kind === "derived") this.#deliver(round.derived, deliverMain);
    return round;
  }

  /**
   * One derivation round: load the state file, read GitHub once, derive, execute every program obligation. An effect
   * result is written back through `step`; any effect (done, result, or failure) changes what the next read sees, so
   * the round reads again until it executes nothing.
   */
  async #round(): Promise<Round> {
    const agenda = this.#active;
    if (agenda === null) return { kind: "noAgenda" };
    this.#latest = null;
    // Each program obligation runs at most once per round: when GitHub has not yet shown its effect, the next trigger
    // derives it again instead of this loop spinning on it.
    const executedIds = new Set<string>();
    for (;;) {
      const loaded = await this.#store.load(agenda);
      if (!loaded.ok) return { kind: "failed", agenda, error: loaded.error };
      let state = loaded.value;
      const read = await this.#store.facts(state);
      if (!read.ok) return { kind: "failed", agenda, error: read.error };
      const host = this.#host();
      const policy = this.#policy();
      const derived = derive(state, read.value, host, policy);
      this.#latest = { agenda, derived, seen: new Set(host.agents.map((a) => a.id)) };
      let changed = false;
      for (const o of derived.obligations) {
        if (o.holder !== "program" || o.action === null || executedIds.has(o.id)) continue;
        executedIds.add(o.id);
        changed = true;
        const executed = await this.#store.execute(state, o.action);
        if (!executed.ok) {
          this.#failures.push({ effect: o.id, at: Date.now() as Millis, error: `${executed.error.kind}: ${executed.error.detail}` });
          continue;
        }
        if (executed.value.kind !== "result") continue;
        // the result is state: one transition, written with the version compare
        const t = step(state, read.value, host, policy, { kind: "effectDone", effect: o.id, result: executed.value.result });
        const saved = await this.#commit(state, t);
        if (!saved.ok) return { kind: "failed", agenda, error: saved.error };
        state = saved.value;
      }
      if (!changed) return { kind: "derived", agenda, derived };
      this.#latest = null;
    }
  }

  /** Writes `next`; `same` writes nothing; a rejected effect result is a program error surfaced to main. */
  async #commit(state: AgendaState, t: Transition): Promise<{ ok: true; value: AgendaState } | { ok: false; error: StoreError }> {
    switch (t.kind) {
      case "same":
        return { ok: true, value: state };
      case "rejected":
        return { ok: false, error: { kind: "write", detail: `effect result rejected by step: ${t.reason}` } };
      case "next": {
        const saved = await this.#store.save(t.state);
        return saved.ok ? { ok: true, value: t.state } : saved;
      }
      default:
        return assertNever(t);
    }
  }

  /** A failed read voids the round (crash matrix 14); a missing state file is reported as such (crash matrix 13). */
  #report(round: Round, reason: Trigger): void {
    switch (round.kind) {
      case "noAgenda":
      case "derived":
        return;
      case "failed": {
        const { kind, detail } = round.error;
        if (kind === "missing") {
          this.#active = null;
          this.#latest = null;
          this.#tellMain(`圆桌已停止推进议程 ${round.agenda}：本机没有它的状态文件（${detail}）。议程不能从 GitHub 重建；需要继续时重新召集，已有 PR 用召集载荷指定接管。`);
        } else {
          this.#tellMain(`圆桌本轮推导作废（触发：${reason}）：store 报告 ${kind}（${detail}）。本轮不产生任何义务；下一次触发时重读。`);
        }
        return;
      }
      case "error":
        this.#tellMain(`圆桌推导出错（触发：${reason}）：${round.message}`);
        return;
      default:
        assertNever(round);
    }
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
    if (round.kind !== "derived") return null;
    const held = Roundtable.held(round.derived, { kind: "sub", agentId: ctx.agent.id }).filter((o) => !o.yieldAllowed);
    if (held.length === 0) return null;
    return [
      "圆桌拦下了这次 yield：你持有的票据还没有回复。投递出去不算完成，只有用端口回复才算。",
      ...held.map((o) => `- 票据 ${o.id}（${o.kind}）：用 \`roundtable\` 工具 op "reply"、ticket "${o.id}" 回复 ${o.accepts.map((k) => `\`${k}\``).join(" 或 ")}。完整简报已附在你的上下文里。`),
      "回复被接受后再 yield。",
    ].join("\n");
  }

  /** `agent_end` in the main session: a reminder, from the latest round, while main still holds tickets. */
  async remindMain(): Promise<void> {
    if (this.#active === null) return;
    const round = await this.#current("agentEnd");
    if (round.kind !== "derived" || this.#main === null) return;
    const held = Roundtable.held(round.derived, { kind: "main" });
    if (held.length > 0) this.#main.pi.sendUserMessage(nudge(held), { deliverAs: "followUp" });
  }

  // ------------------------------------------------------------------ port operations

  async tickets(ctx: ExtensionContext): Promise<PortResult> {
    if (this.#active === null) return { ok: true, text: "本进程当前没有进行中的议程。" };
    const round = await this.#current("tickets");
    if (round.kind !== "derived") return { ok: false, text: roundProblem(round) };
    const held = Roundtable.held(round.derived, ctx.agent.kind === "main" ? { kind: "main" } : { kind: "sub", agentId: ctx.agent.id });
    if (held.length === 0)
      return { ok: true, text: `议程 ${round.agenda}：你当前不持有票据。${round.derived.done ? "交付已完成。" : round.derived.waiting ? "议程在等待外部状态（checks、mergeable 或效应）。" : ""}` };
    return { ok: true, text: [`议程 ${round.agenda}：你持有 ${held.length} 张票据。`, ...held.map((o) => `---\n${o.brief}`)].join("\n\n") };
  }

  async convene(ctx: ExtensionContext, input: unknown): Promise<PortResult> {
    if (ctx.agent.kind !== "main") return { ok: false, text: "只有主会话可以召集议程。" };
    const parsed = parseConvene(input);
    if (!parsed.ok) return { ok: false, text: parsed.error };
    const refusal = await spawnPremise(ctx);
    if (refusal !== null) return { ok: false, text: refusal };
    const { mode, parent, entries } = parsed.value;
    if (mode === "plan") {
      const lines = entries.map((e, i) => {
        const owner = requestName("owner", e.issue, null, 1);
        const who = e.designOnly ? "（仅设计，owner 义务由主会话持有）" : `，owner 席位 ${owner}，工作目录 ${workDir(e.issue, owner)}`;
        return `${i + 1}. ${refText(e.issue)} → ${e.target.repo.owner}/${e.target.repo.name}@${e.target.base}${who}${e.adoptPr === null ? "" : `，接管 PR ${refText(e.adoptPr)}`}`;
      });
      return { ok: true, text: [`计划（未写入状态文件）：${parent === null ? "" : `parent ${refText(parent)}，`}按以下顺序交付：`, ...lines].join("\n") };
    }
    return this.#serial(async () => {
      if (this.#active !== null) return { ok: false, text: `本进程已在推进议程 ${this.#active}；一个进程只推进一份议程。` };
      const now = Date.now();
      const id = `ag-${now.toString(36)}-${Math.floor(Math.random() * 36 ** 4).toString(36)}` as AgendaId;
      const created = await this.#store.create(convene(id, now as Millis, parent, entries));
      if (!created.ok) return { ok: false, text: `召集失败：${created.error.kind}（${created.error.detail}）` };
      this.#active = id;
      return this.#started(ctx, id, "convene");
    });
  }

  async resume(ctx: ExtensionContext, input: unknown): Promise<PortResult> {
    if (ctx.agent.kind !== "main") return { ok: false, text: "只有主会话可以恢复议程。" };
    const parsed = parseResume(input);
    if (!parsed.ok) return { ok: false, text: parsed.error };
    const refusal = await spawnPremise(ctx);
    if (refusal !== null) return { ok: false, text: refusal };
    return this.#serial(async () => {
      if (this.#active !== null) return { ok: false, text: `本进程已在推进议程 ${this.#active}。` };
      const loaded = await this.#store.load(parsed.value.agenda);
      if (!loaded.ok) return { ok: false, text: `无法接手议程 ${parsed.value.agenda}：${loaded.error.kind}（${loaded.error.detail}）` };
      this.#active = parsed.value.agenda;
      return this.#started(ctx, parsed.value.agenda, "resume");
    });
  }

  /** First round after convene/resume, inside the serial section. */
  async #started(ctx: ExtensionContext, agenda: AgendaId, reason: Trigger): Promise<PortResult> {
    const round = await this.#roundAndDeliver(reason, false);
    if (round.kind !== "derived") return { ok: false, text: `议程 ${agenda} 已${reason === "convene" ? "召集" : "接手"}，但首轮推导没有结果：${roundProblem(round)}` };
    const held = Roundtable.held(round.derived, ctx.agent.kind === "main" ? { kind: "main" } : { kind: "sub", agentId: ctx.agent.id });
    return {
      ok: true,
      text: [
        `议程 ${agenda} 已${reason === "convene" ? "召集" : "接手"}；状态只保存在本机的状态文件里。此后按注入的票据行动。`,
        held.length === 0 ? "你当前不持有票据。" : `你当前持有 ${held.length} 张票据：`,
        ...held.map((o) => `---\n${o.brief}`),
      ].join("\n\n"),
    };
  }

  /** C2: `(ctx.agent, payload)` → step → write only on `next`; then a round so the reply's consequences run before returning. */
  async reply(ctx: ExtensionContext, ticket: unknown, payload: unknown): Promise<PortResult> {
    const parsed = parseReply(ticket, payload);
    if (!parsed.ok) return { ok: false, text: `回复格式不符：${parsed.error}` };
    const reply = parsed.value;
    const caller = callerOf(ctx);
    return this.#serial(async () => {
      const agenda = this.#active;
      if (agenda === null) return { ok: false, text: "本进程当前没有进行中的议程，无法接受回复。" };
      const loaded = await this.#store.load(agenda);
      if (!loaded.ok) return { ok: false, text: `读取状态文件失败（${loaded.error.kind}：${loaded.error.detail}）；回复没有生效，稍后重发同一回复。` };
      const state = loaded.value;
      const read = await this.#store.facts(state);
      if (!read.ok) return { ok: false, text: `读取 GitHub 失败（${read.error.kind}：${read.error.detail}）；回复没有生效，稍后重发同一回复。` };
      const host = this.#host();
      const policy = this.#policy();
      const inputs = await this.#replyInputs(state, read.value, host, reply);
      if (!inputs.ok) return { ok: false, text: inputs.text };
      const event: StepEvent = { kind: "reply", caller, reply, live: inputs.live, at: Date.now() as Millis };
      const t = step(state, inputs.facts, host, policy, event);
      switch (t.kind) {
        case "rejected":
          return { ok: false, text: `圆桌拒绝了这条回复：${t.reason}` };
        case "same":
          return { ok: true, text: "已生效：状态里已经是这条回复，没有任何写入。" };
        case "next": {
          const saved = await this.#store.save(t.state);
          if (!saved.ok) return { ok: false, text: `写入状态文件失败（${saved.error.kind}：${saved.error.detail}）；票据仍未完结，请重发同一回复。` };
          const round = await this.#roundAndDeliver("reply", caller.kind !== "main");
          const remaining = round.kind === "derived" ? Roundtable.held(round.derived, caller.kind === "main" ? { kind: "main" } : { kind: "sub", agentId: caller.agentId }) : [];
          return {
            ok: true,
            text: [
              `已接受（状态版本 ${t.state.version}）。`,
              remaining.length === 0 ? "你当前不再持有票据。" : `你仍持有 ${remaining.length} 张票据：${remaining.map((o) => `${o.id}（${o.kind}）`).join("、")}；完整简报随下一次请求注入。`,
            ].join("\n"),
          };
        }
        default:
          return assertNever(t);
      }
    });
  }

  /** Live facts a reply is checked against: a PrSubmit's branch, a postMerge verdict's observed commits. */
  async #replyInputs(state: AgendaState, facts: Facts, host: Host, reply: Reply): Promise<{ ok: true; facts: Facts; live: LiveFacts } | { ok: false; text: string }> {
    const none: LiveFacts = { branchHead: null, branchContains: [] };
    const c = derive(state, facts, host, this.#policy()).classified;
    if (reply.kind === "prSubmit") {
      const member = c.member;
      if (member === null) return { ok: true, facts, live: none };
      const live = await this.#store.live(member.w.entry.target.repo, reply.branch, member.w.designCommits);
      if (!live.ok) return { ok: false, text: `读取分支 ${reply.branch} 的实时事实失败（${live.error.kind}：${live.error.detail}）；稍后重发同一回复。` };
      return { ok: true, facts, live: live.value };
    }
    if (reply.kind === "verdict" && reply.verdict.gate === "postMerge" && c.verification !== null && c.verification.w.manifest.gate === "postMerge") {
      const merges = c.verification.w.manifest.merges;
      const pairs: CommitPair[] = reply.verdict.observed.flatMap((o) =>
        merges.filter((m) => m.repo.owner === o.repo.owner && m.repo.name === o.repo.name).map((m) => ({ repo: m.repo, ancestor: m.commit, descendant: o.commit })),
      );
      const held = await this.#store.contained(pairs);
      if (!held.ok) return { ok: false, text: `读取提交包含关系失败（${held.error.kind}：${held.error.detail}）；稍后重发同一回复。` };
      return { ok: true, facts: { ...facts, commits: { ...facts.commits, contains: [...facts.commits.contains, ...held.value] } }, live: none };
    }
    return { ok: true, facts, live: none };
  }
}

function nudge(held: readonly Obligation[]): string {
  return [
    `[圆桌] 你持有 ${held.length} 张待回复的票据：${held.map((o) => `${o.id}（${o.kind}）`).join("、")}。`,
    "完整简报已随每次请求注入你的上下文。按简报行动，完成后用 `roundtable` 工具 op \"reply\" 回复；只有被圆桌接受的回复才算消费票据。",
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
    case "error":
      return `推导出错：${round.message}`;
    default:
      return assertNever(round);
  }
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
