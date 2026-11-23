/**
 * The public demo's stand-in for core: answers the same /api calls the screens make, inside the
 * browser, from a recorded task (recording.json, made by `npm run record-demo` from the stand-in
 * agents in core/demo). Only demo builds use it: vite.config.ts points the `@transport` alias here
 * when VITE_DEMO is set, so a normal bundle never holds it.
 *
 * The replay: "Start" on a new task plays the recorded changes in order, at their recorded pace
 * stretched to about a minute. It waits where the owner had a turn (the Understander's question,
 * the release approval) until the visitor answers or approves, then goes on to "Done: on staging".
 * POST /demo/replay starts it again. Timestamps in the recording are moved to the visitor's clock.
 * Setup writes change nothing and say so; unknown reads get empty data.
 */

import type { Transport } from '../hooks/transportTypes';
import recorded from './recording.json';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Patch = { $v: Json } | { $o: Record<string, Patch | { $del: 1 }> } | { $a: { len: number; set: Record<string, Patch> } };
interface Gate { kind: 'answer' | 'approve'; id: string; answer?: string }
interface Frame { t: number; patch?: Record<string, Patch>; gate?: Gate }
interface Replayable {
  startedAt: number;
  task: { id: string; title: string; description: string };
  static: Record<string, Json>;
  idle: Record<string, Json>;
  frames: Frame[];
}
type Phase = 'idle' | 'playing' | 'paused' | 'done';

const rec = recorded as unknown as Replayable;
const TASK = rec.task;

/** About how long the replay plays, not counting the visitor's turns. */
const PLAY_MS = 75_000;
const MIN_GAP_MS = 300;
const MAX_GAP_MS = 6_000;
/** How long the last screen before the visitor's turn stays before the replay waits. */
const BEFORE_TURN_MS = 900;
const LAST_T = Math.max(1, ...rec.frames.map((f) => f.t));
const SCALE = PLAY_MS / LAST_T;
const RECORDED_ANSWER = rec.frames.find((f) => f.gate?.kind === 'answer')?.gate?.answer ?? null;

// ─── Applying the recorded changes ────────────────────────────────────────────

const isObject = (v: Json | undefined): v is { [key: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The inverse of core/scripts/record-demo.ts `diff`. */
function apply(value: Json | undefined, patch: Patch): Json {
  if ('$v' in patch) return patch.$v;
  if ('$o' in patch) {
    const out: { [key: string]: Json } = isObject(value) ? { ...value } : {};
    for (const [key, change] of Object.entries(patch.$o)) {
      if ('$del' in change) delete out[key];
      else out[key] = apply(out[key], change);
    }
    return out;
  }
  const out = (Array.isArray(value) ? value : []).slice(0, patch.$a.len);
  for (const [i, change] of Object.entries(patch.$a.set)) out[Number(i)] = apply(out[Number(i)], change);
  return out;
}

// ─── The replay ───────────────────────────────────────────────────────────────

let phase: Phase = 'idle';
let next = 0;
let state: Record<string, Json> = { ...rec.idle };
let timer: ReturnType<typeof setTimeout> | null = null;
let gate: Gate | null = null;
/** Recorded moments and when the visitor saw them, to put recorded timestamps on the visitor's clock. */
let clock: Array<{ rec: number; wall: number }> = [{ rec: rec.startedAt, wall: Date.now() }];

function reset(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  phase = 'idle';
  next = 0;
  gate = null;
  state = { ...rec.idle };
  clock = [{ rec: rec.startedAt, wall: Date.now() }];
}

function begin(): void {
  reset();
  phase = 'playing';
  emit({ type: 'demo_state', phase });
  emit({ type: 'task_created', taskId: TASK.id });
  step();
}

function step(): void {
  timer = null;
  const frame = rec.frames[next];
  if (!frame) { finish(); return; }
  if (frame.gate) { pause(frame.gate); return; }
  next += 1;
  show(frame);
  schedule();
}

/** Apply one recorded change and tell the screens. */
function show(frame: Frame): void {
  for (const [key, change] of Object.entries(frame.patch ?? {})) state[key] = apply(state[key], change);
  clock.push({ rec: rec.startedAt + frame.t, wall: Date.now() });
  emit({ type: 'task_updated', taskId: TASK.id });
  if (frame.patch && Object.keys(frame.patch).some((k) => k.startsWith('/agents'))) emit({ type: 'run_exit', taskId: TASK.id });
}

function schedule(): void {
  const done = rec.frames[next - 1];
  const upcoming = rec.frames[next];
  if (!upcoming) { finish(); return; }
  const gap = upcoming.gate ? BEFORE_TURN_MS : Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, (upcoming.t - (done?.t ?? 0)) * SCALE));
  timer = setTimeout(step, gap);
}

