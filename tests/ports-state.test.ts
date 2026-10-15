import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createAgenda,
  parseAgenda,
  transition,
  type Agenda,
  type Event,
  type Facts,
  type Inputs,
  type Result,
} from '../src/domain/index.ts';
import { createAgendaFiles } from '../src/ports/state.ts';

const evidenceRoot = await mkdtemp('/tmp/rt-ports-state-');
const agendaId = '1b000000-0000-4000-8000-000000000001';
const otherAgendaId = '1b000000-0000-4000-8000-000000000002';
const missingAgendaId = '1b000000-0000-4000-8000-000000000003';
const repo = { owner: 'storage-fixture', name: 'roundtable' };
const first = { repo, number: 11 };
const second = { repo, number: 12 };
const target = { repo, base: 'main' };
const now = 1_800_000_000_000;

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
  return result.value;
}

function advance(state: Agenda, input: Inputs, event: Event): Agenda {
  const result = transition(state, input, event);
  if (result.kind !== 'next') {
    throw new Error(`Fixture transition ${event.kind}: ${JSON.stringify(result)}`);
  }
  expect(result.state.version).toBe(state.version + 1);
  return result.state;
}

/** Independent source observations, never a serialized or hand-edited Agenda. */
function fixture(id = agendaId) {
  const bodies = ['An already-obsolete implementation request.', 'The next ordered implementation.'];
  const facts: Facts = {
    viewer: 'storage-fixture',
    issues: [first, second].map((ref, index) => {
      const body = bodies[index]!;
      return {
        ref,
        body,
        bodyHash: createHash('sha256').update(body).digest('hex'),
        updatedAt: now,
        state: 'open',
        lastClose: null,
        lastReopen: null,
        children: [],
      };
    }),
    prs: [],
    links: [],
    repos: [{
      repo,
      defaultBranch: 'main',
      defaultHead: 'a'.repeat(40),
      bases: [{
        name: 'main',
        state: {
          kind: 'present',
          head: 'a'.repeat(40),
          isDefault: true,
          rules: { required: [], strict: false, upToDate: true, constraints: [] },
        },
      }],
    }],
    branches: [],
    maintenance: [],
    commits: [],
    checkAttempts: [],
    createdIssues: [],
  };
  const main: Inputs['host']['main'] = {
    agentId: 'main-storage-fixture',
    sessionId: 'main-session-storage-fixture',
    parentId: null,
    runId: 'storage-run',
    kind: 'main',
    depth: 0,
  };
  const input: Inputs = {
    facts: {
      kind: 'available',
      generation: 1,
      scope: {
        issues: [first, second],
        prs: [],
        repos: [{ repo, bases: ['main'] }],
        branches: [],
        commits: [],
        checkRuns: [],
        creations: [],
        maintenanceIntents: [],
      },
      observedAt: now,
      facts,
    },
    host: {
      runId: main.runId,
      main,
      seats: [],
      turnEnds: [],
      preflight: {
        ok: true,
        value: {
          asyncEnabled: true,
          isolationEnabled: true,
          asyncManager: true,
          gitCwd: evidenceRoot,
          agents: [{ name: 'fixture-owner', blocking: false }, { name: 'fixture-gate', blocking: false }],
        },
      },
    },
    policy: { text: 'Storage fixture policy.', ownerAgent: 'fixture-owner', gateAgent: 'fixture-gate' },
  };
  const initial = unwrap(createAgenda({
    op: 'convene',
    mode: 'execute',
    parent: null,
    entries: [first, second].map(issue => ({ issue, target, designOnly: false, adoptPr: null })),
  }, facts, now, id));
  const working = advance(initial, input, { kind: 'observe' });
  const classified = advance(working, input, {
    kind: 'mainNoCode',
    caller: main,
    member: first,
    bodyHash: facts.issues[0]!.bodyHash,
    reason: 'The requirement is already satisfied; preserve this accepted local classification.',
    acceptedAt: now + 1,
  });
  const closing = advance(classified, input, { kind: 'observe' });
  const close = closing.effects.find(effect => effect.action.kind === 'setIssueState');
  if (!close) throw new Error('Public fixture did not create the expected issue-close intent');
  const executing = advance(closing, input, { kind: 'effectStarted', id: close.id, attempt: 1, startedAt: now + 2 });
  const progressed = advance(executing, input, {
    kind: 'effectFailed',
    id: close.id,
    attempt: 1,
    error: { kind: 'permission', message: 'Independent fixture: source refused the close request.' },
    outcome: 'knownFailed',
  });
  return { initial, working, classified, closing, executing, progressed };
}

