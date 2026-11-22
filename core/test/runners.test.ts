import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-runners-'));
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
// Run files under the home folder, where FryDay keeps them (~/.fryday-code/runs), so the
// sandbox's home rule is in play for the files the agent writes its output to.
const runsInHome = fs.mkdtempSync(path.join(os.homedir(), '.fryday-runners-test-'));
process.env.FRYDAY_RUNS = path.join(runsInHome, 'runs');
process.env.CLAUDE_BIN = path.join(__dirname, 'fixtures', 'fake-claude.mjs');
process.env.CURSOR_AGENT_BIN = path.join(__dirname, 'fixtures', 'fake-cursor-agent.mjs');
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';
process.env.FRYDAY_MAX_AGENTS = '2';

import { initDb, getDb } from '../src/db/db';
import { startRun, killRun, activeRunIds, stopFollowing } from '../src/runner/supervisor';
import { getRunUsage } from '../src/runner/usage';
import { updateSettings, SettingsError, defaultSettings } from '../src/settings';
import { cursorRunner, sshRunner, runnerFor, lastJsonObject, saveCursorKey, removeCursorKey, cursorKeySet, RunnerConfigError } from '../src/runner/runners';

const FAKE_KEY = 'test-cursor-key-not-a-real-credential';
const cwd = path.join(tmp, 'checkout');

interface RunRow { state: string; engine: string; budget_usd: number | null; output_json: string | null; error_msg: string | null; log_path: string; model: string | null }
const row = (id: string) => getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow;
const logLines = (logPath: string) => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
const saw = (logPath: string) => logLines(logPath).find((l) => l['type'] === 'fake_saw')!;

async function waitFor(what: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const settled = (id: string) => () => !activeRunIds().includes(id);

const SCHEMA = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } };
function cursorRun(extraEnv: Record<string, string> = {}, opts: { role?: 'analyst' | 'planner'; workspace?: string; jsonSchema?: Record<string, unknown> } = {}) {
  const workspace = opts.workspace ?? cwd;
  return startRun({
    taskId: null, role: opts.role ?? 'analyst', engine: 'cursor', prompt: 'Read the task.', appendSystemPrompt: 'You are the analyst.',
    jsonSchema: opts.jsonSchema ?? SCHEMA, cwd: workspace, workspacePath: workspace, extraEnv,
  });
}

before(() => {
  initDb(process.env.FRYDAY_DB!);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# a checkout\n');
  saveCursorKey(FAKE_KEY);
});
afterEach(async () => {
  for (const id of activeRunIds()) killRun(id);
  await waitFor('all runs to settle', () => activeRunIds().length === 0);
});
after(() => { stopFollowing(); fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(runsInHome, { recursive: true, force: true }); });

// ─── Pieces ───────────────────────────────────────────────────────────────────

test('the answer is the last JSON object in the message', () => {
  assert.deepEqual(lastJsonObject('Here:\n```json\n{"a":1}\n```\nand finally\n```json\n{"a":2}\n```\n'), { a: 2 });
  assert.deepEqual(lastJsonObject('{"whole": true}'), { whole: true });
  assert.deepEqual(lastJsonObject('```\n{"plain": "fence"}\n```'), { plain: 'fence' });
  assert.equal(lastJsonObject('no json here'), undefined);
  assert.equal(lastJsonObject('```json\n[1,2]\n```'), undefined, 'a list is not an answer');
  assert.equal(lastJsonObject('```json\n{broken\n```'), undefined);
});

test('Cursor stream lines become the events the supervisor already understands', () => {
  const ctx = { wantsJson: true, seq: 0 };
  const n = (o: unknown) => cursorRunner.normalize(JSON.stringify(o), ctx);
  assert.deepEqual(n({ type: 'system', subtype: 'init', session_id: 's1', model: 'Composer' }).map((e) => [e.type, (e as any).session_id]), [['system', 's1']]);
  assert.deepEqual(n({ type: 'user', message: {} }), [], 'the echoed prompt is not an event');
  const said = n({ type: 'assistant', model_call_id: 'mc', message: { content: [{ type: 'text', text: 'hello' }] }, session_id: 's1' })[0] as any;
  assert.equal(said.message.content[0].text, 'hello');
  const tool = n({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { readToolCall: { args: { path: '/x' } } } })[0] as any;
  assert.deepEqual([tool.message.content[0].type, tool.message.content[0].name, tool.message.content[0].input], ['tool_use', 'Read', { path: '/x' }]);
  assert.deepEqual(n({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: {} }), [], 'a finished call is not counted twice');
  const result = n({ type: 'result', is_error: false, result: '```json\n{"summary":"s"}\n```', session_id: 's1', usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 } })[0] as any;
  assert.deepEqual(result.structured_output, { summary: 's' });
  assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 });
  assert.equal(result.total_cost_usd, 0, 'Cursor bills by plan: no dollar figure is made up');
  assert.equal((cursorRunner.normalize(JSON.stringify({ type: 'result', result: '{"a":1}' }), { wantsJson: false, seq: 0 })[0] as any).structured_output, undefined);
  assert.deepEqual(cursorRunner.normalize('not json', ctx), []);
});

