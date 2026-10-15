import { afterAll, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createAgenda, parseAgenda, tickets, transition,
  type Agenda, type Caller, type Event, type Facts, type Inputs, type ReplyResult, type Result,
} from '../src/domain/index.ts';
import { createAgendaFiles } from '../src/ports/state.ts';

const evidenceRoot = await mkdtemp('/tmp/rt-ports-crash-');
const domainUrl = new URL('../src/domain/index.ts', import.meta.url).href;
const stateUrl = new URL('../src/ports/state.ts', import.meta.url).href;

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`Unexpected result: ${JSON.stringify(result.error)}`);
  return result.value;
}

type CrashFixture = {
  before: Agenda;
  after: Agenda;
  reply: ReplyResult;
  input: Inputs;
  event: Event;
  workId: string;
};

/** Only public transitions create state, work, binding, receipt, and publish intent. */
function fixture(): CrashFixture {
  const repo = { owner: 'CrashBoundaryFixture', name: 'delivery' };
  const issue = { repo, number: 31 };
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const body = 'Deliver the durable caller-boundary example.';
  const main: Caller = {
    agentId: 'crash-main', sessionId: 'crash-main-session', parentId: null,
    runId: 'crash-run', kind: 'main', depth: 0,
  };
  const facts: Facts = {
    viewer: repo.owner,
    issues: [{
      ref: issue, body, bodyHash: createHash('sha256').update(body).digest('hex'),
      updatedAt: 1000, state: 'open', lastClose: null, lastReopen: null, children: [],
    }],
    prs: [], links: [],
    repos: [{ repo, defaultBranch: 'main', defaultHead: base, bases: [{
      name: 'main', state: {
        kind: 'present', head: base, isDefault: true,
        rules: { required: [], strict: false, upToDate: true, constraints: [] },
      },
    }] }],
    branches: [{ repo, name: 'durable-submit', state: { kind: 'present', head } }],
    maintenance: [], commits: [], checkAttempts: [], createdIssues: [],
  };
  const input: Inputs = {
    facts: { kind: 'available', generation: 1, observedAt: 1000, facts, scope: {
      issues: [issue], prs: [], repos: [{ repo, bases: ['main'] }],
      branches: [{ repo, name: 'durable-submit' }], commits: [], checkRuns: [],
      creations: [], maintenanceIntents: [],
    } },
    host: {
      runId: main.runId, main, seats: [], turnEnds: [],
      preflight: { ok: true, value: {
        asyncEnabled: true, isolationEnabled: true, asyncManager: true, gitCwd: evidenceRoot,
        agents: [{ name: 'fixture-owner', blocking: false }, { name: 'fixture-gate', blocking: false }],
      } },
    },
    policy: { text: 'Preserve the accepted delivery obligation.', ownerAgent: 'fixture-owner', gateAgent: 'fixture-gate' },
  };
  let state = unwrap(createAgenda({
    op: 'convene', mode: 'execute', parent: null,
    entries: [{ issue, target: { repo, base: 'main' }, designOnly: false, adoptPr: null }],
  }, facts, 1000, '7c000000-0000-4000-8000-000000000031'));
  function next(event: Event) {
    const result = transition(state, input, event);
    assert.equal(result.kind, 'next', JSON.stringify(result));
    if (result.kind !== 'next') throw new Error('Expected a public next transition');
    assert.equal(result.state.version, state.version + 1);
    state = result.state;
  }
  next({ kind: 'observe' });
  const work = state.units[0]?.members[0]?.work;
  assert(work, 'Observe must create an actual owner work');
  const ticket = tickets(state, input).find(item => item.id === `work:${work.id}`);
  assert(ticket && ticket.holder.kind === 'seat');
  const requestId = ticket.holder.requestId;
  const request = state.requests.find(item => item.id === requestId);
  assert(request);
  const owner: Caller = {
    agentId: 'crash-owner', sessionId: 'crash-owner-session', parentId: main.agentId,
    runId: main.runId, kind: 'sub', depth: 1,
  };
  input.host.seats = [{
    agentId: owner.agentId, sessionId: owner.sessionId, parentId: main.agentId,
    requestedName: request.name, createdAt: 1001, status: 'running', plan: 'disabled', streaming: false,
  }];
  next({ kind: 'reply', caller: main, ticket: `spawn:${request.id}`, revision: 1,
    payload: { kind: 'spawned', agentId: owner.agentId }, acceptedAt: 1002 });
  const before = unwrap(parseAgenda(state));
  const event: Event = {
    kind: 'reply', caller: owner, ticket: ticket.id, revision: ticket.revision, acceptedAt: 1003,
    payload: {
      kind: 'submit', branch: 'durable-submit', head, title: 'Deliver durable submission',
      body: `Implementation and independent evidence.\n\nCloses ${repo.owner}/${repo.name}#${issue.number}`,
      template: 'fourLayer', retryNote: null,
    },
  };
  const accepted = transition(before, input, event);
  assert(accepted.kind === 'next' && accepted.reply);
  assert.equal(accepted.state.version, before.version + 1);
  const member = accepted.state.units[0]?.members[0];
  assert(member?.ownerReceipt && member.ownerTerminal?.kind === 'submitted');
  assert.deepEqual(member.ownerReceipt.result, accepted.reply);
  assert(accepted.state.effects.some(effect => effect.action.kind === 'publishPr' && effect.state.kind === 'ready'));
  assert.equal(before.units[0]?.members[0]?.ownerReceipt, null);
  assert.equal(before.units[0]?.members[0]?.baseline.kind, 'none');
  assert.equal(before.effects.length, 0);
  return { before, after: accepted.state, reply: accepted.reply, input, event, workId: work.id };
}