function pause(turn: Gate): void {
  phase = 'paused';
  gate = turn;
  emit({ type: 'demo_state', phase });
  emit({ type: 'owner_alert', taskId: TASK.id, kind: turn.kind === 'answer' ? 'question' : 'decision', title: TASK.title, text: '' });
}

/**
 * The visitor's answer or approval. The question or the approval card is on screen a little before
 * the replay pauses on its gate (the recording shows it for a moment, then BEFORE_TURN_MS), so a turn
 * taken while the replay still plays counts too: the replay skips ahead to the next gate, if it is
 * of this kind, and goes on from there instead of dropping the turn.
 */
function takeTurn(kind: Gate['kind']): boolean {
  if (gate) {
    if (gate.kind !== kind) return false;
    resume();
    return true;
  }
  if (phase !== 'playing') return false;
  const at = rec.frames.findIndex((f, i) => i >= next && f.gate !== undefined);
  if (at < 0 || rec.frames[at]!.gate!.kind !== kind) return false;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  for (; next < at; next++) show(rec.frames[next]!);
  gate = rec.frames[at]!.gate!;
  resume();
  return true;
}

function resume(): void {
  const frame = rec.frames[next];
  if (!gate || !frame) return;
  gate = null;
  next += 1;
  phase = 'playing';
  clock.push({ rec: rec.startedAt + frame.t, wall: Date.now() });
  emit({ type: 'demo_state', phase });
  step();
}

function finish(): void {
  if (phase === 'done') return;
  phase = 'done';
  emit({ type: 'demo_state', phase });
  emit({ type: 'owner_alert', taskId: TASK.id, kind: 'done', title: TASK.title, text: '' });
}

/** A recorded epoch-ms timestamp on the visitor's clock. */
function wallTime(at: number): number {
  for (let i = clock.length - 1; i >= 0; i--) {
    const c = clock[i]!;
    if (c.rec <= at || i === 0) return Math.min(Date.now(), Math.round(c.wall + (at - c.rec) * SCALE));
  }
  return at;
}

/** A copy with every timestamp moved to the visitor's clock. */
function rebase(value: Json): Json {
  if (typeof value === 'number') return value >= 1e12 && value < 1e13 ? wallTime(value) : value;
  if (Array.isArray(value)) return value.map(rebase);
  if (isObject(value)) {
    const out: { [key: string]: Json } = {};
    for (const [key, v] of Object.entries(value)) out[key] = rebase(v);
    return out;
  }
  return value;
}

// ─── Events (what core sends on /api/events) ──────────────────────────────────

const listeners = new Set<{ taskId: string | null; onData: (data: string) => void }>();

function emit(event: Record<string, Json>): void {
  const data = JSON.stringify(event);
  // Later, as from a real stream: never inside the call that caused it.
  setTimeout(() => {
    for (const l of listeners) if (!l.taskId || !event['taskId'] || l.taskId === event['taskId']) l.onData(data);
  }, 0);
}

function notice(text: string): void {
  emit({ type: 'demo_notice', text });
}

// ─── What the setup screens read: this demo's own, not anyone's machine ───────