test('only read-only roles may be set to Cursor, with a plain model name', () => {
  assert.throws(() => updateSettings({ roles: { coder: { engine: 'cursor' } } }), SettingsError);
  for (const role of ['tester', 'api_tester', 'ui_tester', 'fryday', 'system']) {
    assert.throws(() => updateSettings({ roles: { [role]: { engine: 'cursor' } } }), SettingsError, role);
  }
  assert.throws(() => updateSettings({ roles: { planner: { cursorModel: 'bad model; rm -rf' } } }), SettingsError);
  const s = updateSettings({ roles: { analyst: { engine: 'cursor', cursorModel: 'composer-2.5' }, planner: { engine: 'cursor' } } });
  assert.equal(s.roles.analyst.engine, 'cursor');
  assert.equal(s.roles.analyst.cursorModel, 'composer-2.5');
  assert.equal(s.roles.planner.engine, 'cursor');
  const back = updateSettings({ roles: { analyst: { engine: 'claude' }, planner: { engine: 'claude' } } });
  assert.equal(back.roles.analyst.engine, 'claude');
  assert.equal(defaultSettings().roles.analyst.engine, 'claude', 'Claude Code stays the default');
});

test('Cursor is never started for a role that changes code or reaches a service, and SSH is not offered', () => {
  for (const role of ['coder', 'tester', 'api_tester', 'ui_tester', 'fryday'] as const) {
    assert.throws(() => startRun({ taskId: null, role, engine: 'cursor', prompt: 'x', cwd, workspacePath: cwd }), /not used for the/, role);
  }
  assert.throws(() => cursorRunner.prepare({ runId: 'r', role: 'coder', model: 'auto', effort: 'low', budgetUsd: 1, prompt: 'x', workspacePath: cwd }), RunnerConfigError);
  assert.throws(() => cursorRunner.prepare({ runId: 'r', role: 'analyst', model: 'auto', effort: 'low', budgetUsd: 1, prompt: 'x' }), /must have a workspace/);
  assert.throws(() => cursorRunner.prepare({ runId: 'r', role: 'analyst', model: 'auto', effort: 'low', budgetUsd: 1, prompt: 'x', workspacePath: cwd, mcp: { configPath: '/x', tools: {} } }), /no MCP tools/);
  assert.equal(sshRunner.available().ok, false);
  assert.deepEqual(sshRunner.caps.roles, []);
  assert.throws(() => startRun({ taskId: null, role: 'analyst', engine: 'claude-ssh' as never, prompt: 'x', cwd, workspacePath: cwd }), /not used for the analyst/);
  assert.equal(runnerFor(undefined).id, 'claude');
});

test('without a Cursor key a Cursor agent does not start, and saying so is the error', () => {
  removeCursorKey();
  try {
    assert.equal(cursorKeySet(), false);
    assert.throws(() => cursorRun(), /no Cursor API key/);
    assert.throws(() => saveCursorKey('short'), RunnerConfigError);
    assert.throws(() => saveCursorKey('has a space in the middle of it for sure'), RunnerConfigError);
  } finally {
    saveCursorKey(FAKE_KEY);
  }
  const mode = fs.statSync(path.join(tmp, 'cursor-api-key')).mode & 0o777;
  assert.equal(mode, 0o600, 'the key file is readable by the owner only');
});

// ─── Real runs of the fake CLI, in the real sandbox ───────────────────────────

