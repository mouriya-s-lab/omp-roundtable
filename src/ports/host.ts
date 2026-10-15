import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { AgentRegistry, MAIN_AGENT_ID, type AgentRef } from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import { AgentLifecycleManager } from '@oh-my-pi/pi-coding-agent/registry/agent-lifecycle';
import { discoverAgents, getAgent } from '@oh-my-pi/pi-coding-agent/task/discovery';
import { cfgTaskIsolationEnabled } from '@oh-my-pi/pi-coding-agent/task/settings';
import { cfgAsyncEnabled } from '@oh-my-pi/pi-coding-agent/tools/settings';
import type { Caller, HostObservation, HostSeat, PortError, Result, SeatRequest } from '../domain/model.ts';
import type { DeliveryReceipt, HostPort, WakeInput } from './contracts.ts';

const runFile = promisify(execFile);
type SessionManager = ExtensionContext['sessionManager'];
type Binding = { caller: Caller; manager: SessionManager; status: 'bound' | 'released' };
type Preflight = HostObservation['preflight'];
type Message = HostObservation['turnEnds'][number];
type Validated = { manager: SessionManager; result: Preflight };

function failure(kind: Exclude<PortError['kind'], 'rateLimited'>, message: string): { ok: false; error: PortError } {
  return { ok: false, error: { kind, message } };
}

function sourceError(prefix: string, error: unknown, kind: 'unavailable' | 'uncertainOutcome' = 'unavailable'): { ok: false; error: PortError } {
  const detail = error instanceof Error ? error.message : 'Native host operation failed';
  const sanitized = detail
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
  return failure(kind, `${prefix}: ${sanitized}`);
}

function sameCaller(a: Caller, b: Caller): boolean {
  return a.agentId === b.agentId && a.sessionId === b.sessionId && a.parentId === b.parentId
    && a.runId === b.runId && a.kind === b.kind && a.depth === b.depth;
}

function sameRequest(a: SeatRequest, b: SeatRequest, revivedSessionId: string): boolean {
  if (a.binding.kind !== 'bound' || b.binding.kind !== 'bound') return false;
  return a.id === b.id && a.runId === b.runId && a.name === b.name && a.role === b.role
    && JSON.stringify(a.context) === JSON.stringify(b.context)
    && a.binding.agentId === b.binding.agentId
    && (a.binding.sessionId === b.binding.sessionId || b.binding.sessionId === revivedSessionId)
    && a.binding.parentId === b.binding.parentId;
}

function requestMatches(request: SeatRequest, input: WakeInput, binding: Binding): boolean {
  const holder = request.binding;
  const contextMatches = request.role === 'postMerge' ? request.context.kind === 'unit'
    : request.role === 'closure' ? request.context.kind === 'agenda' : request.context.kind === 'member';
  // The native allocator preserves the exact requested id, adding only -2, -3, ... on collision.
  const nameMatches = input.agentId === request.name
    || (input.agentId.startsWith(`${request.name}-`) && /^[2-9]\d*$|^1\d+$/.test(input.agentId.slice(request.name.length + 1)));
  return contextMatches && nameMatches && request.id === input.requestId && request.runId === input.runId
    && holder.kind === 'bound' && holder.agentId === input.agentId && holder.parentId === input.parentId
    && holder.sessionId === binding.caller.sessionId && binding.caller.agentId === input.agentId
    && binding.caller.runId === input.runId && binding.caller.parentId === input.parentId
    && binding.caller.kind === 'sub' && binding.caller.depth === 1;
}