function statePath(dataDir: string, id = agendaId) {
  return join(dataDir, 'state', `${id}.json`);
}

async function snapshot(path: string) {
  const [bytes, metadata] = await Promise.all([readFile(path), stat(path, { bigint: true })]);
  return { bytes, inode: metadata.ino, mtime: metadata.mtimeNs };
}

async function prepareDirectory(label: string) {
  return mkdtemp(join(evidenceRoot, `${label}-`));
}

// Retain actual files, including negative inputs, for failure diagnosis and parent acceptance.
// No timing race, monkey-patch, or simulated filesystem is used to claim crash-boundary proof.
afterAll(() => console.info(`AgendaFiles filesystem evidence: ${evidenceRoot}`));

describe('AgendaFiles on the actual filesystem', () => {
  test('round-trips a public-API lifecycle with work, no-code, executing effect, failure, and case', async () => {
    const dataDir = await prepareDirectory('lifecycle');
    const metrics = { replaces: 0, unchangedReplaces: 0 };
    const files = createAgendaFiles(dataDir, metrics);
    const states = fixture();
    const lifecycle = [states.initial, states.working, states.classified, states.closing, states.executing, states.progressed];
    let expectedVersion: number | null = null;
    for (const state of lifecycle) {
      unwrap(await files.save(expectedVersion, state));
      const restored = unwrap(await createAgendaFiles(dataDir).load(state.id));
      expect(restored).toEqual(state);
      expect(unwrap(parseAgenda(restored))).toEqual(state);
      expect((await stat(statePath(dataDir))).mode & 0o777).toBe(0o600);
      expectedVersion = state.version;
    }
    expect(states.working.units[0]!.members[0]!.work).not.toBeNull();
    expect(states.working.requests.length).toBeGreaterThan(0);
    expect(states.progressed.units[0]!.members[0]!.terminal.kind).toBe('noCode');
    expect(states.progressed.units[1]!.members[0]!.terminal.kind).toBe('pending');
    expect(states.progressed.units[1]!.members[0]!.work).toBeNull();
    expect(states.progressed.effects.some(effect => effect.state.kind === 'failed')).toBe(true);
    expect(states.progressed.cases.some(item => item.state.kind === 'open')).toBe(true);
    expect(metrics.replaces).toBe(lifecycle.length);
    expect(metrics.unchangedReplaces).toBe(0);
  });

  test('exact fixed-target retries preserve bytes, version, inode, and mtime despite old expectations', async () => {
    const dataDir = await prepareDirectory('fixed-target');
    const metrics = { replaces: 0, unchangedReplaces: 0 };
    const files = createAgendaFiles(dataDir, metrics);
    const { initial, progressed } = fixture();
    unwrap(await files.save(null, initial));
    unwrap(await files.save(initial.version, progressed));
    const path = statePath(dataDir);
    await utimes(path, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    const before = await snapshot(path);
    for (const expected of [initial.version, null, progressed.version]) {
      // New port plus the same immutable target represents persistence retry, not transition replay.
      unwrap(await createAgendaFiles(dataDir, metrics).save(expected, progressed));
      expect(await snapshot(path)).toEqual(before);
      expect(unwrap(await createAgendaFiles(dataDir).load(agendaId)).version).toBe(progressed.version);
    }
    expect(metrics.replaces).toBe(2);
    expect(metrics.unchangedReplaces).toBe(0);
  });

  test('an exact-target retry repairs permissions to 0600 without replacing the target', async () => {
    const dataDir = await prepareDirectory('permissions');
    const { progressed } = fixture();
    const files = createAgendaFiles(dataDir);
    unwrap(await files.save(null, progressed));
    const path = statePath(dataDir);
    await chmod(path, 0o644);
    await utimes(path, new Date('2001-01-01T00:00:00Z'), new Date('2001-01-01T00:00:00Z'));
    const before = await snapshot(path);
    unwrap(await files.save(null, progressed));
    expect(await snapshot(path)).toEqual(before);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('a different target with stale expectedVersion cannot corrupt or replace the current snapshot', async () => {
    const dataDir = await prepareDirectory('stale-version');
    const { initial, working, progressed } = fixture();
    const metrics = { replaces: 0, unchangedReplaces: 0 };
    const files = createAgendaFiles(dataDir, metrics);
    unwrap(await files.save(null, initial));
    unwrap(await files.save(initial.version, working));
    const before = await snapshot(statePath(dataDir));
    for (const expected of [initial.version, null, working.version + 1]) {
      const result = await files.save(expected, progressed);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('versionConflict');
      expect(await snapshot(statePath(dataDir))).toEqual(before);
      expect(unwrap(await createAgendaFiles(dataDir).load(agendaId))).toEqual(working);
    }
    expect(metrics.replaces).toBe(2);
    expect(metrics.unchangedReplaces).toBe(0);
  });

  test('list isolates data directories and parses only recognized state JSON files', async () => {
    const dataDir = await prepareDirectory('list-primary');
    const isolatedDir = await prepareDirectory('list-isolated');
    const emptyDir = await prepareDirectory('list-empty');
    const primary = fixture().progressed;
    const isolated = fixture(otherAgendaId).working;
    const files = createAgendaFiles(dataDir);
    unwrap(await files.save(null, primary));
    unwrap(await createAgendaFiles(isolatedDir).save(null, isolated));
    await writeFile(join(dataDir, 'unrelated.json'), '{not a state file');
    await writeFile(join(dataDir, 'state', '.unfinished.tmp'), '{partial temporary file');
    await writeFile(join(dataDir, 'state', 'notes.txt'), 'not a serialized agenda');
    const before = await snapshot(statePath(dataDir));
    expect(unwrap(await files.list())).toEqual([primary]);
    expect(unwrap(await createAgendaFiles(isolatedDir).list())).toEqual([isolated]);
    expect(unwrap(await createAgendaFiles(emptyDir).list())).toEqual([]);
    const absent = await files.load(otherAgendaId);
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.error.kind).toBe('notFound');
    expect(await snapshot(statePath(dataDir))).toEqual(before);
  });

  test.each([
    ['format-1', 'unsupportedFormat'],
    ['format-2', 'unsupportedFormat'],
    ['invalid-envelope', 'corruptState'],
    ['invalid-domain', 'corruptState'],
    ['identity-mismatch', 'corruptState'],
    ['partial-json', 'corruptState'],
  ] as const)('%s is distinct from absence, remains intact, and makes list fail', async (category, expectedError) => {
    const dataDir = await prepareDirectory(category);
    await mkdir(join(dataDir, 'state'));
    const { progressed } = fixture();
    const envelope = { format: 3, state: progressed };
    let contents: string;
    switch (category) {
      case 'format-1': contents = JSON.stringify({ ...envelope, format: 1 }); break;
      case 'format-2': contents = JSON.stringify({ ...envelope, format: 2 }); break;
      case 'invalid-envelope': contents = JSON.stringify({ format: 3 }); break;
      case 'invalid-domain': contents = JSON.stringify({ ...envelope, state: { ...progressed, version: 0 } }); break;
      case 'identity-mismatch': contents = JSON.stringify({ ...envelope, state: { ...progressed, id: otherAgendaId } }); break;
      case 'partial-json': contents = JSON.stringify(envelope).slice(0, -17); break;
    }
    const path = statePath(dataDir);
    await writeFile(path, contents, { mode: 0o600 });
    const before = await snapshot(path);
    const files = createAgendaFiles(dataDir);
    const missing = await files.load(missingAgendaId);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe('notFound');
    for (const result of [await files.load(agendaId), await files.list(), await files.save(null, progressed)]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe(expectedError);
      expect(await snapshot(path)).toEqual(before);
    }
  });
});
