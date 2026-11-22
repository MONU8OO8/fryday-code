import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-supervisor-'));
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_RUNS = path.join(tmp, 'runs');
process.env.CLAUDE_BIN = path.join(__dirname, 'fixtures', 'fake-claude.mjs');
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';
process.env.FRYDAY_MAX_AGENTS = '2';

import { initDb, getDb } from '../src/db/db';
import {
  startRun, killRun, activeRunIds, reconcileRunsOnStartup, stopFollowing, CapacityError,
} from '../src/runner/supervisor';
import { countedTokens, getRunUsage, getUsageSince, recordAssistantUsage } from '../src/runner/usage';
import { awakeHolders, keepAwake } from '../src/runner/keepAwake';
import { BudgetError } from '../src/runner/supervisor';
import { defaultSettings, getSettings, updateSettings, runSettingsFor, SettingsError } from '../src/settings';
import { execFileSync } from 'node:child_process';

const cwd = path.join(tmp, 'cwd');

interface RunRow {
  state: string; pid: number | null; session_id: string | null; model: string | null;
  log_path: string; log_offset: number; error_msg: string | null; ended_at: number | null;
}
const row = (id: string) => getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow;

async function waitFor(what: string, cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const settled = (id: string) => () => !activeRunIds().includes(id);

function start(mode: string, delayMs: number, prompt = 'hello') {
  return startRun({ taskId: null, role: 'fryday', prompt, cwd, extraEnv: { FAKE_MODE: mode, FAKE_DELAY_MS: String(delayMs) } });
}

/** The fake agent echoes what it was given in its assistant message. */
function whatAgentSaw(logPath: string): { prompt: string; argv: string[]; hasCoreSecret: boolean; role: string; envKeys: string[] } {
  const line = fs.readFileSync(logPath, 'utf8').split('\n').find((l) => l.includes('"assistant"'));
  return JSON.parse(JSON.parse(line!).message.content[0].text);
}

before(() => { initDb(process.env.FRYDAY_DB!); });
afterEach(async () => {
  for (const id of activeRunIds()) killRun(id);
  await waitFor('all runs to settle', () => activeRunIds().length === 0);
});
after(() => { stopFollowing(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('a run completes and its usage equals the result event', async () => {
  const since = Date.now();
  const run = start('ok', 50);
  await waitFor('run to settle', settled(run.runId));

  const r = row(run.runId);
  assert.equal(r.state, 'completed');
  assert.equal(r.session_id, '11111111-2222-4333-8444-555555555555');
  assert.equal(r.model, 'fake-model');
  assert.equal(r.error_msg, null);
  assert.equal(r.log_offset, fs.statSync(r.log_path).size);

  // The assistant event said 3 output tokens; the result's 11 is the one that counts.
  const expected = { inputTokens: 7, outputTokens: 11, cacheReadTokens: 13, cacheWriteTokens: 17, costUsd: 0.25 };
  assert.deepEqual(getRunUsage(run.runId), expected);
  assert.deepEqual(getUsageSince(since), expected);
});

test('the prompt arrives on stdin, never argv, and policy flags are applied', async () => {
  const prompt = '--dangerously-skip-permissions please';
  const run = start('ok', 0, prompt);
  await waitFor('run to settle', settled(run.runId));

  const saw = whatAgentSaw(run.logPath);
  assert.equal(saw.prompt, prompt);
  assert.equal(saw.argv.includes(prompt), false);
  assert.equal(saw.argv.includes('--dangerously-skip-permissions'), false);
  assert.equal(saw.argv[saw.argv.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(saw.argv[saw.argv.indexOf('--tools') + 1], '', 'fryday gets no tools');
  assert.ok(saw.argv.includes('--strict-mcp-config'));
  assert.equal(saw.argv.includes('--mcp-config'), false);
  assert.equal(saw.hasCoreSecret, false, 'the core API secret must not reach an agent');
  assert.equal(saw.role, 'fryday');
  assert.equal(saw.argv[saw.argv.indexOf('--setting-sources') + 1], '', 'no settings files are loaded');
});

test('an agent inherits only a short list of environment variables', async () => {
  process.env.GITHUB_TOKEN = 'canary-not-a-real-token';
  process.env.JENKINS_API_TOKEN = 'canary-not-a-real-token';
  try {
    const run = start('ok', 0);
    await waitFor('run to settle', settled(run.runId));
    const keys = whatAgentSaw(run.logPath).envKeys;
    const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR',
      'FRYDAY_RUN_ID', 'FRYDAY_TASK_ID', 'FRYDAY_ROLE', 'FAKE_MODE', 'FAKE_DELAY_MS']);
    // Node adds a couple of its own variables to a child; nothing of core's may appear.
    const unexpected = keys.filter((k: string) => !allowed.has(k) && !k.startsWith('__CF') && k !== '_');
    assert.deepEqual(unexpected, []);
  } finally {
    delete process.env.GITHUB_TOKEN;
    delete process.env.JENKINS_API_TOKEN;
  }
});

test('a role with tools is refused without a workspace, and guarded with one', async () => {
  assert.throws(
    () => startRun({ taskId: null, role: 'coder', prompt: 'x', cwd }),
    /must be confined to a workspace/
  );

  const run = startRun({ taskId: null, role: 'coder', prompt: 'x', cwd, workspacePath: cwd, extraEnv: { FAKE_MODE: 'ok', FAKE_DELAY_MS: '0' } });
  await waitFor('run to settle', settled(run.runId));
  const saw = whatAgentSaw(run.logPath);
  assert.equal(saw.argv[saw.argv.indexOf('--tools') + 1], 'Read,Edit,Write,Bash,Grep,Glob');
  assert.equal(saw.argv[saw.argv.indexOf('--permission-mode') + 1], 'acceptEdits');

  const settingsPath = saw.argv[saw.argv.indexOf('--settings') + 1];
  assert.ok(settingsPath.startsWith(process.env.FRYDAY_RUNS!), 'guard files live in the runs directory');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hook = settings.hooks.PreToolUse[0];
  assert.equal(hook.matcher, '*');
  assert.equal(hook.hooks[0].onFailure, 'block');
  assert.match(hook.hooks[0].command, /hook\.mjs/);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.deepEqual(settings.sandbox.network.allowedDomains, []);
  assert.deepEqual(settings.sandbox.filesystem.denyRead, ['~/']);
  assert.ok(settings.sandbox.filesystem.allowRead.includes(cwd));
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.equal(settings.permissions.blockWritesOutsideWorkingDirectories, true);

  const policyPath = hook.hooks[0].command.match(/'([^']+\.policy\.json)'/)[1];
  assert.deepEqual(JSON.parse(fs.readFileSync(policyPath, 'utf8')), {
    role: 'coder', allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], readRoots: [cwd], writeRoots: [cwd], mcp: {},
  });
});

test('an agent that reports an error is marked failed with its message', async () => {
  const run = start('error', 0);
  await waitFor('run to settle', settled(run.runId));
  assert.equal(row(run.runId).state, 'failed');
  assert.equal(row(run.runId).error_msg, 'Not logged in');
});

test('an agent that dies without a result is marked failed with its stderr', async () => {
  const run = start('crash', 0);
  await waitFor('run to settle', settled(run.runId));
  assert.equal(row(run.runId).state, 'failed');
  assert.match(row(run.runId).error_msg ?? '', /boom/);
});

test('a run still going when core restarts is picked up and finishes', async () => {
  const run = start('ok', 700);
  await waitFor('init to be seen', () => row(run.runId).session_id !== null);
  const offsetAtStop = row(run.runId).log_offset;

  stopFollowing(); // core goes away; the agent keeps running
  assert.deepEqual(activeRunIds(), []);
  assert.equal(row(run.runId).state, 'running');

  reconcileRunsOnStartup(); // core comes back
  assert.deepEqual(activeRunIds(), [run.runId]);
  await waitFor('run to settle', settled(run.runId));

  const r = row(run.runId);
  assert.equal(r.state, 'completed');
  assert.ok(r.log_offset > offsetAtStop);
  assert.equal(r.log_offset, fs.statSync(r.log_path).size);
  assert.equal(getRunUsage(run.runId).outputTokens, 11);
});

test('a run that finished while core was down is completed from its log', async () => {
  const run = start('ok', 200);
  await waitFor('init to be seen', () => row(run.runId).session_id !== null);
  const pid = row(run.runId).pid!;

  stopFollowing();
  await waitFor('agent process to exit', () => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  });
  assert.equal(row(run.runId).state, 'running', 'nothing recorded the finish yet');

  reconcileRunsOnStartup();
  await waitFor('run to settle', settled(run.runId));
  assert.equal(row(run.runId).state, 'completed');
  assert.equal(getRunUsage(run.runId).costUsd, 0.25);
});

test('killRun stops the agent and marks the run killed', async () => {
  const run = start('ok', 5000);
  await waitFor('init to be seen', () => row(run.runId).session_id !== null);
  const pid = row(run.runId).pid!;

  assert.equal(killRun(run.runId), true);
  await waitFor('run to settle', settled(run.runId));
  assert.equal(row(run.runId).state, 'killed');
  assert.throws(() => process.kill(pid, 0));
  assert.equal(killRun(run.runId), false, 'a finished run cannot be stopped again');
});

test('the Mac is kept awake only while an agent is running', async () => {
  const caffeinated = () => {
    try { return execFileSync('pgrep', ['-f', `caffeinate -i -w ${process.pid}`], { encoding: 'utf8' }).trim() !== ''; } catch { return false; }
  };
  assert.equal(awakeHolders(), 0);
  const run = start('ok', 600);
  assert.equal(awakeHolders(), 1);
  if (process.platform === 'darwin') {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(caffeinated(), true, 'caffeinate should be running while the agent works');
  }
  await waitFor('run to settle', settled(run.runId));
  assert.equal(awakeHolders(), 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(caffeinated(), false, 'caffeinate must stop when nothing is running');

  // Releasing twice must not let the count go wrong.
  const release = keepAwake();
  release();
  release();
  assert.equal(awakeHolders(), 0);
});

test('each agent gets the model, effort and token limit from Settings', async () => {
  const saved = process.env.FRYDAY_MODEL;
  delete process.env.FRYDAY_MODEL;
  try {
    const flagsOf = async (opts: Partial<Parameters<typeof startRun>[0]>) => {
      const run = startRun({ taskId: null, role: 'fryday', prompt: 'x', cwd, extraEnv: { FAKE_MODE: 'ok', FAKE_DELAY_MS: '0' }, ...opts });
      await waitFor('run to settle', settled(run.runId));
      const argv = whatAgentSaw(run.logPath).argv;
      const flag = (name: string) => argv[argv.indexOf(name) + 1];
      const { token_limit } = getDb().prepare('SELECT token_limit FROM runs WHERE id = ?').get(run.runId) as { token_limit: number };
      return [flag('--model'), flag('--effort'), token_limit, flag('--max-budget-usd')];
    };
    // A chat reply gets the cheapest model; a coder a mid one, and a stronger one only from round 3.
    // The money flag is only the hidden safety cap, the same for every role.
    assert.deepEqual(await flagsOf({}), ['claude-haiku-5-5', 'low', 100_000, '25.0000']);
    assert.deepEqual(await flagsOf({ role: 'coder', workspacePath: cwd, round: 1 }), ['claude-sonnet-5-5', 'medium', 1_500_000, '25.0000']);
    assert.deepEqual(await flagsOf({ role: 'coder', workspacePath: cwd, round: 3 }), ['claude-opus-5-5', 'medium', 1_500_000, '25.0000']);
    // A run can be given fewer tokens than its role's limit, never more.
    assert.deepEqual(await flagsOf({ maxTokens: 1000 }), ['claude-haiku-5-5', 'low', 1000, '25.0000']);
    assert.deepEqual(await flagsOf({ maxTokens: 99_000_000 }), ['claude-haiku-5-5', 'low', 100_000, '25.0000']);
    assert.throws(() => startRun({ taskId: null, role: 'fryday', prompt: 'x', cwd, maxTokens: 0 }), BudgetError);
    assert.throws(() => startRun({ taskId: null, role: 'fryday', prompt: 'x', cwd, maxTokens: -5 }), BudgetError);

    // The safety cap comes from the environment only.
    process.env.FRYDAY_RUN_USD_CAP = '3';
    try {
      assert.equal((await flagsOf({}))[3], '3.0000');
    } finally {
      delete process.env.FRYDAY_RUN_USD_CAP;
    }

    // Changing a setting takes effect on the next run, and the limit is recorded with the run.
    updateSettings({ roles: { fryday: { model: 'claude-sonnet-5-5', effort: 'high', tokenLimit: 250_000 } } });
    assert.deepEqual(await flagsOf({}), ['claude-sonnet-5-5', 'high', 250_000, '25.0000']);
    const last = getDb().prepare('SELECT token_limit, budget_usd, deadline_at, started_at FROM runs ORDER BY started_at DESC LIMIT 1').get() as { token_limit: number; budget_usd: number | null; deadline_at: number; started_at: number };
    assert.equal(last.token_limit, 250_000);
    assert.equal(last.budget_usd, null, 'no money figure is stored with a run');
    assert.equal(last.deadline_at - last.started_at, 5 * 60_000);

    // FRYDAY_MODEL forces one model for every agent.
    process.env.FRYDAY_MODEL = 'claude-haiku-5-5';
    assert.deepEqual((await flagsOf({ role: 'coder', workspacePath: cwd, round: 5 }))[0], 'claude-haiku-5-5');
  } finally {
    if (saved === undefined) delete process.env.FRYDAY_MODEL; else process.env.FRYDAY_MODEL = saved;
    updateSettings({ roles: { fryday: defaultSettings().roles.fryday } });
  }
});

test('settings merge over the defaults and refuse anything invalid', () => {
  const before = getSettings();
  assert.deepEqual(before, defaultSettings());
  assert.equal(runSettingsFor('planner', 0, before).timeoutMs, 15 * 60_000);
  assert.equal(runSettingsFor('coder', 0, before).tokenLimit, 1_500_000);
  assert.equal(before.taskTokenLimit, 4_000_000);

  const changed = updateSettings({ taskTokenLimit: 3_000_000, roles: { tester: { model: 'claude-sonnet-5-5' } } });
  assert.equal(changed.taskTokenLimit, 3_000_000);
  assert.equal(changed.roles.tester.model, 'claude-sonnet-5-5');
  assert.equal(changed.roles.tester.effort, before.roles.tester.effort, 'what was not mentioned is kept');
  assert.deepEqual(changed.roles.coder, before.roles.coder);
  assert.deepEqual(getSettings(), changed, 'the change is stored');

  for (const bad of [
    { roles: { coder: { model: 'gpt-4' } } }, { taskTokenLimit: -1 }, { taskTokenLimit: 1.5 }, { taskTokenLimit: 1e12 },
    { roles: { coder: { tokenLimit: 0 } } }, { roles: { coder: { tokenLimit: 2500.5 } } }, { roles: { coder: { tokenLimit: 1e10 } } },
    { taskBudgetUsd: 3 }, { roles: { coder: { budgetUsd: 2 } } },
    { maxRounds: 0 }, { maxAgents: 99 }, { nonsense: true }, null, 'x',
  ]) {
    assert.throws(() => updateSettings(bad), SettingsError, JSON.stringify(bad));
  }
  assert.deepEqual(getSettings(), changed, 'a refused change stores nothing');
  updateSettings({ taskTokenLimit: before.taskTokenLimit, roles: { tester: before.roles.tester } });
  assert.deepEqual(getSettings(), before);
});

test('settings stored by a version with dollar limits still load: the old keys are dropped, the rest is kept', () => {
  const db = getDb();
  const old = JSON.parse(JSON.stringify(defaultSettings())) as Record<string, unknown> & { roles: Record<string, Record<string, unknown>> };
  delete old['taskTokenLimit'];
  old['taskBudgetUsd'] = 10;
  old['maxRounds'] = 5;
  for (const rs of Object.values(old.roles)) { delete rs['tokenLimit']; rs['budgetUsd'] = 2; }
  old.roles['planner']!['model'] = 'claude-sonnet-5-5';
  db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('settings', ?, 0)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(JSON.stringify(old));
  try {
    const s = getSettings();
    assert.equal(s.taskTokenLimit, 4_000_000);
    assert.equal(s.roles.coder.tokenLimit, 1_500_000);
    assert.equal(s.roles.planner.tokenLimit, 400_000);
    assert.equal(s.roles.planner.model, 'claude-sonnet-5-5', 'the other stored values are kept');
    assert.equal(s.maxRounds, 5);
    assert.equal('budgetUsd' in s.roles.coder, false);
    assert.equal('taskBudgetUsd' in s, false);
    // Saving from there stores the token settings only.
    updateSettings({ maxRounds: 4 });
    const stored = JSON.parse((db.prepare(`SELECT value_json FROM settings WHERE key = 'settings'`).get() as { value_json: string }).value_json);
    assert.equal(stored.taskBudgetUsd, undefined);
    assert.equal(stored.roles.coder.budgetUsd, undefined);
    assert.equal(stored.roles.coder.tokenLimit, 1_500_000);
  } finally {
    db.prepare(`DELETE FROM settings WHERE key = 'settings'`).run();
  }
  assert.deepEqual(getSettings(), defaultSettings());
});

test('a run that reaches the hidden money cap is marked as stopped at a limit, and its tokens are still counted', async () => {
  const run = start('budget', 0);
  await waitFor('run to settle', settled(run.runId));
  const r = row(run.runId);
  assert.equal(r.state, 'budget');
  assert.equal(r.error_msg, 'stopped: it reached its safety limit');
  // The result line carried no tokens; they come from the turn that was seen, the cost from the result.
  assert.deepEqual(getRunUsage(run.runId), { inputTokens: 7, outputTokens: 3, cacheReadTokens: 13, cacheWriteTokens: 17, costUsd: 0.75 });
});

test('counted tokens are input + output + cache writes; cache reads are not counted', () => {
  assert.equal(countedTokens({ inputTokens: 7, outputTokens: 11, cacheWriteTokens: 17 }), 35);
  assert.equal(countedTokens({ inputTokens: 7, outputTokens: 11, cacheReadTokens: 1_000_000, cacheWriteTokens: 17, costUsd: 9 } as Parameters<typeof countedTokens>[0]), 35);
});

test('a message streamed several times under one id keeps the largest of each counter', () => {
  const db = getDb();
  db.prepare(`INSERT INTO runs (id, task_id, role, round, state, log_path, started_at) VALUES ('run-stream', NULL, 'fryday', 0, 'completed', 'x', ?)`).run(Date.now());
  const event = (usage: Record<string, number>, id = 'msg_stream_1') =>
    ({ type: 'assistant', message: { id, role: 'assistant', model: 'm', content: [], usage }, session_id: 's' }) as unknown as Parameters<typeof recordAssistantUsage>[2];
  recordAssistantUsage('run-stream', null, event({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }));
  recordAssistantUsage('run-stream', null, event({ input_tokens: 10, output_tokens: 400, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }));
  // A repeat with smaller numbers (a finished message seen again) changes nothing.
  recordAssistantUsage('run-stream', null, event({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }));
  recordAssistantUsage('run-stream', null, event({ input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'msg_stream_2'));
  assert.deepEqual(getRunUsage('run-stream'), { inputTokens: 13, outputTokens: 402, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0 });
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE run_id = 'run-stream'`).get() as { n: number }).n, 2);

  // The same message id already stored for another run is still ignored, not an error.
  db.prepare(`INSERT INTO runs (id, task_id, role, round, state, log_path, started_at) VALUES ('run-stream-2', NULL, 'fryday', 0, 'completed', 'x', ?)`).run(Date.now());
  recordAssistantUsage('run-stream-2', null, event({ input_tokens: 999, output_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
  assert.equal(getRunUsage('run-stream-2').inputTokens, 0);
});

test('a run that keeps using tokens is stopped by core at its token limit', async () => {
  const run = startRun({ taskId: null, role: 'fryday', prompt: 'x', cwd, maxTokens: 50_000, extraEnv: { FAKE_MODE: 'tokens', FAKE_TOKENS_PER_TURN: '10000', FAKE_DELAY_MS: '0' } });
  await waitFor('init to be seen', () => row(run.runId).session_id !== null);
  const pid = row(run.runId).pid!;
  await waitFor('run to settle', settled(run.runId));
  const r = row(run.runId);
  assert.equal(r.state, 'budget');
  assert.equal(r.error_msg, 'stopped: it reached its token limit');
  assert.throws(() => process.kill(pid, 0), 'the agent process must be gone');
  const used = countedTokens(getRunUsage(run.runId));
  assert.ok(used > 50_000, `it used ${used}`);
  // Each turn is streamed twice; only the larger figure counts, so the total is whole turns of 10k.
  assert.equal((used - 27) % 10_001, 0, `it used ${used}`);
  assert.ok(used < 1_000_000, 'it was stopped long before it would have finished by itself');
  assert.equal(activeRunIds().length, 0);
  // The stop is signalled once: later ticks leave the reason, the end time and the state alone.
  const endedAt = r.ended_at;
  await new Promise((res) => setTimeout(res, 700));
  const later = row(run.runId);
  assert.deepEqual([later.state, later.error_msg, later.ended_at], ['budget', 'stopped: it reached its token limit', endedAt]);
});

test('a run over its token limit while core was down is stopped when core comes back', async () => {
  const run = startRun({ taskId: null, role: 'fryday', prompt: 'x', cwd, maxTokens: 30_000, extraEnv: { FAKE_MODE: 'tokens', FAKE_TOKENS_PER_TURN: '10000', FAKE_DELAY_MS: '100' } });
  await waitFor('init to be seen', () => row(run.runId).session_id !== null);
  const pid = row(run.runId).pid!;
  stopFollowing(); // core goes away; the agent keeps using tokens
  assert.equal(row(run.runId).state, 'running');
  await waitFor('the log to hold more than the limit', () => {
    const log = fs.readFileSync(row(run.runId).log_path, 'utf8');
    return (log.match(/"assistant"/g) ?? []).length >= 8;
  });
  reconcileRunsOnStartup(); // core comes back
  await waitFor('run to settle', settled(run.runId));
  const r = row(run.runId);
  assert.equal(r.state, 'budget');
  assert.equal(r.error_msg, 'stopped: it reached its token limit');
  await waitFor('agent process to exit', () => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

test('a run that goes past its time limit is stopped and frees its slot', async () => {
  const run = startRun({ taskId: null, role: 'fryday', prompt: 'x', cwd, timeoutMs: 700, extraEnv: { FAKE_MODE: 'hang' } });
  await waitFor('init to be seen', () => row(run.runId).session_id !== null);
  const pid = row(run.runId).pid!;
  await waitFor('run to settle', settled(run.runId));
  const r = row(run.runId);
  assert.equal(r.state, 'timeout');
  assert.equal(r.error_msg, 'stopped: it ran past its time limit');
  assert.throws(() => process.kill(pid, 0), 'the agent process must be gone');
  assert.equal(activeRunIds().length, 0);
});

test('no more agents start than the configured limit', async () => {
  start('ok', 3000);
  start('ok', 3000);
  assert.throws(() => start('ok', 0), CapacityError);
});