/** Native registry/session objects remain authoritative; only local identity indexes live here. */
export function createHostPort(readRequest: (requestId: string) => SeatRequest | undefined): HostPort {
  const registry = AgentRegistry.global();
  const lifecycle = AgentLifecycleManager.global();
  const bindings = new Map<string, Binding>();
  let sessionIds = new WeakMap<SessionManager, string>();
  const messages = new Map<string, Message>();
  const turnEnds = new Map<string, Message>();
  let validated: Validated | undefined;
  let disposed = false;

  function sessionId(manager: SessionManager): string {
    let id = sessionIds.get(manager);
    if (!id) { id = randomUUID(); sessionIds.set(manager, id); }
    return id;
  }

  function depthOf(ref: AgentRef): number | undefined {
    const seen = new Set<string>();
    let current: AgentRef | undefined = ref;
    let depth = 0;
    while (current?.kind !== 'main') {
      if (!current || seen.has(current.id) || current.kind !== 'sub' || !current.parentId) return undefined;
      seen.add(current.id);
      current = registry.get(current.parentId);
      depth++;
    }
    return current.id === MAIN_AGENT_ID ? depth : undefined;
  }

  function mainSession(): Result<NonNullable<AgentRef['session']>, PortError> {
    if (disposed) return failure('unavailable', 'Native HostPort has been disposed');
    const ref = registry.get(MAIN_AGENT_ID);
    const binding = bindings.get(MAIN_AGENT_ID);
    if (!ref || ref.kind !== 'main' || ref.status === 'aborted' || !ref.session
      || !binding || binding.status !== 'bound' || binding.manager !== ref.session.sessionManager)
      return failure('precondition', 'The current Main native session is not bound');
    return { ok: true, value: ref.session };
  }

  function settingsPreflight(session: NonNullable<AgentRef['session']>): Result<null, PortError> {
    if (!lifecycle.manages(registry)) return failure('precondition', 'Native lifecycle does not own the current registry');
    if (cfgAsyncEnabled.get(session.settings) !== true) return failure('precondition', 'Main async.enabled must be true');
    if (session.asyncJobManager === undefined) return failure('precondition', 'Main native async job manager is unavailable');
    if (cfgTaskIsolationEnabled.get(session.settings) !== true) return failure('precondition', 'Main task isolation must be true');
    if (session.getPlanModeState()?.enabled === true) return failure('precondition', 'Main plan mode cannot convene isolated execution');
    return { ok: true, value: null };
  }

  function currentPreflight(): Preflight {
    const main = mainSession();
    if (!main.ok) return main;
    const settings = settingsPreflight(main.value);
    if (!settings.ok) return settings;
    if (!validated || validated.manager !== main.value.sessionManager)
      return failure('precondition', 'Main cwd and effective seat agents have not been validated for this native session');
    return validated.result;
  }

  return {
    bind(ctx, runId) {
      try {
        if (disposed) return failure('unavailable', 'Native HostPort has been disposed');
        const ref = registry.get(ctx.agent.id);
        if (!ref || ref.kind === 'advisor' || ref.status === 'aborted' || !ref.session
          || ref.session.sessionManager !== ctx.sessionManager || ref.kind !== ctx.agent.kind)
          return failure('precondition', 'Caller does not match the current native registry session');
        const depth = depthOf(ref);
        if (depth === undefined || depth !== ctx.agent.depth)
          return failure('precondition', 'Caller does not belong to the current native Main agent tree');
        const caller: Caller = { agentId: ref.id, sessionId: sessionId(ctx.sessionManager), parentId: ref.parentId ?? null, runId, kind: ref.kind, depth };
        const previous = bindings.get(ref.id);
        if (previous && previous.caller.runId !== runId) { messages.delete(ref.id); turnEnds.delete(ref.id); }
        bindings.set(ref.id, { caller, manager: ctx.sessionManager, status: 'bound' });
        return { ok: true, value: caller };
      } catch (error) { return sourceError('Cannot bind native session', error); }
    },
    release(ctx) {
      const binding = bindings.get(ctx.agent.id);
      if (!binding || binding.manager !== ctx.sessionManager) return;
      // Keep only the last identity for authorization of this holder's legitimate parked revival.
      binding.status = 'released';
      if (ctx.agent.id === MAIN_AGENT_ID) validated = undefined;
    },
    observe(runId, main) {
      try {
        const actualMain = mainSession();
        if (!actualMain.ok) return actualMain;
        const binding = bindings.get(MAIN_AGENT_ID);
        if (!binding || main.runId !== runId || !sameCaller(binding.caller, main))
          return failure('precondition', 'Observation Main/run does not match the bound native session');
        const seats: HostSeat[] = registry.list().filter(ref => ref.kind !== 'advisor').map(ref => ({
          agentId: ref.id,
          requestedName: ref.id,
          parentId: ref.parentId ?? null,
          sessionId: ref.session ? sessionId(ref.session.sessionManager) : null,
          createdAt: ref.createdAt,
          status: ref.status,
          plan: ref.session ? ref.session.getPlanModeState()?.enabled === true ? 'enabled' : 'disabled' : 'unavailable',
          streaming: ref.session?.isStreaming ?? false,
        }));
        return { ok: true, value: { runId, main, seats, turnEnds: [...turnEnds.values()].filter(end => end.runId === runId), preflight: currentPreflight() } };
      } catch (error) { return sourceError('Cannot observe native registry', error); }
    },
    async validate(cwd, agents) {
      const main = mainSession();
      if (!main.ok) return main;
      const manager = main.value.sessionManager;
      validated = undefined;
      try {
        const settings = settingsPreflight(main.value);
        if (!settings.ok) { validated = { manager, result: settings }; return settings; }
        if (resolve(cwd) !== resolve(manager.getCwd())) return failure('precondition', 'Requested Git cwd differs from the actual Main session cwd');
        const git = await runFile('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
        if (git.stdout.trim() !== 'true') return failure('precondition', 'Main cwd is not a Git working tree');
        const discovery = await discoverAgents(cwd, undefined, main.value.effectiveExtensionRoots);
        const effectiveAgents = [...discovery.agents, ...main.value.getSessionAgents()];
        const accepted: { name: string; blocking: false }[] = [];
        for (const name of new Set(agents)) {
          const agent = getAgent(effectiveAgents, name);
          if (!agent) return failure('precondition', `Configured seat agent is not available through native discovery: ${name}`);
          if (agent.blocking === true) return failure('precondition', `Configured seat agent is blocking: ${name}`);
          accepted.push({ name, blocking: false });
        }
        const current = mainSession();
        if (!current.ok) return current;
        if (current.value !== main.value) return failure('precondition', 'Main native session changed during preflight');
        const fresh = settingsPreflight(current.value);
        if (!fresh.ok) return fresh;
        const result: Preflight = { ok: true, value: { asyncEnabled: true, isolationEnabled: true, asyncManager: true, gitCwd: resolve(cwd), agents: accepted } };
        validated = { manager, result };
        return result;
      } catch (error) {
        const result = sourceError('Native preflight failed', error);
        validated = { manager, result };
        return result;
      }
    },
    async wake(input) {
      let deliveryStarted = false;
      try {
        if (disposed) return failure('unavailable', 'Native HostPort has been disposed');
        const main = mainSession();
        if (!main.ok) return main;
        const mainBinding = bindings.get(MAIN_AGENT_ID);
        const request = readRequest(input.requestId);
        const binding = bindings.get(input.agentId);
        const ref = registry.get(input.agentId);
        if (!mainBinding || mainBinding.caller.runId !== input.runId || input.parentId !== MAIN_AGENT_ID
          || !request || !binding || !requestMatches(request, input, binding)
          || !ref || ref.kind !== 'sub' || ref.parentId !== input.parentId || ref.status === 'aborted')
          return failure('precondition', 'Wake does not match the current accepted native request/run/parent/holder binding');
        if (ref.session && (binding.status !== 'bound' || ref.session.sessionManager !== binding.manager))
          return failure('precondition', 'Wake holder session differs from the accepted bound native session');
        if (!ref.session && ref.status !== 'parked')
          return failure('precondition', 'Wake holder has no live session and is not parked');
        const target = await lifecycle.ensureLive(input.agentId);
        const targetSessionId = sessionId(target.sessionManager);
        const freshRef = registry.get(input.agentId);
        const freshRequest = readRequest(input.requestId);
        const freshMain = mainSession();
        if (!freshMain.ok) return freshMain;
        if (disposed || !freshRequest || !sameRequest(request, freshRequest, targetSessionId) || freshRef !== ref
          || freshRef.parentId !== input.parentId || freshRef.status === 'aborted' || freshRef.session !== target
          || bindings.get(MAIN_AGENT_ID)?.caller.runId !== input.runId)
          return failure('precondition', 'Native holder/request ownership changed while ensuring the session is live');
        // No asynchronous gap is allowed between this real-session precheck and direct delivery.
        if (target.getPlanModeState()?.enabled === true && !target.isStreaming)
          return failure('precondition', 'Native wake target is idle in plan mode');
        const message: Message = { agentId: input.agentId, runId: input.runId, messageId: input.messageId };
        messages.set(input.agentId, message);
        turnEnds.delete(input.agentId);
        deliveryStarted = true;
        const outcome = await target.deliverIrcMessage({ id: input.messageId, from: MAIN_AGENT_ID, to: input.agentId, body: input.body, ts: input.startedAt });
        if (outcome !== 'injected' && outcome !== 'woken') return failure('uncertainOutcome', 'Native direct delivery returned an invalid receipt');
        const receipt: DeliveryReceipt = { agentId: input.agentId, messageId: input.messageId, outcome };
        return { ok: true, value: receipt };
      } catch (error) { return sourceError('Native wake failed', error, deliveryStarted ? 'uncertainOutcome' : 'unavailable'); }
    },
    noteTurnEnd(agentId, runId, messageId) {
      const current = messages.get(agentId);
      const binding = bindings.get(agentId);
      if (disposed || !current || current.runId !== runId || current.messageId !== messageId || binding?.caller.runId !== runId) return;
      turnEnds.set(agentId, current);
    },
    dispose() {
      disposed = true;
      bindings.clear();
      sessionIds = new WeakMap();
      messages.clear();
      turnEnds.clear();
      validated = undefined;
    },
  };
}