async function snapshot(path: string) {
  const [bytes, metadata] = await Promise.all([readFile(path), stat(path, { bigint: true })]);
  return {
    bytes, inode: metadata.ino.toString(), mtimeNs: metadata.mtimeNs.toString(),
    size: metadata.size.toString(), mode: Number(metadata.mode & 0o777n),
  };
}

// IPC communicates internal test readiness only. No readiness message is a client receipt.
function startChild(script: string, mode: string) {
  const child = spawn(process.execPath, [script, mode], {
    cwd: evidenceRoot, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: string[] = [];
  const waiters = new Set<() => void>();
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.on('message', (message: unknown) => {
    if (typeof message === 'string') messages.push(message);
    for (const notify of waiters) notify();
  });
  let finished = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      finished = true;
      resolve({ code, signal });
      for (const notify of waiters) notify();
    });
  });
  async function waitFor(stage: string) {
    await new Promise<void>((resolve, reject) => {
      // Failure watchdog only: IPC, never elapsed time, selects the crash boundary.
      // This guard ensures a broken child is killed by finally instead of orphaned.
      const timeout = setTimeout(() => {
        finish(new Error(`Child never reached ${stage}; stdout=${stdout}; stderr=${stderr}`));
      }, 15_000);
      function finish(error?: Error) {
        clearTimeout(timeout);
        waiters.delete(check);
        if (error) reject(error); else resolve();
      }
      function check() {
        if (messages.includes(stage)) finish();
        else if (finished) finish(new Error(`Child exited before ${stage}; stdout=${stdout}; stderr=${stderr}`));
      }
      waiters.add(check);
      check();
    });
  }
  async function stop() {
    if (!finished) child.kill('SIGKILL');
    return await exited;
  }
  return { child, exited, waitFor, stop, messages, output: () => ({ stdout, stderr }) };
}

