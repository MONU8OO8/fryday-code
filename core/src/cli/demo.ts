/**
 * `fryday-code demo`: try FryDay Code with no Claude account and no cost.
 *
 * Starts a throwaway install in ~/.fryday-code-demo (wiped on every start) with a small
 * sample project (a git repository with an "origin" folder on disk and a staging branch),
 * and stand-in agents (demo/stand-in-agent.mjs) that follow demo/scenario.json: a plan, a
 * first build that fails the tests, a fix, a check, then the owner's approval. Nothing calls
 * a model and nothing leaves this computer. The UI shows a "Demo mode" banner.
 *
 *   fryday-code demo             start it and open the browser
 *   fryday-code demo --no-open   start it and only print the link
 *
 * FRYDAY_DEMO_PORT picks the port (default 7477, so a real install on 7475 keeps running).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fetchLaunchLink, openInBrowser } from './open.js';

const PACKAGE_DIR = path.join(__dirname, '..', '..');
const DEMO_DIR = path.join(PACKAGE_DIR, 'demo');
/** Written into the demo folder, so a folder FryDay did not make is never wiped. */
const MARKER = '.fryday-code-demo';
const DELAY_MS = 1500;

export interface DemoPaths {
  root: string;
  home: string;
  clone: string;
  origin: string;
  scenario: string;
  wrapper: string;
  log: string;
}

export function demoPaths(root = path.join(os.homedir(), '.fryday-code-demo')): DemoPaths {
  return {
    root,
    home: path.join(root, 'state'),
    clone: path.join(root, 'sample-shop'),
    origin: path.join(root, 'sample-shop.git'),
    scenario: path.join(root, 'scenario.json'),
    wrapper: path.join(root, 'claude'),
    log: path.join(root, 'core.log'),
  };
}

/** The task the stand-in agents' script was written for (scenario.json `task`). */
export function demoTask(): { title: string; description: string } {
  const scenario = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'scenario.json'), 'utf8')) as { task: { title: string; description: string } };
  return scenario.task;
}

/** A value inside single quotes for /bin/sh. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Empty the demo folder, refusing one that the demo did not create. */
export function resetDemoFolder(p: DemoPaths): void {
  if (fs.existsSync(p.root)) {
    if (!fs.existsSync(path.join(p.root, MARKER))) {
      throw new Error(`${p.root} exists and was not made by the demo; move it away and run the demo again.`);
    }
    fs.rmSync(p.root, { recursive: true, force: true });
  }
  fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(p.root, MARKER), 'Made by `fryday-code demo`. Wiped each time the demo starts.\n');
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Demo Owner', '-c', 'user.email=owner@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The sample project: a tiny Node package of shop orders with a test, main and stg on a bare "origin". */
export function makeSampleRepo(p: DemoPaths): void {
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', p.origin], { stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', p.clone], { stdio: 'ignore' });
  const files: Record<string, string> = {
    '.gitignore': 'node_modules\n',
    'package.json': `${JSON.stringify({ name: 'sample-shop', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
    'README.md': '# sample-shop\n\nA tiny project for the FryDay Code demo: the orders of a small shop.\n',
    'src/orders.js': [
      'const orders = [',
      "  { id: 1001, customer: 'Ada Lovelace', total: 42.5, placedAt: '2026-11-02' },",
      "  { id: 1002, customer: 'Hopper, Grace', total: 19.99, placedAt: '2026-11-03' },",
      "  { id: 1003, customer: 'Alan Turing', total: 7.25, placedAt: '2026-11-04' },",
      '];',
      '',
      'exports.listOrders = () => orders.slice();',
      'exports.totalOf = (list) => list.reduce((sum, o) => sum + o.total, 0);',
      '',
    ].join('\n'),
    'test/orders.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { listOrders, totalOf } = require('../src/orders');\n\ntest('totalOf adds the order totals', () => assert.equal(totalOf(listOrders()), 69.74));\n",
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(p.clone, file)), { recursive: true });
    fs.writeFileSync(path.join(p.clone, file), content);
  }
  git(p.clone, 'add', '-A');
  git(p.clone, 'commit', '-qm', 'Orders');
  git(p.clone, 'remote', 'add', 'origin', p.origin);
  git(p.clone, 'push', '-q', 'origin', 'main', 'main:stg');
  git(p.clone, 'fetch', '-q', 'origin');
  git(p.clone, 'remote', 'set-head', 'origin', 'main');
}

/** The stand-in `claude`: a shell script that runs the stand-in agent on the scenario, slowly enough to watch. */
export function writeStandIn(p: DemoPaths, nodeBin = process.execPath): void {
  fs.copyFileSync(path.join(DEMO_DIR, 'scenario.json'), p.scenario);
  const script = [
    '#!/bin/sh',
    '# FryDay Code demo: a stand-in for the claude CLI. It follows scenario.json and calls no model.',
    `export FAKE_PLAN_FILE=${shellQuote(p.scenario)}`,
    `export FAKE_DELAY_MS=${DELAY_MS}`,
    `exec ${shellQuote(nodeBin)} ${shellQuote(path.join(DEMO_DIR, 'stand-in-agent.mjs'))} "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(p.wrapper, script, { mode: 0o755 });
}