test('a Cursor analyst runs in ask mode, its answer is read from its last message, and its tokens are counted', async () => {
  process.env.GITHUB_TOKEN = 'canary-not-a-real-token';
  let run;
  try {
    run = cursorRun();
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
  await waitFor('run to settle', settled(run.runId));
  const r = row(run.runId);
  assert.equal(r.state, 'completed', r.error_msg ?? '');
  assert.equal(r.engine, 'cursor');
  assert.equal(r.budget_usd, null, 'no dollar limit is claimed for an engine that cannot stop at one');
  assert.equal(r.model, 'Fake Composer', 'the model is the one Cursor said it used');
  assert.equal(JSON.parse(r.output_json!).summary, 'A clear task, read by Cursor.');

  const s = saw(r.log_path);
  for (const flag of ['-p', '--trust']) assert.ok(s.argv.includes(flag), flag);
  assert.equal(s.argv[s.argv.indexOf('--mode') + 1], 'ask');
  assert.equal(s.argv[s.argv.indexOf('--sandbox') + 1], 'enabled');
  assert.equal(s.argv[s.argv.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(!s.argv.some((a: string) => a.includes('Read the task')), 'the prompt is never on the command line');
  assert.match(s.prompt, /# How you work\n\nYou are the analyst\./);
  assert.match(s.prompt, /# Your task\n\nRead the task\./);
  assert.match(s.prompt, /JSON schema/);
  assert.equal(s.hasKey, true);
  assert.ok(s.home.startsWith(process.env.FRYDAY_RUNS!), 'Cursor gets a throwaway home, not the owner\'s');
  assert.equal(s.envKeys.includes('FRYDAY_CORE_SECRET'), false);
  assert.equal(s.envKeys.includes('GITHUB_TOKEN'), false);
  assert.equal(fs.existsSync(s.home), false, 'the throwaway home is removed when the run ends');

  const usage = getRunUsage(run.runId);
  assert.equal(usage.inputTokens, 120);
  assert.equal(usage.outputTokens, 30);
  assert.equal(usage.cacheReadTokens, 40);
  assert.equal(usage.costUsd, 0);
});

test('a Claude agent never gets the Cursor key', async () => {
  const run = startRun({ taskId: null, role: 'fryday', prompt: 'x', cwd, extraEnv: { FAKE_MODE: 'ok', FAKE_DELAY_MS: '0' } });
  await waitFor('run to settle', settled(run.runId));
  const line = fs.readFileSync(run.logPath, 'utf8').split('\n').find((l) => l.includes('"assistant"'))!;
  const seen = JSON.parse(JSON.parse(line).message.content[0].text) as { envKeys: string[] };
  assert.equal(seen.envKeys.includes('CURSOR_API_KEY'), false);
  assert.equal(row(run.runId).engine, 'claude');
});

test('an answer without JSON, or an error, is not taken as an answer', async () => {
  const prose = cursorRun({ FAKE_CURSOR_MODE: 'nojson' });
  const failing = cursorRun({ FAKE_CURSOR_MODE: 'error' });
  await waitFor('runs to settle', () => settled(prose.runId)() && settled(failing.runId)());
  assert.equal(row(prose.runId).output_json, null);
  assert.equal(row(failing.runId).state, 'failed');
  assert.equal(row(failing.runId).output_json, null);
});

test('a hung Cursor agent is stopped, its whole sandbox with it', async () => {
  const run = startRun({ taskId: null, role: 'analyst', engine: 'cursor', prompt: 'x', cwd, workspacePath: cwd, timeoutMs: 1500, extraEnv: { FAKE_CURSOR_MODE: 'hang' } });
  await waitFor('run to settle', settled(run.runId));
  assert.equal(row(run.runId).state, 'timeout');
});

test('the sandbox around Cursor holds: only its copy of the code and its own home, and only Cursor\'s servers', async () => {
  // The checkout and a canary inside the owner's home: the case that matters, since FryDay
  // keeps its checkouts under ~/.fryday-code.
  const inHome = fs.mkdtempSync(path.join(os.homedir(), '.fryday-cursor-test-'));
  const canary = path.join(os.homedir(), `.fryday-cursor-canary-${randomBytes(6).toString('hex')}`);
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  // Ensure ~/.cursor exists so the sandbox has an actual file to block (not just a missing path).
  // On CI runners without Cursor installed the directory may be absent, which would produce ENOENT
  // instead of EPERM and would not prove the sandbox is working.
  const cursorDir = path.join(os.homedir(), '.cursor');
  const createdCursorDir = !fs.existsSync(cursorDir);
  if (createdCursorDir) fs.mkdirSync(cursorDir, { recursive: true });
  try {
    const checkout = path.join(inHome, 'checkout');
    fs.mkdirSync(checkout);
    fs.writeFileSync(path.join(checkout, 'README.md'), '# copy\n');
    fs.writeFileSync(canary, `CANARY-${randomBytes(8).toString('hex')}\n`, { mode: 0o600 });
    const run = cursorRun({ FAKE_CURSOR_MODE: 'probe', FAKE_CANARY: canary, FAKE_REAL_HOME: os.homedir(), FAKE_OUTSIDE: outside }, { workspace: checkout });
    await waitFor('run to settle', settled(run.runId), 40_000);
    const probes = logLines(row(run.runId).log_path).find((l) => l['type'] === 'fake_probe')?.['probes'] as Record<string, string> | undefined;
    assert.ok(probes, `the probe ran (${row(run.runId).error_msg ?? ''})`);
    if (process.env.FRYDAY_SHOW_PROBES) console.log(probes);
    assert.equal(probes['readCheckout'], 'done', 'it can read its copy of the code');
    assert.equal(probes['writeOwnHome'], 'done', 'it can write its own throwaway home');
    // Refused by the sandbox itself, not because something was missing.
    for (const held of ['readCanary', 'readOwnersCursor', 'readOwnersSsh', 'writeCheckout', 'writeOutside', 'directIp']) {
      assert.match(probes[held]!, /^refused: (EPERM|EACCES)/, `${held}: ${probes[held]}`);
    }
    assert.match(probes['directNetwork']!, /^refused/, `directNetwork: ${probes['directNetwork']}`);
    assert.equal(probes['proxyToOtherHost'], 'refused: 403', 'the proxy refuses a host other than Cursor\'s');
    assert.equal(fs.existsSync(path.join(checkout, 'cursor-was-here.txt')), false);
    assert.equal(fs.existsSync(path.join(outside, 'cursor-was-here.txt')), false);
  } finally {
    if (createdCursorDir) fs.rmdirSync(cursorDir);
    fs.rmSync(inHome, { recursive: true, force: true });
    fs.rmSync(canary, { force: true });
  }
});

// ─── The API ──────────────────────────────────────────────────────────────────

test('the Cursor key is set and removed only by the owner at the UI, and never shown', async () => {
  const express = (await import('express')).default;
  const { runnersRouter } = await import('../src/api/runners');
  const app = express();
  app.use(express.json());
  // Stands in for the auth layer: the header says how the caller signed in.
  app.use((req, res, next) => { res.locals['authVia'] = req.header('x-test-auth'); next(); });
  app.use('/api/runners', runnersRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/runners`;
  const call = (method: string, p: string, via: string, body?: unknown) =>
    fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', 'x-test-auth': via }, body: body ? JSON.stringify(body) : undefined });
  try {
    const NEW_KEY = 'another-test-key-not-a-real-credential';
    assert.equal((await call('PUT', '/cursor/key', 'secret', { key: NEW_KEY })).status, 403, 'a process with the core secret cannot set it');
    assert.equal((await call('DELETE', '/cursor/key', 'secret')).status, 403, 'nor remove it');
    assert.equal((await call('PUT', '/cursor/key', 'cookie', { key: 'short' })).status, 400);
    const set = await call('PUT', '/cursor/key', 'cookie', { key: NEW_KEY });
    assert.equal(set.status, 200);
    const listed = await (await call('GET', '', 'secret')).text();
    assert.equal(listed.includes(NEW_KEY) || listed.includes(FAKE_KEY), false, 'the key is never returned');
    const view = JSON.parse(listed) as { runners: Array<{ id: string; available: boolean; caps: { roles: string[] } }>; cursor: { keySet: boolean } };
    assert.equal(view.cursor.keySet, true);
    assert.deepEqual(view.runners.map((r) => r.id), ['claude', 'cursor', 'claude-ssh']);
    assert.deepEqual(view.runners.find((r) => r.id === 'cursor')!.caps.roles, ['analyst', 'planner']);
    assert.equal(view.runners.find((r) => r.id === 'claude-ssh')!.available, false);
    const removed = await (await call('DELETE', '/cursor/key', 'cookie')).json() as { cursor: { keySet: boolean } };
    assert.equal(removed.cursor.keySet, false);
  } finally {
    server.close();
    saveCursorKey(FAKE_KEY);
  }
});