const now = () => Date.now();
const FIXTURES: Record<string, () => Json> = {
  // The sample project as the scan would read it: one service with no neighbours.
  '/graph': () => ({
    projects: [{ id: 'sample-shop', name: 'sample-shop', scan: { sha: '0000000000000000000000000000000000000000', scannedAt: now(), error: null, truncated: false } }],
    services: [{ id: 'project:sample-shop', kind: 'project', projectId: 'sample-shop', label: 'sample-shop', source: 'scan', confidence: 1, confirmed: false }],
    links: [],
    keys: [],
  }),
  '/graph/projects/sample-shop': () => ({
    projectId: 'sample-shop', scan: { sha: '0000000000000000000000000000000000000000', scannedAt: now(), error: null, truncated: false },
    frameworks: [], exposes: [], calls: [], calledBy: [], keys: [],
  }),
  // What the learning page looks like once a few tasks have run: one lesson waiting, one in use.
  '/lessons': () => ({
    proposed: [{
      id: 2, projectId: 'sample-shop', role: 'coder', source: 'reflector', state: 'proposed', uses: 0, helped: 0, hurt: 0, createdAt: now() - 3_600_000, decidedAt: null, suggestRetire: false,
      text: 'When you change a price calculation, add a test with a discount of zero and one at the maximum; both were missed before.',
      evidence: [{ taskId: TASK.id, round: 1, what: 'Checker: criterion not met: zero discount leaves the total unchanged' }],
    }],
    active: [{
      id: 1, projectId: null, role: 'planner', source: 'reflector', state: 'active', uses: 4, helped: 3, hurt: 0, createdAt: now() - 6 * 86_400_000, decidedAt: now() - 5 * 86_400_000, suggestRetire: false,
      text: 'Name the exact test command in the plan; tasks without one were sent back for a missing test run.',
      evidence: [],
    }],
    retired: [],
    projects: { 'sample-shop': 'sample-shop' },
  }),
  '/connections': () => ({
    checkedAt: now(),
    checks: [
      { id: 'claude', name: 'Claude Code', usedFor: 'Every agent runs as Claude Code on this machine.', required: true, state: 'ok', summary: 'In this demo, stand-in agents play this part. On your computer FryDay checks that Claude Code is installed and signed in.' },
      { id: 'sandbox', name: 'Sandbox', usedFor: 'Confines agents, tests and installs: no reading your home folder, no writing outside the task, no network.', required: true, state: 'ok', summary: 'On your computer, every command an agent runs goes through the OS sandbox.' },
      { id: 'git', name: 'git', usedFor: 'Task branches, commits, merges and pushes, with your own access to the remotes.', required: true, state: 'ok', summary: 'The sample project is a git repository with a staging branch.' },
      { id: 'github', name: 'GitHub CLI', usedFor: 'Listing your repositories, finding branches and pull requests, opening pull requests. Cloning and pushing work without it.', required: false, state: 'off', summary: 'Optional. Not used in this demo.' },
      { id: 'node', name: 'Node.js', usedFor: 'FryDay Code itself, its sandbox, and the checks of Node projects.', required: true, state: 'ok', summary: 'FryDay Code needs Node.js 22.12 or newer.' },
      { id: 'machine', name: 'This computer', usedFor: 'Agents and test suites need memory; work waits while the computer is short of it.', required: true, state: 'ok', summary: 'Checks wait while memory is short.' },
      { id: 'browser', name: 'Browser', usedFor: 'The UI tester opens the pages of a project in it, in a fresh profile that can reach only the service under test.', required: false, state: 'off', summary: 'Optional. The sample project has no pages to test.' },
      { id: 'cursor', name: 'Cursor CLI', usedFor: 'An optional engine for the Analyst and the Planner, when you choose it in Settings.', required: false, state: 'off', summary: 'Optional. Not used in this demo.' },
    ],
    mcpServers: [],
    mcpNote: null,
    dataConnections: [],
  }),
  '/connections/data': () => ({ dataConnections: [] }),
  '/notifications': () => ({ chat: { configured: false, space: null, lastSentAt: null, lastError: null } }),
  '/deploy/jenkins': () => ({ jenkins: { configured: false, baseUrl: null, user: null } }),
  '/runners': () => ({
    runners: [
      { id: 'claude', label: 'Claude Code', caps: { guardHook: true, structuredOutput: true, osSandbox: 'shell', budgetStop: true, roles: ['fryday', 'analyst', 'planner', 'coder', 'tester', 'api_tester', 'ui_tester', 'system'] }, available: true, why: null },
      { id: 'cursor', label: 'Cursor CLI (reduced isolation)', caps: { guardHook: false, structuredOutput: false, osSandbox: 'whole-process', budgetStop: false, roles: ['analyst', 'planner'] }, available: false, why: 'not set up in this demo' },
    ],
    cursor: { installed: false, keySet: false },
  }),
  '/chat-inbound': () => ({
    google: { clientSet: false, clientId: null, signedIn: false, signedInAt: null },
    inbound: { enabled: false, owner: null, linking: null, lastPollAt: null, lastError: null, handled: 0, skippedOthers: 0, missing: ['a Chat space (not part of this demo)'] },
  }),
  '/system': () => ({ ...(rec.static['/system'] as { [key: string]: Json }), home: '~/.fryday-code', claudeBin: 'claude', platform: 'browser', demo: true }),
};