function childSource(dataDir: string, seed: CrashFixture) {
  // Literal fixture input avoids importing any test author's helpers or legacy fixtures.
  return `import assert from 'node:assert/strict';
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAgenda, transition, type Inputs, type Event, type ReplyResult } from ${JSON.stringify(domainUrl)};
import { createAgendaFiles } from ${JSON.stringify(stateUrl)};
const dataDir = ${JSON.stringify(dataDir)};
const beforeResult = parseAgenda(${JSON.stringify(seed.before)});
assert(beforeResult.ok);
const before = beforeResult.value;
const input: Inputs = ${JSON.stringify(seed.input)};
const event: Event = ${JSON.stringify(seed.event)};
const computed = transition(before, input, event);
assert(computed.kind === 'next' && computed.reply);
const expected = computed.state;
const originalReceipt = computed.reply;
const metrics = { replaces: 0, unchangedReplaces: 0 };
const files = createAgendaFiles(dataDir, metrics);
const path = join(dataDir, 'state', before.id + '.json');
const mode = process.argv[2];
function success<T, E>(result: {ok: true; value: T} | {ok: false; error: E}): T {
  assert(result.ok, JSON.stringify(result));
  return result.value;
}
async function tell(stage: string) {
  assert(process.send);
  await new Promise<void>((resolve, reject) => process.send!(stage, error => error ? reject(error) : resolve()));
}
async function image() {
  const [bytes, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path, { bigint: true })]);
  return { bytes, inode: metadata.ino.toString(), mtimeNs: metadata.mtimeNs.toString(),
    size: metadata.size.toString(), mode: Number(metadata.mode & 0o777n) };
}
try {
  const loaded = success(await files.load(before.id));
  if (mode === 'crash') {
    assert.deepEqual(loaded, before);
    // The handler exists before readiness, so continue-save cannot race its registration.
    const proceed = new Promise<void>(resolve => process.on('message', message => {
      if (message === 'continue-save') resolve();
    }));
    const next = transition(loaded, input, event);
    assert(next.kind === 'next' && next.reply);
    assert.deepEqual(next, computed);
    await tell('internal:before-save');
    await proceed;
    success(await files.save(loaded.version, next.state));
    assert.equal(metrics.replaces, 1);
    assert.equal(metrics.unchangedReplaces, 0);
    // save has returned only after actual file fsync, rename and directory fsync.
    // Deliberately do not deliver next.reply as an outward business response.
    await tell('internal:after-save-before-client-response');
    await new Promise<void>(() => {});
  } else {
    assert(mode === 'recover-before' || mode === 'recover-after');
    const saved = mode === 'recover-before' ? before : expected;
    assert.deepEqual(loaded, saved);
    assert.deepEqual(success(parseAgenda(loaded)), saved);
    assert.equal((await image()).mode, 0o600);
    let replayKind: string | null = null;
    let replayReceipt: ReplyResult | null = null;
    if (mode === 'recover-after') {
      // No source access is available: accepted replay must use the durable receipt.
      const replayInput: Inputs = { ...input, facts: { kind: 'unavailable', error: {
        kind: 'unavailable', message: 'Recovery replay deliberately has no source read',
      } } };
      const pristine = await image();
      const replay = transition(loaded, replayInput, event);
      assert.equal(replay.kind, 'same', JSON.stringify(replay));
      assert(replay.kind === 'same');
      assert.deepEqual(replay.reply, originalReceipt);
      assert.deepEqual(await image(), pristine);
      assert.equal(metrics.replaces, 0);
      replayKind = replay.kind;
      replayReceipt = replay.reply;
      // An exact immutable-target persistence retry also must not replace the file.
      // Old mtime makes an accidental same-byte rewrite observable without sleeps.
      await utimes(path, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
      const fixed = await image();
      for (const expectedVersion of [before.version, loaded.version, null]) {
        success(await files.save(expectedVersion, loaded));
        assert.deepEqual(await image(), fixed);
      }
      assert.deepEqual(success(await createAgendaFiles(dataDir).load(before.id)), expected);
    }
    assert.equal(metrics.replaces, 0);
    assert.equal(metrics.unchangedReplaces, 0);
    await writeFile(join(dataDir, 'recovery-evidence.json'), JSON.stringify({
      pid: process.pid, mode, version: loaded.version, metrics, replayKind, replayReceipt,
      image: await image(),
    }, null, 2) + '\\n');
    await tell('internal:recovery-verified');
    process.disconnect();
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
`;
}

afterAll(() => console.info(`AgendaFiles child-crash evidence: ${evidenceRoot}`));

