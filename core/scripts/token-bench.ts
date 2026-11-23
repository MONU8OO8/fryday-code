/**
 * Token benchmark: how many tokens the agents spend per task, per role and per passed task.
 *
 *   npm run token-bench -- [--suite e2e|mid] [--label <name>]
 *        runs the suite with real agents, then reports. e2e: `npm run e2e` (a two-file project);
 *        mid: scripts/bench-mid.ts (a generated sixty-file service, where finding code costs).
 *   npm run token-bench -- [--suite …] --report-only    reports the suite's last database, runs nothing
 *   npm run token-bench -- --db <file> [--suite … --save] reports any FryDay database (read-only);
 *        with --save it is kept as a report of that suite (a run made from another checkout).
 *
 * The figure that matters is tokens per passed task: counted tokens (input + output + cache
 * writes, the ones limits are in) plus cache reads (context reused from earlier turns, cheap
 * but not free). Each report is written to <FRYDAY_HOME>/bench/ and compared with the oldest
 * report there, the baseline.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null; };

const home = process.env.FRYDAY_HOME_BENCH ?? path.join(os.homedir(), '.fryday-code');
const benchDir = path.join(home, 'bench');
const suite = value('--suite') === 'mid' ? 'mid' : 'e2e';
const SUITE_DB = { e2e: path.join(home, 'e2e', 'e2e.db'), mid: path.join(home, 'bench-mid', 'bench.db') } as const;
const dbPath = value('--db') ?? SUITE_DB[suite];
const label = value('--label') ?? (flag('--report-only') || value('--db') ? 'report' : 'run');

interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
interface RoleRow extends Usage { role: string; runs: number; turns: number; counted: number; total: number }
interface TaskRow extends Usage { id: string; title: string; state: string; passed: boolean; runs: number; counted: number; total: number }
export interface BenchReport {
  label: string;
  at: string;
  db: string;
  e2eExit: number | null;
  model: string | null;
  roles: RoleRow[];
  tasks: TaskRow[];
  passedTasks: number;
  totalPerPassedTask: number | null;
  countedPerPassedTask: number | null;
}

const PASSED = new Set(['awaiting_approval', 'releasing', 'deploying', 'deployed']);
const counted = (u: Usage) => u.input + u.output + u.cacheWrite;

/** Per run: the result event when it carries tokens, else the assistant events (the same rule as runner/usage.ts). */
function runUsage(db: Database.Database): Map<string, Usage & { role: string; taskId: string | null; turns: number }> {
  const rows = db.prepare(`
    SELECT r.id, r.role, r.task_id,
      SUM(CASE WHEN u.event_type = 'result' THEN u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens ELSE 0 END) AS rt,
      SUM(CASE WHEN u.event_type = 'result' THEN u.input_tokens ELSE 0 END) AS ri,
      SUM(CASE WHEN u.event_type = 'result' THEN u.output_tokens ELSE 0 END) AS ro,
      SUM(CASE WHEN u.event_type = 'result' THEN u.cache_read_tokens ELSE 0 END) AS rcr,
      SUM(CASE WHEN u.event_type = 'result' THEN u.cache_write_tokens ELSE 0 END) AS rcw,
      SUM(CASE WHEN u.event_type = 'result' THEN u.cost_usd ELSE 0 END) AS rc,
      SUM(CASE WHEN u.event_type = 'assistant' THEN u.input_tokens ELSE 0 END) AS ai,
      SUM(CASE WHEN u.event_type = 'assistant' THEN u.output_tokens ELSE 0 END) AS ao,
      SUM(CASE WHEN u.event_type = 'assistant' THEN u.cache_read_tokens ELSE 0 END) AS acr,
      SUM(CASE WHEN u.event_type = 'assistant' THEN u.cache_write_tokens ELSE 0 END) AS acw,
      SUM(CASE WHEN u.event_type = 'assistant' THEN 1 ELSE 0 END) AS turns
    FROM runs r LEFT JOIN usage_events u ON u.run_id = r.id
    GROUP BY r.id
  `).all() as Array<Record<string, number | string | null>>;
  const out = new Map<string, Usage & { role: string; taskId: string | null; turns: number }>();
  for (const r of rows) {
    const n = (k: string) => Number(r[k] ?? 0);
    const fromResult = n('rt') > 0;
    out.set(String(r['id']), {
      role: String(r['role']),
      taskId: (r['task_id'] as string | null) ?? null,
      turns: n('turns'),
      input: fromResult ? n('ri') : n('ai'),
      output: fromResult ? n('ro') : n('ao'),
      cacheRead: fromResult ? n('rcr') : n('acr'),
      cacheWrite: fromResult ? n('rcw') : n('acw'),
      cost: n('rc'),
    });
  }
  return out;
}

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const add = (a: Usage, b: Usage) => { a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite; a.cost += b.cost; };