/** Core's environment for the demo: its own state folder and port, the stand-in agents, no keys. */
export function demoEnv(p: DemoPaths, port: number, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, FRYDAY_HOME: p.home, FRYDAY_PORT: String(port), FRYDAY_HOST: '127.0.0.1', CLAUDE_BIN: p.wrapper, FRYDAY_DEMO: '1', FRYDAY_MEMORY_WAIT_MS: '0' };
  // A real install's settings and keys have no place in the demo.
  for (const key of ['FRYDAY_CORE_SECRET', 'FRYDAY_DB', 'FRYDAY_RUNS', 'FRYDAY_WORKTREES', 'FRYDAY_SCRATCH', 'FRYDAY_SEED', 'FRYDAY_DEPS', 'FRYDAY_REPOS',
    'FRYDAY_ATTACHMENTS', 'FRYDAY_EVIDENCE', 'FRYDAY_CONCIERGE_DIR', 'FRYDAY_MODEL', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY']) delete env[key];
  return env;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function healthy(base: string): Promise<boolean> {
  try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
}

async function api(base: string, secret: string, method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-fryday-core-token': secret },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

/** Add the sample project the way the Projects page does, and confirm it. No run profile: the demo has no testers. */
async function addSampleProject(base: string, secret: string, clone: string): Promise<string> {
  const detected = await api(base, secret, 'POST', '/api/projects/detect', { path: clone });
  if (detected.status !== 200 || !detected.body?.facts) throw new Error(`could not read the sample project (${detected.status}): ${JSON.stringify(detected.body)}`);
  const { runProfile: _run, deployer: _deployer, deployerConfig: _config, ...facts } = detected.body.facts;
  const added = await api(base, secret, 'POST', '/api/projects', { ...facts, stgBranch: 'stg', verified: true });
  if (added.status !== 201) throw new Error(`could not add the sample project (${added.status}): ${JSON.stringify(added.body)}`);
  return String(added.body.name ?? facts.name);
}

function tail(file: string, lines = 20): string {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const port = Number(process.env['FRYDAY_DEMO_PORT'] ?? 7477);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) { console.error(`FRYDAY_DEMO_PORT must be a port number, got: ${process.env['FRYDAY_DEMO_PORT']}`); return 1; }
  const base = `http://127.0.0.1:${port}`;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch {
    console.error('The demo needs git. Install it, then run the demo again (fryday-code doctor shows how).');
    return 1;
  }
  if (await healthy(base)) {
    console.error(`Something is already running on port ${port} (an earlier demo?). Stop it, or pick another port with FRYDAY_DEMO_PORT.`);
    return 1;
  }

  const p = demoPaths();
  console.log('FryDay Code demo: stand-in agents, no AI calls, no cost. Nothing leaves this computer.');
  console.log(`  Setting up a throwaway install in ${p.root}`);
  resetDemoFolder(p);
  makeSampleRepo(p);
  writeStandIn(p);

  const log = fs.openSync(p.log, 'a');
  const core: ChildProcess = spawn(process.execPath, [require.resolve('tsx/cli'), path.join('src', 'server.ts')], {
    cwd: PACKAGE_DIR, env: demoEnv(p, port), stdio: ['ignore', log, log],
  });
  const stop = (signal: NodeJS.Signals) => { if (core.exitCode === null) core.kill(signal); };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  const exited = new Promise<number>((resolve) => core.on('exit', (code, signal) => resolve(code ?? (signal ? 0 : 1))));

  for (let i = 0; i < 150 && core.exitCode === null && !(await healthy(base)); i++) await sleep(200);
  if (core.exitCode !== null || !(await healthy(base))) {
    console.error(`The demo's FryDay Code did not start. The last lines of ${p.log}:\n${tail(p.log)}`);
    stop('SIGTERM');
    return 1;
  }

  try {
    const secret = fs.readFileSync(path.join(p.home, 'secret'), 'utf8').trim();
    const project = await addSampleProject(base, secret, p.clone);
    const link = await fetchLaunchLink(base, secret);
    if (!link.ok) throw new Error(`could not get a launch link (${link.status ?? 'no answer'})`);
    const opened = !argv.includes('--no-open') && !argv.includes('--print') && openInBrowser(link.url);
    console.log(`  Sample project: ${project} (with a staging branch; its "origin" is a folder in the demo)`);
    console.log('');
    console.log(`  Open (one-time link, valid 15 minutes): ${link.url}`);
    if (opened) console.log('  Opened in your browser.');
    console.log('');
    console.log(`  Give FryDay a task, for example: ${demoTask().description}`);
    console.log('  The stand-in agents follow a script: a question for you, a plan, a first build that fails');
    console.log('  the tests, a fix, a check, then your approval to merge into staging.');
    console.log('');
    console.log(`  Press Ctrl-C to stop. Everything is wiped the next time the demo starts. Log: ${p.log}`);
  } catch (err) {
    console.error(`The demo could not be set up: ${err instanceof Error ? err.message : String(err)}`);
    stop('SIGTERM');
    await exited;
    return 1;
  }
  return exited;
}

if (require.main === module) main().then((code) => process.exit(code), (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
