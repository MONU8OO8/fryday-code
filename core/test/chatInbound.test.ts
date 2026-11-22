// Reading the Chat space: signing in, linking the owner, and what the owner's messages do —
// with a stand-in Google, stand-in agents and real git.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// The sandbox runs on macOS and on Linux (bubblewrap); elsewhere there is none to test.
const skip = !['darwin', 'linux'].includes(process.platform);
const tmp = path.join(os.homedir(), '.fryday-code', `chat-inbound-test-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
const planFile = path.join(tmp, 'script.json');
const wrapper = path.join(tmp, 'claude-wrapper.sh');
fs.writeFileSync(wrapper, `#!/bin/sh\nexport FAKE_PLAN_FILE='${planFile}'\nexec node '${path.join(__dirname, 'fixtures', 'fake-claude.mjs')}' "$@"\n`, { mode: 0o755 });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_MAC_NOTIFY = 'off';
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_RUNS = path.join(tmp, 'runs');
process.env.FRYDAY_WORKTREES = path.join(tmp, 'worktrees');
process.env.FRYDAY_SCRATCH = path.join(tmp, 'scratch');
process.env.FRYDAY_MEMORY_WAIT_MS = '0';
process.env.CLAUDE_BIN = wrapper;
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';

import { initDb, getDb } from '../src/db/db';
import { saveProject } from '../src/registry/registry';
import { activeRunIds, stopFollowing } from '../src/runner/supervisor';
import { registerPipeline } from '../src/pipeline/pipeline';
import { registerLead } from '../src/pipeline/lead';
import { getTask } from '../src/pipeline/taskState';
import { latestApproval } from '../src/pipeline/approvals';
import { listQuestions } from '../src/pipeline/questions';
import { listMessages } from '../src/pipeline/thread';
import { saveWebhook, setChatTransport } from '../src/notify/chat';
import { registerOwnerNotifications } from '../src/notify/owner';
import { setGoogleTransport, saveClient, startSignIn, finishSignIn, googleStatus, GoogleAuthError, clearPendingSignIns } from '../src/chatin/google';
import { parseCommand } from '../src/chatin/commands';
import { inboundStatus, pollOnce, startLink, setReading, stopReading, threadOfTask, setPollIntervals, InboundError } from '../src/chatin/inbound';
import { StubGoogle } from './fixtures/stub-google';

const google = new StubGoogle();
const OWNER = { name: 'users/111', type: 'HUMAN' as const, displayName: 'The Owner' };
const MATE = { name: 'users/222', type: 'HUMAN' as const, displayName: 'A Teammate' };
const BOT = { name: 'users/app-other', type: 'BOT' as const, displayName: 'Some App' };
const REDIRECT = 'http://127.0.0.1:7475/oauth/google/callback';
const PLAN = { summary: 'Add mul.', approach: 'Export mul.', flow: [{ step: 'call', detail: 'mul' }], files: ['src/math.js'], criteria: ['mul(2, 3) returns 6'], testPlan: ['node --test'], risks: [], questions: [] };
const PASS = { verdict: 'pass', summary: 'ok', criteria: [{ criterion: PLAN.criteria[0], met: true, evidence: 'ran it' }], issues: [] };

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();
async function waitFor(what: string, cond: () => boolean, timeoutMs = 60_000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const tasks = () => getDb().prepare('SELECT id, title, description, state FROM tasks ORDER BY seq').all() as Array<{ id: string; title: string; description: string; state: string }>;
const lastPost = () => google.posted.at(-1)!;
const agents = (s: Record<string, unknown>) => { for (const f of [`${planFile}.count.json`, `${planFile}.calls.jsonl`]) fs.rmSync(f, { force: true }); fs.writeFileSync(planFile, JSON.stringify(s)); };

before(() => {
  const main = path.join(tmp, 'main');
  const origin = path.join(tmp, 'origin.git');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  sh(main, 'config', 'user.name', 'Owner');
  sh(main, 'config', 'user.email', 'owner@example.invalid');
  fs.writeFileSync(path.join(main, 'src', 'math.js'), 'exports.add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(main, 'package.json'), '{"name":"shop","version":"1.0.0"}\n');
  sh(main, 'add', '-A');
  sh(main, 'commit', '-q', '-m', 'init');
  sh(main, 'remote', 'add', 'origin', origin);
  sh(main, 'push', '-q', 'origin', 'main', 'main:stg');
  initDb(process.env.FRYDAY_DB!);
  registerPipeline();
  registerLead();
  registerOwnerNotifications();
  saveProject({ id: 'shop', name: 'Shop', localPath: main, prodBranch: 'main', stgBranch: 'stg', testCmd: 'node --test', verified: true });
  setGoogleTransport(google.http);
  setChatTransport(google.webhook);
  setPollIntervals(60_000, 60_000); // tests call pollOnce themselves
  saveWebhook(`https://chat.googleapis.com/v1/${google.space}/messages?key=k&token=t`);
});
after(async () => {
  stopReading();
  // A task started from Chat may still be working; let it finish before the folder goes.
  await waitFor('agents to finish', () => activeRunIds().length === 0, 60_000).catch(() => undefined);
  stopFollowing();
  setGoogleTransport(null);
  setChatTransport(null);
  // A sandboxed command of a task that has just finished can still be writing in here, and
  // a scratch folder left behind is harmless: never fail the run over clearing it up.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* the folder outlives the test; the machine clears it */ }
});

test('what the owner says is read as a command', () => {
  assert.deepEqual(parseCommand('task: Add a dark mode\nUse the system setting.\nproject: shop', false), { kind: 'new_task', title: 'Add a dark mode', description: 'Use the system setting.', project: 'shop' });
  assert.deepEqual(parseCommand('New task: fix login', false), { kind: 'new_task', title: 'fix login', description: 'fix login', project: null });
  assert.equal(parseCommand('please fix login', false).kind, 'unknown', 'a new task must say task:');
  assert.equal(parseCommand('task:', false).kind, 'unknown');
  const long = `task: ${'x'.repeat(200)}`;
  const t = parseCommand(long, false) as { title: string; description: string };
  assert.equal(t.title.length, 120);
  assert.equal(t.description, 'x'.repeat(200), 'nothing said is lost');
  assert.deepEqual(parseCommand('approve 123456', true), { kind: 'approve', code: '123456' });
  assert.deepEqual(parseCommand('Decline: 654321', true), { kind: 'decline', code: '654321' });
  assert.deepEqual(parseCommand('approve', true), { kind: 'missing_code', decision: 'approve' });
  assert.deepEqual(parseCommand('approve 12345', true), { kind: 'answer', index: null, text: 'approve 12345' }, 'a code is six digits');
  assert.deepEqual(parseCommand('go ahead', true), { kind: 'go_ahead' });
  assert.deepEqual(parseCommand('start', true), { kind: 'start_proposal' });
  assert.deepEqual(parseCommand('Start this task.', true), { kind: 'start_proposal' });
  assert.deepEqual(parseCommand('stop', true), { kind: 'stop' });
  assert.deepEqual(parseCommand('stop the deploy please', true), { kind: 'answer', index: null, text: 'stop the deploy please' }, 'a sentence is for the Lead, not a command');
  assert.deepEqual(parseCommand('2: use the system setting', true), { kind: 'answer', index: 2, text: 'use the system setting' });
  assert.deepEqual(parseCommand('note: the API is slow on Mondays', true), { kind: 'note', text: 'the API is slow on Mondays' });
  assert.deepEqual(parseCommand('status', false), { kind: 'status' });
  assert.deepEqual(parseCommand('help', true), { kind: 'help' });
});

test('signing in with Google: only a sign-in this install started, with its own proof, and only once', async () => {
  assert.throws(() => startSignIn(REDIRECT), GoogleAuthError, 'no client yet');
  assert.throws(() => saveClient({ clientId: 'not-an-id', clientSecret: 'x' }), /looks like/);
  saveClient({ clientId: google.clientId, clientSecret: google.clientSecret });
  assert.throws(() => startSignIn('https://evil.example/callback'), /only come back to this computer/);
  const url = new URL(startSignIn(REDIRECT));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/chat.messages.readonly', 'read-only, and nothing else');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');

  // An answer for a sign-in FryDay did not start, or a replayed one, is refused.
  await assert.rejects(() => finishSignIn({ code: 'code-x', state: 'made-up' }), /not one FryDay started/);
  const { code, state } = google.consent(url.href);
  await assert.rejects(() => finishSignIn({ code: 'wrong-code', state }), /refused/);
  await assert.rejects(() => finishSignIn({ code, state }), /not one FryDay started/, 'the state is used up even by a failed attempt');

  clearPendingSignIns();
  const again = google.consent(startSignIn(REDIRECT));
  const status = await finishSignIn(again);
  assert.equal(status.signedIn, true);
  const stored = path.join(tmp, 'google-chat.json');
  assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(googleStatus()).includes('refresh-stub') && !JSON.stringify(googleStatus()).includes(google.clientSecret), 'no secret in what the UI gets');
});

test('linking: the person who posts the code becomes the owner; nobody else is listened to', { skip }, async () => {
  assert.throws(() => setReading(true), InboundError, 'not before linking');
  const s = startLink();
  assert.match(s.linking!.code, /^fryday-link-\d{6}$/);
  google.say(MATE, 'hello everyone');
  google.say(BOT, `here is the code ${s.linking!.code}`);
  google.say(OWNER, `${s.linking!.code}`);
  await pollOnce();
  const status = inboundStatus();
  assert.equal(status.owner, 'The Owner');
  assert.equal(status.linking, null);
  assert.match(lastPost().text, /Linked\. FryDay takes instructions here from The Owner only/);

  // Messages from before reading started are not acted on; a teammate's are skipped.
  agents({ planner: PLAN, coder: [{ write: { 'src/math.js': 'exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n' } }], tester: [PASS] });
  google.say(MATE, 'task: delete the production database');
  google.say(BOT, 'task: something from another app');
  await pollOnce();
  assert.equal(tasks().length, 0);
  assert.ok(inboundStatus().skippedOthers >= 1);
});

test("the owner's task becomes one task, even if the message is seen twice or sent twice", { skip }, async () => {
  const m = google.say(OWNER, 'task: Add mul\nExport mul(a, b) from src/math.js.\nproject: shop');
  await pollOnce();
  await pollOnce();
  // The same message delivered again (an overlapping read).
  google.redeliver(m);
  await pollOnce();
  // The same text sent again by the owner within minutes.
  google.say(OWNER, 'task: Add mul\nExport mul(a, b) from src/math.js.\nproject: shop');
  await pollOnce();
  assert.deepEqual(tasks().map((t) => [t.id, t.title, t.description]), [['T-1', 'Add mul', 'Export mul(a, b) from src/math.js.']]);
  assert.match(lastPost().text, /That is already T-1; no second task was made\./);
  assert.equal(threadOfTask('T-1'), m.thread, "the task's thread is where it was asked for");
  assert.ok(google.posted.some((p) => p.thread === m.thread && /Got it: T-1 "Add mul"\. Working in shop\./.test(p.text)));
  await waitFor('T-1 to pass review', () => getTask('T-1')!.state === 'awaiting_approval' && activeRunIds().length === 0 && latestApproval('T-1')?.state === 'pending');
});

test('approving from Chat needs the code; a forged approval is refused', { skip }, async () => {
  const ticket = latestApproval('T-1')!;
  const thread = threadOfTask('T-1')!;
  const announcement = google.posted.find((p) => p.thread === thread && /Needs your decision/.test(p.text))!;
  assert.match(announcement.text, new RegExp(`Reply \`approve ${ticket.code}\` or \`decline ${ticket.code}\``), 'the code is in the thread, for the owner to answer with');

  const wrong = ticket.code === '111111' ? '222222' : '111111';
  google.say(OWNER, `approve ${wrong}`, thread);
  google.say(MATE, `approve ${ticket.code}`, thread);        // right code, wrong person
  google.say(BOT, `approve ${ticket.code}`, thread);         // right code, an app
  google.say(OWNER, `approve ${ticket.code}`, 'spaces/AAAAstub/threads/elsewhere'); // right person and code, not the task's thread
  google.say(OWNER, 'approve', thread);
  await pollOnce();
  assert.equal(latestApproval('T-1')!.id, ticket.id);
  assert.equal(latestApproval('T-1')!.state, 'pending', 'none of those approved anything');
  assert.ok(google.posted.some((p) => /That code does not match the decision that is waiting\. Nothing was approved or declined\./.test(p.text)));
  assert.ok(google.posted.some((p) => /To approve, add the code/.test(p.text)));

  google.say(OWNER, `approve ${ticket.code}`, thread);
  await pollOnce();
  assert.equal(getApprovalState(ticket.id) === 'approved' || getApprovalState(ticket.id) === 'executed', true);
  assert.equal(getDb().prepare('SELECT resolved_by FROM approvals WHERE id = ?').get(ticket.id) && (getDb().prepare('SELECT resolved_by FROM approvals WHERE id = ?').get(ticket.id) as { resolved_by: string }).resolved_by, 'chat');
  await waitFor('the release', () => ['needs_owner', 'deployed'].includes(getTask('T-1')!.state) && activeRunIds().length === 0);
  // The same message cannot be used twice: the ticket is spent.
  google.say(OWNER, `approve ${ticket.code}`, thread);
  await pollOnce();
  assert.match(lastPost().text, /Nothing is waiting for your decision on T-1\./);
});
const getApprovalState = (id: string) => (getDb().prepare('SELECT state FROM approvals WHERE id = ?').get(id) as { state: string }).state;

test('questions are answered, skipped and noted from the thread', { skip }, async () => {
  agents({
    analyst: [{ summary: 'Unclear.', requirements: ['Something'], areas: [], assumptions: [], risks: [], questions: [{ question: 'Which colour?', why: 'Not said', options: ['Red', 'Blue'] }, { question: 'Where?', why: 'Not said', options: [] }], continueOn: '', continueWhy: '' }, { summary: 'Clear now.', requirements: ['Blue, in the header'], areas: [], assumptions: [], risks: [], questions: [], continueOn: '', continueWhy: '' }],
    planner: PLAN, coder: [{ write: { 'src/math.js': 'exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n' } }], tester: [PASS],
    fryday: [{ reply: 'I will keep the old colours as a fallback.', action: 'none', instructions: '', project: '', title: '' }],
  });
  const m = google.say(OWNER, 'task: Make it nicer\nproject: shop');
  await pollOnce();
  const id = tasks().at(-1)!.id;
  await waitFor('the questions', () => getTask(id)!.state === 'waiting_owner');
  const questionsPost = google.posted.find((p) => p.thread === m.thread && /Which colour\?/.test(p.text));
  assert.ok(questionsPost, 'the questions came into the thread');

  google.say(OWNER, 'just make it blue', m.thread);   // two questions open: kept as a note, and told how to answer
  await pollOnce();
  assert.match(lastPost().text, /There are 2 questions open; start your answer with its number/);
  assert.ok(listMessages(id).some((x) => x.author === 'owner' && x.body === 'just make it blue'));

  google.say(OWNER, '1: 2', m.thread);                // answered by option number
  await pollOnce();
  assert.equal(listQuestions(id).find((q) => q.question === 'Which colour?')!.answer, 'Blue');
  assert.match(lastPost().text, /Thanks\. 1 question still open\./);
  google.say(OWNER, 'In the header', m.thread);       // the only one left: a plain message answers it
  await pollOnce();
  assert.equal(listQuestions(id).find((q) => q.question === 'Where?')!.answer, 'In the header');
  assert.match(lastPost().text, /Thanks — going on\./);
  await waitFor('work to go on', () => getTask(id)!.state !== 'waiting_owner');

  google.say(OWNER, 'note: keep the old colours as a fallback', m.thread);
  await pollOnce();
  assert.ok(listMessages(id).some((x) => x.body === 'keep the old colours as a fallback'));
  // The Lead reads it and answers in the same thread, instead of "the next agent reads it".
  await waitFor('the Lead to answer in the thread', () => google.posted.some((p) => p.thread === m.thread && /I will keep the old colours as a fallback\./.test(p.text)));
  google.say(OWNER, 'status', m.thread);
  await pollOnce();
  assert.match(lastPost().text, new RegExp(`^${id} is `));
});

test('the Lead proposes a task in the thread; start and stop work from Chat', { skip }, async () => {
  agents({
    planner: PLAN, coder: [{ write: { 'src/math.js': 'exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a - b;\n' } }], tester: [PASS],
    fryday: [{ reply: 'The other side must change too. I have put a task for Shop below.', action: 'new_task', instructions: 'Add a search filter to the list.', project: 'shop', title: 'Filter the list' }],
  });
  const m = google.say(OWNER, 'task: Add sub\nproject: shop');
  await pollOnce();
  const id = tasks().at(-1)!.id;
  await waitFor('the task to come to rest', () => getTask(id)!.state === 'awaiting_approval' && activeRunIds().length === 0);

  google.say(OWNER, 'does the other side need to change too?', m.thread);
  await pollOnce();
  await waitFor('the proposal in the thread', () => google.posted.some((p) => p.thread === m.thread && /A task for Shop: Filter the list\nReply `start` in this thread to start it/.test(p.text)));
  assert.ok(google.posted.some((p) => p.thread === m.thread && /The other side must change too\./.test(p.text)), 'its answer came first');

  google.say(OWNER, 'start', m.thread);
  await pollOnce();
  const follow = tasks().at(-1)!;
  assert.deepEqual([follow.title, follow.id !== id], ['Filter the list', true]);
  assert.ok(google.posted.some((p) => p.thread === m.thread && new RegExp(`^Started ${follow.id}: Filter the list`).test(p.text)));
  google.say(OWNER, 'start', m.thread);               // nothing left to start
  await pollOnce();
  assert.ok(google.posted.some((p) => /There is no proposed task waiting to be started here\./.test(p.text)));

  await waitFor('the follow-up to come to rest', () => ['awaiting_approval', 'needs_owner', 'failed'].includes(getTask(follow.id)!.state) && activeRunIds().length === 0);
  google.say(OWNER, 'stop', m.thread);
  await pollOnce();
  assert.equal(getTask(id)!.state, 'needs_owner');
  assert.ok(google.posted.some((p) => p.thread === m.thread && /^Stopped\. Nothing already done is undone/.test(p.text)));
  google.say(OWNER, 'stop', m.thread);
  await pollOnce();
  assert.ok(google.posted.some((p) => /There is nothing to stop on this task right now\./.test(p.text)));
});

test('reading off means nothing is acted on, and a broken sign-in is reported, not guessed around', { skip }, async () => {
  setReading(false);
  const before = tasks().length;
  google.say(OWNER, 'task: while reading is off');
  await pollOnce();
  await new Promise((r) => setTimeout(r, 30)); // switched on a moment later, as a person would
  assert.equal(tasks().length, before);
  setReading(true);
  await pollOnce();
  assert.equal(tasks().length, before, 'what was said while reading was off is not acted on later');

  google.failWith = 403;
  await pollOnce();
  assert.match(inboundStatus().lastError ?? '', /refused to show this space/);
  google.failWith = null;
  await pollOnce();
  assert.equal(inboundStatus().lastError, null);
  stopReading();
});