// ─── Requests ─────────────────────────────────────────────────────────────────

const demoError = (text: string) => new Error(JSON.stringify({ error: text }));
const NOT_SAVED = 'This is a demo: settings are not saved.';
const ONLY_INSTALLED = 'This is a demo: that works in FryDay Code on your own computer.';
const SETUP = /^\/(settings|notifications|deploy|runners|chat-inbound|connections|projects)(\/|$)/;

function read(path: string): Json {
  const route = path.split('?')[0]!;
  if (route === '/demo/state') return { phase, taskId: TASK.id };
  const fixture = FIXTURES[route];
  if (fixture) return fixture();
  if (route in rec.static) return rebase(rec.static[route]!);
  // A link to the task opened before the replay: start it.
  if (phase === 'idle' && route.startsWith(`/tasks/${TASK.id}`)) begin();
  const key = path in state ? path : Object.keys(state).find((k) => k.split('?')[0] === route);
  if (key !== undefined) return rebase(state[key]!);
  if (/^\/tasks\/[^/]+(\/story)?$/.test(route) && !['/tasks/overview'].includes(route)) throw demoError('Task not found');
  return {};
}

function write(method: string, path: string, body: any): Json {
  const route = path.split('?')[0]!;
  if (method === 'POST' && route === '/tasks') {
    if (phase === 'playing' || phase === 'paused') notice('This demo replays one task at a time. Press Replay to watch it from the start.');
    else reset();
    return { id: TASK.id, title: TASK.title, state: 'queued' };
  }
  if (method === 'POST' && route === `/tasks/${TASK.id}/start`) {
    if (phase === 'idle') begin();
    return { ok: true };
  }
  if (method === 'POST' && route === '/demo/replay') { begin(); return { id: TASK.id }; }
  if (method === 'POST' && /^\/tasks\/[^/]+\/attachments$/.test(route)) return { ok: true };
  if (method === 'POST' && /^\/tasks\/[^/]+\/questions\/([^/]+\/answer|skip)$/.test(route)) {
    const answer = typeof body?.answer === 'string' ? body.answer : null;
    if (!takeTurn('answer')) return { resumed: false };
    if (answer && RECORDED_ANSWER && answer !== RECORDED_ANSWER) notice(`This demo follows its recording: the team goes on with "${RECORDED_ANSWER}".`);
    return { resumed: true };
  }
  if (method === 'POST' && /^\/approvals\/[^/]+\/resolve$/.test(route)) {
    if (body?.decision === 'approved' && takeTurn('approve')) return { state: 'approved' };
    if (body?.decision === 'rejected') notice('In FryDay Code, "Not yet" keeps the change ready without putting it on staging. This demo goes on when you approve.');
    return { state: 'pending' };
  }
  if (method === 'POST' && /^\/tasks\/[^/]+\/messages$/.test(route)) {
    notice('This is a demo: the stand-in agents follow a script, so they cannot reply.');
    return { ok: true };
  }
  if (method === 'POST' && route === '/chat') throw demoError('This is a demo: the agents are stand-ins, so there is no one to chat with. Install FryDay Code to chat for real.');
  if (/^\/projects\/(detect|clone)$/.test(route) || (method === 'POST' && route === '/projects')) {
    notice(NOT_SAVED);
    throw demoError('This is a demo: you cannot add projects here. Install FryDay Code to use your own.');
  }
  if (SETUP.test(route)) {
    notice(NOT_SAVED);
    try { return read(path); } catch { return { ok: true }; }
  }
  notice(ONLY_INSTALLED);
  return { ok: true };
}

const json = (body: Json, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function request(method: string, path: string, body?: unknown): Promise<any> {
  await Promise.resolve();
  return method === 'GET' ? read(path) : write(method, path, body);
}

export const transport = {
  request,
  openStream(url, onData) {
    const taskId = new URL(url, 'http://demo.invalid').searchParams.get('taskId');
    const listener = { taskId, onData };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  async rawFetch(url, init) {
    if (!url.startsWith('/api/')) return fetch(url, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    try {
      return json(await request(method, url.slice('/api'.length), body));
    } catch (err) {
      return new Response(err instanceof Error ? err.message : String(err), { status: 400 });
    }
  },
} satisfies Transport;
