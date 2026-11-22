/**
 * `npm run record-demo`: records the task that the public demo site replays.
 *
 * Starts core in a throwaway install (the same setup as `fryday-code demo`: the sample project
 * and the stand-in agents that follow demo/scenario.json), signs in the way a browser does,
 * creates the scenario's task through the API, answers the Analyst's question and approves the
 * release when asked. While it runs it polls what the screens read and keeps a timeline of what
 * changed and when. It writes ui/src/demo/recording.json:
 *
 *   idle     what the screens read before the task exists
 *   frames   [{ t, patch }]: ms since the task started, and what changed (a compact diff)
 *            [{ t, gate }]:  where the replay waits for the visitor (an answer, an approval)
 *   static   what does not change (projects, settings)
 *
 * The throwaway install lives in ~/.fryday-code-record and is removed afterwards. Its paths are
 * written as ~/fryday-demo, and the recording is checked for any path or name of this machine
 * before it is saved. Nothing calls a model.
 *
 * FRYDAY_RECORD_PORT picks the port (default 7479).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { demoEnv, demoPaths, demoTask, makeSampleRepo, resetDemoFolder, writeStandIn } from '../src/cli/demo';
import { fetchLaunchLink } from '../src/cli/open';

const PACKAGE_DIR = path.join(__dirname, '..');
const OUT = path.join(PACKAGE_DIR, '..', 'ui', 'src', 'demo', 'recording.json');
const PORT = Number(process.env['FRYDAY_RECORD_PORT'] ?? 7479);
const BASE = `http://127.0.0.1:${PORT}`;
const POLL_MS = 250;
/** How long a question or an approval stays on screen in the recording before it is answered. */
const SHOW_MS = 1500;
/** After the task ends, keep polling this long so the last screens settle. */
const SETTLE_MS = 2500;
const TIMEOUT_MS = 5 * 60_000;
/** What the scrubbed recording says instead of the throwaway install's folder. */
const DEMO_HOME = '~/fryday-demo';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Patch = { $v: Json } | { $o: Record<string, Patch | { $del: 1 }> } | { $a: { len: number; set: Record<string, Patch> } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Diff ─────────────────────────────────────────────────────────────────────

const isObject = (v: Json): v is { [key: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);

/** What turns `a` into `b`, or undefined when they are the same. ui/src/demo/backend.ts applies it. */
export function diff(a: Json | undefined, b: Json): Patch | undefined {
  if (a !== undefined && same(a, b)) return undefined;
  if (a !== undefined && isObject(a) && isObject(b)) {
    const out: Record<string, Patch | { $del: 1 }> = {};
    for (const key of Object.keys(b)) {
      const d = diff(a[key], b[key]!);
      if (d) out[key] = d;
    }
    for (const key of Object.keys(a)) if (!(key in b)) out[key] = { $del: 1 };
    return { $o: out };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const set: Record<string, Patch> = {};
    b.forEach((item, i) => {
      const d = diff(a[i], item);
      if (d) set[i] = d;
    });
    return { $a: { len: b.length, set } };
  }
  return { $v: b };
}

// ─── Scrubbing ────────────────────────────────────────────────────────────────

/** Every way a path of the throwaway install or this machine can appear, longest first. */
function scrubber(root: string): (text: string) => string {
  const pairs: Array<[string, string]> = [];
  const add = (from: string, to: string) => { if (from && from.length > 1) pairs.push([from, to]); };
  for (const r of new Set([root, fs.realpathSync(root)])) add(r, DEMO_HOME);
  const pkg = path.join(PACKAGE_DIR, '..');
  for (const p of new Set([pkg, fs.realpathSync(pkg)])) add(p, 'fryday-code');
  add(path.dirname(process.execPath), '/usr/local/bin');
  add(os.homedir(), '~');
  add(os.tmpdir(), '/tmp');
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (text) => pairs.reduce((t, [from, to]) => t.split(from).join(to), text);
}

/** Refuse to save anything that still names this machine or its owner. */
function assertClean(text: string): void {
  const user = os.userInfo().username;
  const host = os.hostname().split('.')[0] ?? '';
  const leaks = [/\/Users\//, /\/home\/[a-z]/, /\/private\/var\//, /\/var\/folders\//, /\/opt\/homebrew/,
    ...(user.length > 2 ? [new RegExp(`\\b${user}\\b`, 'i')] : []),
    ...(host.length > 2 ? [new RegExp(`\\b${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')] : [])];
  for (const leak of leaks) {
    const m = text.match(leak);
    if (m) {
      const at = m.index ?? 0;
      throw new Error(`the recording still holds a local name (${leak}): …${text.slice(Math.max(0, at - 60), at + 60)}…`);
    }
  }
}

// ─── Talking to core as the UI does ───────────────────────────────────────────

let cookie = '';

async function signIn(secret: string): Promise<void> {
  const link = await fetchLaunchLink(BASE, secret);
  if (!link.ok) throw new Error(`no launch link (${link.status ?? 'no answer'})`);
  const code = link.url.split('#launch=')[1];
  const res = await fetch(`${BASE}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ code }) });
  const set = res.headers.get('set-cookie');
  if (!res.ok || !set) throw new Error(`sign-in failed (${res.status})`);
  cookie = set.split(';')[0]!;
}

async function api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}/api${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: BASE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

async function must(method: string, route: string, body?: unknown): Promise<any> {
  const res = await api(method, route, body);
  if (res.status >= 300) throw new Error(`${method} ${route}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function healthy(): Promise<boolean> {
  try { return (await fetch(`${BASE}/health`)).ok; } catch { return false; }
}

// ─── The recording ────────────────────────────────────────────────────────────

/** What the screens read while a task runs (the paths the UI asks for, without /api). */
function livePaths(taskId: string, runIds: string[]): string[] {
  return [
    '/tasks/overview', `/tasks/${taskId}/story`, `/tasks/${taskId}`, '/tasks?limit=200',
    '/agents', '/approvals', '/usage/today', '/usage/by-role?days=7',
    ...runIds.map((r) => `/agents/${r}/activity?max=60`),
  ];
}

async function snapshot(paths: string[], scrub: (t: string) => string): Promise<Record<string, Json>> {
  const out: Record<string, Json> = {};
  for (const p of paths) {
    const res = await api('GET', p);
    if (res.status === 200) out[p] = JSON.parse(scrub(JSON.stringify(res.body))) as Json;
  }
  return out;
}

interface Frame { t: number; patch?: Record<string, Patch>; gate?: { kind: 'answer' | 'approve'; id: string; answer?: string } }

async function record(): Promise<number> {
  if (await healthy()) { console.error(`Something is already running on port ${PORT}. Stop it or set FRYDAY_RECORD_PORT.`); return 1; }
  const p = demoPaths(path.join(os.homedir(), '.fryday-code-record'));
  resetDemoFolder(p);
  makeSampleRepo(p);
  writeStandIn(p);
  const scrub = scrubber(p.root);
  const log = fs.openSync(p.log, 'a');
  const core: ChildProcess = spawn(process.execPath, [require.resolve('tsx/cli'), path.join('src', 'server.ts')], {
    cwd: PACKAGE_DIR, env: { ...demoEnv(p, PORT), FRYDAY_DESKTOP_NOTIFY: 'off' }, stdio: ['ignore', log, log],
  });
  const stop = () => { if (core.exitCode === null) core.kill('SIGTERM'); };
  process.on('SIGINT', () => { stop(); process.exit(130); });
  try {
    for (let i = 0; i < 150 && core.exitCode === null && !(await healthy()); i++) await sleep(200);
    if (!(await healthy())) throw new Error(`core did not start; see ${p.log}`);
    const secret = fs.readFileSync(path.join(p.home, 'secret'), 'utf8').trim();
    await signIn(secret);

    // The sample project, the way the Projects page adds it (as `fryday-code demo` does).
    const detected = await must('POST', '/projects/detect', { path: p.clone });
    const { runProfile: _r, deployer: _d, deployerConfig: _c, ...facts } = detected.facts;
    const project = await must('POST', '/projects', { ...facts, stgBranch: 'stg', verified: true });
    const staticPaths = ['/projects', '/settings', '/system'];
    const statics = await snapshot(staticPaths, scrub);
    const idle = await snapshot(livePaths('none', []).filter((x) => !x.includes('none')), scrub);

    const task = demoTask();
    const created = await must('POST', '/tasks', { title: task.title, description: task.description, start: false });
    const id = String(created.id);
    const startedAt = Date.now();
    await must('POST', `/tasks/${id}/start`, { repoId: project.id ?? facts.id });
    console.log(`Recording task ${id}: ${task.title}`);

    const frames: Frame[] = [];
    let state: Record<string, Json> = { ...idle };
    const answered = new Set<string>();
    let pendingSince: Record<string, number> = {};
    let endedAt: number | null = null;
    let lastLine = '';
    while (Date.now() - startedAt < TIMEOUT_MS) {
      const runs = (await api('GET', `/tasks/${id}`)).body?.runs as Array<{ id: string }> | undefined;
      const now = await snapshot(livePaths(id, (runs ?? []).map((r) => r.id)), scrub);
      const patch: Record<string, Patch> = {};
      for (const [key, value] of Object.entries(now)) {
        const d = diff(state[key], value);
        if (d) patch[key] = d;
      }
      if (Object.keys(patch).length) {
        frames.push({ t: Date.now() - startedAt, patch });
        state = { ...state, ...now };
      }
      const story = now[`/tasks/${id}/story`] as any;
      const line = `${story?.task?.state} · ${story?.now?.text ?? story?.journey?.finished ?? ''}`;
      if (line !== lastLine) { console.log(`  ${((Date.now() - startedAt) / 1000).toFixed(1)}s  ${line}`); lastLine = line; }

      // The visitor's turn: an open question or a pending approval, shown for a moment, then answered.
      const actions = ((story?.items ?? []) as Array<{ action: any }>).map((i) => i.action).filter(Boolean);
      for (const action of actions) {
        const key = action.kind === 'answer' ? action.questionId : action.approvalId;
        if (answered.has(key)) continue;
        pendingSince[key] ??= Date.now();
        if (Date.now() - pendingSince[key]! < SHOW_MS) continue;
        answered.add(key);
        if (action.kind === 'answer') {
          const answer = action.options?.[0]?.value ?? 'Yes';
          frames.push({ t: Date.now() - startedAt, gate: { kind: 'answer', id: key, answer } });
          await must('POST', `/tasks/${id}/questions/${key}/answer`, { answer });
          console.log(`  answered: ${answer}`);
        } else {
          frames.push({ t: Date.now() - startedAt, gate: { kind: 'approve', id: key } });
          await must('POST', `/approvals/${key}/resolve`, { decision: 'approved' });
          console.log('  approved');
        }
      }

      const finished = story?.journey?.finished ?? null;
      if (finished && endedAt === null) endedAt = Date.now();
      if (endedAt !== null && Date.now() - endedAt > SETTLE_MS) break;
      await sleep(POLL_MS);
    }
    if (endedAt === null) throw new Error(`the task did not finish within ${TIMEOUT_MS / 1000}s; see ${p.log}`);

    const recording = {
      version: 1,
      note: 'Made by `npm run record-demo` (core/scripts/record-demo.ts) from the stand-in agents in core/demo. Do not edit by hand.',
      startedAt,
      task: { id, title: task.title, description: task.description },
      static: statics,
      idle,
      frames,
    };
    const text = JSON.stringify(recording);
    assertClean(text);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${text}\n`);
    const gates = frames.filter((f) => f.gate).length;
    console.log(`Wrote ${path.relative(path.join(PACKAGE_DIR, '..'), OUT)}: ${frames.length - gates} changes, ${gates} pauses, ${((endedAt - startedAt) / 1000).toFixed(1)}s recorded, ${(text.length / 1024).toFixed(0)} KB.`);
    return 0;
  } finally {
    // Core first, then its throwaway folder (made by resetDemoFolder, so it carries the marker).
    const exited = new Promise((resolve) => (core.exitCode !== null ? resolve(null) : core.once('exit', resolve)));
    stop();
    await exited;
    fs.rmSync(p.root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  record().then((code) => process.exit(code), (err) => { console.error(`record-demo: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
}