export function buildReport(file: string, reportLabel: string, e2eExit: number | null): BenchReport {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const runs = runUsage(db);
    const roles = new Map<string, RoleRow>();
    for (const run of runs.values()) {
      const row = roles.get(run.role) ?? { role: run.role, runs: 0, turns: 0, counted: 0, total: 0, ...zero() };
      row.runs++;
      row.turns += run.turns;
      add(row, run);
      roles.set(run.role, row);
    }
    for (const r of roles.values()) { r.counted = counted(r); r.total = r.counted + r.cacheRead; }

    const taskRows = db.prepare(`SELECT id, title, state FROM tasks ORDER BY seq`).all() as Array<{ id: string; title: string; state: string }>;
    const tasks: TaskRow[] = taskRows.map((t) => {
      const u = zero();
      let n = 0;
      for (const run of runs.values()) if (run.taskId === t.id) { add(u, run); n++; }
      const c = counted(u);
      return { id: t.id, title: t.title, state: t.state, passed: PASSED.has(t.state), runs: n, counted: c, total: c + u.cacheRead, ...u };
    });
    const passed = tasks.filter((t) => t.passed);
    const sum = (k: 'total' | 'counted') => passed.reduce((s, t) => s + t[k], 0);
    const modelRow = db.prepare(`SELECT model FROM runs WHERE model IS NOT NULL GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1`).get() as { model: string } | undefined;
    return {
      label: reportLabel,
      at: new Date().toISOString(),
      db: file,
      e2eExit,
      model: modelRow?.model ?? null,
      roles: [...roles.values()].sort((a, b) => b.total - a.total),
      tasks,
      passedTasks: passed.length,
      totalPerPassedTask: passed.length ? Math.round(sum('total') / passed.length) : null,
      countedPerPassedTask: passed.length ? Math.round(sum('counted') / passed.length) : null,
    };
  } finally {
    db.close();
  }
}

const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pct = (now: number, then: number) => (then ? `${now <= then ? '−' : '+'}${Math.abs(Math.round(((now - then) / then) * 100))}%` : 'n/a');

function print(r: BenchReport, baseline: BenchReport | null): void {
  console.log(`\nToken benchmark "${r.label}" · ${r.db}${r.model ? ` · mostly ${r.model}` : ''}${r.e2eExit === null ? '' : ` · e2e exit ${r.e2eExit}`}`);
  console.log('\nPer role                 runs  turns   counted  cache read     total   notional $');
  for (const x of r.roles) {
    const was = baseline?.roles.find((b) => b.role === x.role);
    console.log(`  ${x.role.padEnd(20)} ${String(x.runs).padStart(5)} ${String(x.turns).padStart(6)} ${k(x.counted).padStart(9)} ${k(x.cacheRead).padStart(11)} ${k(x.total).padStart(9)} ${x.cost.toFixed(2).padStart(12)}${was ? `   (${pct(x.total, was.total)} vs baseline)` : ''}`);
  }
  console.log('\nPer task');
  for (const t of r.tasks) console.log(`  ${t.id.padEnd(5)} ${(t.passed ? 'passed' : t.state).padEnd(17)} ${k(t.total).padStart(9)} total  ${k(t.counted).padStart(8)} counted  ${t.runs} runs  ${t.title.slice(0, 50)}`);
  const per = r.totalPerPassedTask;
  console.log(`\nPer passed task: ${per === null ? 'no task passed' : `${k(per)} total, ${k(r.countedPerPassedTask!)} counted`} (${r.passedTasks} of ${r.tasks.length} passed)`);
  if (baseline && per !== null && baseline.totalPerPassedTask) {
    console.log(`Baseline "${baseline.label}" (${baseline.at.slice(0, 10)}): ${k(baseline.totalPerPassedTask)} total per passed task → ${pct(per, baseline.totalPerPassedTask)}`);
  }
}

function baselineOf(dir: string): BenchReport | null {
  if (!fs.existsSync(dir)) return null;
  // A suite's reports start with its name; the first e2e reports had no prefix.
  const mine = (f: string) => f.startsWith(`${suite}-`) || (suite === 'e2e' && /^\d{4}-/.test(f));
  const first = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && mine(f)).sort((a, b) => a.replace(/^[a-z]+-/, '').localeCompare(b.replace(/^[a-z]+-/, '')))[0];
  return first ? (JSON.parse(fs.readFileSync(path.join(dir, first), 'utf8')) as BenchReport) : null;
}

function main(): number {
  let e2eExit: number | null = null;
  if (!flag('--report-only') && !value('--db')) {
    console.log(`Running the ${suite} suite with real agents (this costs tokens)…`);
    const env = { ...process.env, FRYDAY_MEMORY_WAIT_MS: process.env.FRYDAY_MEMORY_WAIT_MS ?? '0' };
    const run = suite === 'mid'
      ? spawnSync('npx', ['tsx', path.join(__dirname, 'bench-mid.ts')], { stdio: 'inherit', env })
      : spawnSync('npm', ['run', '-s', 'e2e'], { stdio: 'inherit', env });
    e2eExit = run.status ?? 2;
  }
  if (!fs.existsSync(dbPath)) { console.error(`No database at ${dbPath}`); return 2; }
  const report = buildReport(dbPath, label, e2eExit);
  const baseline = baselineOf(benchDir);
  print(report, baseline);
  // A report of another database (the live one) is printed, not kept, unless --save says it is a run of the suite.
  if (!value('--db') || flag('--save')) {
    fs.mkdirSync(benchDir, { recursive: true });
    const file = path.join(benchDir, `${suite}-${report.at.replace(/[:.]/g, '-')}-${label.replace(/[^a-z0-9-]/gi, '_')}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\nSaved ${file}`);
  }
  return e2eExit && e2eExit !== 0 ? e2eExit : 0;
}

if (require.main === module) process.exit(main());
