// omp entry point. The factory runs once per session binding (main and every subagent), and the host imports the
// extension afresh for each load (`loadLegacyPiModule` appends a new `?mtime=` tag), so module-level state is NOT shared
// between sessions. The one Roundtable per process therefore lives in a process-global slot; each binding contributes
// its own sendUserMessage.

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { z, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { join } from "node:path";
import { createStore, GhGitHub } from "../store/index.ts";
import { Roundtable, type PortResult } from "./roundtable.ts";
import { parseSettings, PLUGIN_NAME } from "./settings.ts";

const SLOT = Symbol.for("omp-roundtable.roundtable");
const processSlot = globalThis as typeof globalThis & { [SLOT]?: Promise<Roundtable> };

async function create(): Promise<Roundtable> {
  const agentDir = getAgentDir();
  const settings = parseSettings(await getPluginSettings(PLUGIN_NAME, process.cwd()), process.env, agentDir);
  const store = createStore(new GhGitHub(Bun.which("gh") ?? "gh"), join(settings.dataDir, "state"));
  const rt = new Roundtable({ store, settings, appendSystemPath: join(agentDir, "APPEND_SYSTEM.md") });
  // Registry changes of seat agents are a derivation trigger (design「进程视图」) — only those core can observe: a seat
  // appears or disappears, or becomes parked/aborted. running↔idle flips are the same `live` status to core.
  AgentRegistry.global().onChange((event) => {
    if (event.ref.kind !== "sub" || event.ref.parentId !== MAIN_AGENT_ID) return;
    if (event.type === "registered" || event.type === "removed" || (event.type === "status_changed" && (event.ref.status === "parked" || event.ref.status === "aborted")))
      void rt.trigger("registry");
  });
  return rt;
}

const PORT_DESCRIPTION = [
  "圆桌端口：圆桌协议的唯一渠道。你的身份由宿主确定，参数里没有身份字段。",
  "- op \"tickets\"：列出你当前持有的票据与完整简报（简报也会随每次请求自动注入）。",
  "- op \"reply\"：回复一张票据。ticket = 票据 id（ob-…）；reply = 回复载荷，形状同 core 的 Reply（不含 obligation）：",
  "  {kind:\"prSubmit\", branch, head(40位sha), title, body, template:\"fourLayer\"|\"docOnly\", retryNote?}",
  "  {kind:\"claim\", claim:{kind:\"question\", context, reproduction, readings:[a,b], earliestGap, proposal} | {kind:\"noCode\", member, evidence} | {kind:\"split\", member, proposal} | {kind:\"blocked\", member, category, attempts}}",
  "  {kind:\"verdict\", ok:true|false, note}：gate 票据（review、accept、postMerge、closure）只回复通过或不通过，note 写理由；head、验收行、观察到的提交由程序按票据 pin 盖入。",
  "  {kind:\"decision\", decision:<下列之一>, rationale, drafts?:Draft[], bodyReplacements?:[{issue, baseHash, body}]}；主会话不持票据主动提出 noCode 时 ticket 为 null。decision 按 subject 取值（主张 id、结论 id 形如 re-…，事件 id、pin 字段取自票据简报）：",
  "    {subject:\"question\", claim:<主张id>, verdict:{kind:\"answered\"|\"outOfDomain\"|\"implDefect\"|\"acceptanceMethod\"} | {kind:\"designGap\", route}, affected:[<issue>]}",
  "    {subject:\"noCodeClaim\"|\"splitClaim\", claim, member:<issue>, bodyHash, verdict:\"confirmed\"|\"refuted\"}；{subject:\"blockedClaim\", claim, verdict:\"replacePr\"|\"external\"|\"refuted\"}",
  "    {subject:\"findings\", verdictId, verdict:{kind:\"upheld\", responsible:\"owner\"|\"main\"} | {kind:\"rejected\", basis} | {kind:\"outOfScope\", draft} | {kind:\"designGap\", route} | {kind:\"acceptanceMethod\"}}",
  "    {subject:\"closed\", member, event, bodyHash, verdict:\"confirmedNoCode\"|\"reopen\"}；{subject:\"reopened\", member, event, verdict:\"restore\"|\"correction\"|\"reopenAccepted\"}",
  "    {subject:\"checks\", pr:<issue形状>, runId, verdict:\"rerun\"|\"fixNeeded\"|\"external\"}；{subject:\"postMergeFail\"|\"closureFail\", verdictId, verdict:\"correction\"|\"reverify\"}",
  "    {subject:\"orphanDesign\"|\"migration\"|\"agendaGap\"|\"stall\", key, verdict:\"resolved\"|\"external\"}；{subject:\"effectFailed\", effect:<票据id>, failedAt:<毫秒>, verdict:\"retry\"|\"external\"}",
  "    {subject:\"designFix\", verdictId, commit}；{subject:\"report\", summary}；{subject:\"noCode\", member, bodyHash, reason}",
  "    {subject:\"seated\", requestName, previous:<agentId>|null, agentId}；{subject:\"woken\", agentId, parkedSince:<票据 pin 的 parkedSince，毫秒>}",
  "    Draft = {index, repo:{owner,name}, title, body, anchor:{kind:\"before\"|\"after\"|\"correctionOf\", entry:<issue>}|{kind:\"outsideAgenda\"}, target:{repo, base}, designOnly}；route = {kind:\"defaultFirst\", commit, migration:<issue>|null} | {kind:\"withPr\", commit, designBranch} | {kind:\"future\", commit, carrier:<issue>}",
  "  claim 的 context：{kind:\"member\", member:<issue>} | {kind:\"unitVerification\", unit:<issue>} | {kind:\"agendaClosure\"}；member、unit 等 issue 引用写作 {repo:{owner,name}, number}。",
  "  reply、convene、resume 传 JSON 对象（传 JSON 字符串也会被解码）。字段与取值以票据简报为准。",
  "- op \"convene\"（仅主会话）：convene = {mode:\"plan\"|\"execute\", parent:\"owner/name#N\"|null, entries:[{issue:\"owner/name#N\", target:{repo:\"owner/name\", base}, designOnly?, adoptPr?:\"owner/name#N\"|null}]}，entries 按交付顺序。议程只保存在本机状态文件里，GitHub 上不建议程 issue；返回议程 id（ag-…）。",
  "- op \"resume\"（仅主会话，进程重启后接手已有议程）：resume = {agenda:\"ag-…\", operatorConfirmedOriginalSessionEnded:true}，必须是操作员对原会话已结束的确认。",
  "回复被拒绝时，理由原样返回；重发一条已生效的回复返回「已生效」，不产生任何写入。",
].join("\n");

const PortParams = z.object({
  op: z.enum(["tickets", "reply", "convene", "resume"]),
  ticket: z.string().nullable().optional(),
  reply: z.unknown().optional(),
  convene: z.unknown().optional(),
  resume: z.unknown().optional(),
});

/** Tool payloads arrive as objects, but models often send the same JSON as a string; decode it at the boundary. */
function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const TOOL = "roundtable";

export default async function roundtable(pi: ExtensionAPI): Promise<void> {
  processSlot[SLOT] ??= create();
  const rt = await processSlot[SLOT];

  /** The port tool is active in this session only in roundtable mode (main) or as a seat of the driven agenda. */
  const syncTool = async (ctx: ExtensionContext): Promise<void> => {
    const active = pi.getActiveTools();
    const has = active.includes(TOOL);
    const want = rt.sees(ctx);
    if (want && !has) await pi.setActiveTools([...active, TOOL]);
    if (!want && has) await pi.setActiveTools(active.filter((name) => name !== TOOL));
  };

  pi.registerTool({
    name: TOOL,
    label: "Roundtable",
    description: PORT_DESCRIPTION,
    loadMode: "essential",
    // Invisible until `/roundtable` (main) or seat binding (subagent) activates it.
    defaultInactive: true,
    approval: "write",
    parameters: PortParams,
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      rt.bind(pi, ctx);
      // The host validated `raw` against PortParams; parsing again only recovers its static type.
      const params = PortParams.parse(raw);
      let result: PortResult;
      switch (params.op) {
        case "tickets":
          result = await rt.tickets(ctx);
          break;
        case "reply":
          result = await rt.reply(ctx, params.ticket ?? null, decoded(params.reply));
          break;
        case "convene":
          result = await rt.convene(ctx, decoded(params.convene));
          break;
        case "resume":
          result = await rt.resume(ctx, decoded(params.resume));
          break;
        default:
          throw new Error(`unknown op ${JSON.stringify(params.op satisfies never)}`);
      }
      return { content: [{ type: "text", text: result.text }], isError: !result.ok };
    },
  });

  pi.registerCommand("roundtable", {
    description: "进入圆桌模式（显示 roundtable 端口工具）；`/roundtable off` 退出。只在主会话有效。",
    async handler(args, ctx) {
      if (ctx.agent.kind !== "main") return;
      rt.bind(pi, ctx);
      const refusal = rt.setMode(args.trim() !== "off");
      if (refusal !== null) {
        ctx.ui.notify(refusal, "warning");
        return;
      }
      await syncTool(ctx);
      ctx.ui.notify(rt.mode ? "圆桌模式：roundtable 端口工具已可用。" : "已退出圆桌模式。", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    rt.bind(pi, ctx);
    await syncTool(ctx);
    // Timer recompute, owned by the main session binding (cleared by the host at its session_shutdown).
    if (ctx.agent.kind === "main") ctx.setInterval(() => void rt.trigger("timer"), rt.recomputeIntervalMs);
  });
  pi.on("session_shutdown", (_event, ctx) => rt.unbind(ctx));

  pi.on("before_agent_start", async (event, ctx) => {
    if (ctx.agent.kind === "main") rt.observeSystemPrompt(event.systemPrompt);
    await syncTool(ctx);
  });

  // Ticket injection: appended for this request only, never written into the session history.
  pi.on("context", async (event, ctx) => {
    rt.bind(pi, ctx);
    const text = await rt.injection(ctx);
    if (text === null) return undefined;
    const message: AgentMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    return { messages: [...event.messages, message] };
  });

  // Receipt interception, subagents: `yield` is blocked while a ticket still needs its reply.
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (event.toolName !== "yield" || ctx.agent.kind !== "sub") return undefined;
    const reason = await rt.yieldBlock(ctx);
    return reason === null ? undefined : { block: true, reason };
  });

  // Receipt interception, main session: remind at the end of each settled turn while tickets remain.
  pi.on("agent_end", async (event, ctx) => {
    if (ctx.agent.kind !== "main" || event.willContinue === true) return;
    await rt.remindMain();
  });
}