describe('actual AgendaFiles caller-boundary process crashes', () => {
  for (const boundary of ['before-save', 'after-save'] as const) {
    test(`${boundary}: SIGKILL preserves the exact old or accepted complete snapshot`, async () => {
      const dataDir = await mkdtemp(join(evidenceRoot, `${boundary}-`));
      const seed = fixture();
      const setupMetrics = { replaces: 0, unchangedReplaces: 0 };
      const files = createAgendaFiles(dataDir, setupMetrics);
      unwrap(await files.save(null, seed.before));
      expect(setupMetrics).toEqual({ replaces: 1, unchangedReplaces: 0 });
      const path = join(dataDir, 'state', `${seed.before.id}.json`);
      await utimes(path, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
      const previous = await snapshot(path);
      const script = join(dataDir, 'child.ts');
      await writeFile(script, childSource(dataDir, seed));
      const child = startChild(script, 'crash');
      let crashExit;
      try {
        await child.waitFor('internal:before-save');
        // At readiness the accepted next exists only in memory, not in the real file.
        expect(await snapshot(path)).toEqual(previous);
        if (boundary === 'after-save') {
          child.child.send('continue-save');
          await child.waitFor('internal:after-save-before-client-response');
        }
        expect(child.child.kill('SIGKILL')).toBe(true);
        crashExit = await child.exited;
        expect(crashExit).toEqual({ code: null, signal: 'SIGKILL' });
      } finally {
        await child.stop();
      }
      const expected: Agenda = boundary === 'before-save' ? seed.before : seed.after;
      const loaded = unwrap(await createAgendaFiles(dataDir).load(expected.id));
      expect(loaded).toEqual(expected);
      expect(unwrap(parseAgenda(loaded))).toEqual(expected);
      expect(loaded.version).toBe(expected.version);
      expect((await snapshot(path)).mode).toBe(0o600);
      expect(await readdir(join(dataDir, 'state'))).toEqual([`${expected.id}.json`]);
      const member = loaded.units[0]!.members[0]!;
      if (boundary === 'before-save') {
        expect(await snapshot(path)).toEqual(previous);
        expect(member.work?.id).toBe(seed.workId);
        expect(member.ownerReceipt).toBeNull();
        expect(member.ownerTerminal).toBeNull();
        expect(member.baseline.kind).toBe('none');
        expect(loaded.effects).toEqual([]);
      } else {
        expect(member.work).toBeNull();
        expect(member.ownerReceipt?.result).toEqual(seed.reply);
        expect(member.ownerTerminal?.kind).toBe('submitted');
        expect(member.baseline.kind).toBe('submitted');
        expect(loaded.effects.filter(effect => effect.action.kind === 'publishPr' && effect.state.kind === 'ready')).toHaveLength(1);
        expect((await snapshot(path)).inode).not.toBe(previous.inode);
      }
      const durable = await snapshot(path);
      const recovery = startChild(script, `recover-${boundary === 'before-save' ? 'before' : 'after'}`);
      let recoveryExit;
      try {
        await recovery.waitFor('internal:recovery-verified');
        recoveryExit = await recovery.exited;
        expect(recoveryExit).toEqual({ code: 0, signal: null });
      } finally {
        await recovery.stop();
      }
      const final = await snapshot(path);
      expect(final.bytes).toEqual(durable.bytes);
      expect(final.inode).toBe(durable.inode);
      expect(final.mode).toBe(0o600);
      if (boundary === 'before-save') expect(final).toEqual(durable);
      else expect(final.mtimeNs).toBe('978307200000000000');
      expect(unwrap(await createAgendaFiles(dataDir).load(expected.id))).toEqual(expected);
      await writeFile(join(dataDir, 'crash-evidence.json'), JSON.stringify({
        boundary, crashPid: child.child.pid, recoveryPid: recovery.child.pid,
        crashExit, recoveryExit, readiness: child.messages, recoveryReadiness: recovery.messages,
        beforeVersion: seed.before.version, recoveredVersion: expected.version,
        originalReceipt: seed.reply, readyEffectIds: expected.effects.filter(effect => effect.state.kind === 'ready').map(effect => effect.id),
        setupMetrics, durableFile: path, crashOutput: child.output(), recoveryOutput: recovery.output(),
        covered: boundary === 'before-save' ? 'computed next, before files.save call' : 'awaited files.save success, before outward accepted reply',
        notProved: ['crash between rename and directory fsync', 'power-loss durability', 'full controller or native host recovery'],
      }, null, 2) + '\n');
    }, 30_000);
  }
});
