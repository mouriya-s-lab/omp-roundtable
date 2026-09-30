// Host reads (C5): registry agents, caller identity, and the spawn premise. Queried on demand, never stored.
// Host modules are imported through package paths only, so they resolve to the CLI runtime singletons.

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry, MAIN_AGENT_ID, type AgentStatus } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { stripSuffix, type AgentId, type Author, type Caller, type RegisteredAgent, type RegistryStatus } from "../core/index.ts";

function registryStatus(status: AgentStatus): RegistryStatus {
  switch (status) {
    case "running":
    case "idle":
      return "live";
    case "parked":
      return "parked";
    case "aborted":
      return "aborted";
    default:
      return assertNever(status);
  }
}

/**
 * `host.agents`: the subagents the main session spawned — seats are only ever spawned by main's native `task`
 * (design「派出」). A seat's own helpers (`rt-…-a1.ReviewPlanMentor`, depth 2) share the `rt-` prefix but are not seats.
 */
export function readAgents(): RegisteredAgent[] {
  return AgentRegistry.global()
    .list()
    .filter((ref) => ref.kind === "sub" && ref.parentId === MAIN_AGENT_ID)
    .map((ref) => ({ id: ref.id as AgentId, requestName: stripSuffix(ref.id), status: registryStatus(ref.status) }));
}

/** Registry ids of subagents whose session is alive and not running a turn. */
export function idleSubagents(): readonly string[] {
  return AgentRegistry.global()
    .list()
    .filter((ref) => ref.kind === "sub" && ref.status === "idle" && ref.session !== null)
    .map((ref) => ref.id);
}

/**
 * The caller as `admit` sees it. Identity comes only from the host: `ctx.agent`, and for a subagent the registry entry
 * for `ctx.agent.id`, whose session must be the calling session (evidence: `session.sessionManager === ctx.sessionManager`).
 */
export function callerOf(ctx: ExtensionContext): Caller {
  if (ctx.agent.kind === "main") return { kind: "main" };
  const ref = AgentRegistry.global().get(ctx.agent.id);
  return { kind: "sub", agentId: ctx.agent.id as AgentId, sessionMatches: ref?.session?.sessionManager === ctx.sessionManager };
}

export function authorOf(caller: Caller): Author {
  return caller.kind === "main" ? { kind: "main" } : { kind: "seat", agentId: caller.agentId, requestName: stripSuffix(caller.agentId) };
}

/** Agent types seat requests name (core `SeatBinding.agent`). */
const SEAT_AGENT_TYPES = ["task:high", "task:mid"] as const;

/**
 * Spawn premise (design「派出的前提」): the main session's `task` must run asynchronously — host setting `async.enabled`
 * (`tools/settings.ts` `cfgAsyncEnabled`) — and no seat agent type may declare `blocking: true`. Returns the refusal reason.
 */
export async function spawnPremise(ctx: ExtensionContext): Promise<string | null> {
  const session = AgentRegistry.global().get(ctx.agent.id)?.session ?? null;
  if (session === null) return `无法读取主会话 ${ctx.agent.id} 的设置，不能确认异步 task 已开启。`;
  if (!cfgAsyncEnabled.get(session))
    return "召集被拒绝：需要开启异步 task（宿主设置 async.enabled 当前为 false）。否则主会话派出席位后会同步等待，子席位一提问就会死锁。请在配置里设 async.enabled: true 后重新召集。";
  const { agents } = await discoverAgents(ctx.cwd);
  for (const type of SEAT_AGENT_TYPES) {
    const def = agents.find((a) => a.name === type);
    if (def === undefined) return `召集被拒绝：找不到席位所需的 agent 类型 ${type}。`;
    if (def.blocking === true) return `召集被拒绝：agent 类型 ${type} 声明了 blocking: true，派出时主会话会同步等待，席位提问时会死锁。`;
  }
  return null;
}

function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
