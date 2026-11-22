// The team chat, built from stored facts only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askAgainOf, buildStory, outcomeOf, plainApproval, storyNow, type StoryInput, type StoryItem } from '../src/pipeline/story';
import { NO_ANSWER } from '../src/pipeline/questions';
import type { Round } from '../src/pipeline/rounds';
import type { Verification } from '../src/verify/report';

const check = (status: 'passed' | 'failed' | 'timeout') => ({ name: 'test' as const, cmd: 'npm test', status, exitCode: status === 'passed' ? 0 : 1, durationMs: 1 });
const verdict = (met: boolean[]) => ({
  verdict: met.every(Boolean) ? 'pass' as const : 'fail' as const,
  summary: 'See src/cart/total.js',
  criteria: met.map((m, i) => ({ criterion: `point ${i + 1} in src/cart/total.js`, met: m, evidence: '' })),
  issues: [],
});
function round(n: number, at: number, opts: { checks?: 'passed' | 'failed' | 'timeout'; met?: boolean[]; verify?: Verification; flags?: Round['flags'] } = {}): Round & { createdAt: number } {
  return { taskId: 'T-1', round: n, headSha: 'abc', checks: [check(opts.checks ?? 'passed')], flags: opts.flags ?? [], verdict: opts.met ? verdict(opts.met) : null, verify: opts.verify ?? null, outcome: null, feedback: null, createdAt: at };
}
const base = (change: Partial<StoryInput> = {}): StoryInput => ({
  task: { id: 'T-1', title: 'Add a CSV export', description: 'Add a button that downloads orders as CSV', state: 'coding', createdAt: 100, note: null },
  projectName: 'Shop backend', brief: null, plan: null, questions: [], rounds: [], notes: [], agentEvents: [], approvals: [], release: null, deploy: null, outcome: null,
  ...change,
});
const line = (items: StoryItem[]) => items.map((i) => `${i.from}${i.to ? `>${i.to}` : ''}:${i.kind}`);
const PUSHES = ['feat/x → origin/feat/x (a new branch)', 'a merge commit → origin/staging (not forced)'];

test('a clean task reads as one conversation, from your words to the approval', () => {
  const items = buildStory(base({
    task: { ...base().task, state: 'awaiting_approval' },
    brief: { summary: 'You want a CSV export of orders.', at: 200 },
    plan: { summary: 'Add an export button.', criteria: 4, at: 300 },
    rounds: [round(1, 400, { met: [true, true, true, true] })],
    approvals: [{ id: 'apr-1', action: 'release_stg', state: 'pending', payload: { summary: 'Push and merge', pushes: PUSHES, repoName: 'Shop backend' }, requestedAt: 500, resolvedAt: null }],
  }));
  assert.deepEqual(line(items), ['you:note', 'understander:said', 'planner>builder:handoff', 'builder>checks:handoff', 'checker:said', 'releaser>you:approval']);
  assert.equal(items[0]!.text, 'Add a button that downloads orders as CSV');
  assert.match(items[2]!.text, /^Here's the plan: Add an export button\. 4 things must be true when it's done\.$/);
  assert.equal(items[4]!.text, 'It meets all 4 points of the plan.');
  const approval = items[5]!.action;
  assert.equal(approval?.kind, 'approve');
  if (approval?.kind === 'approve') {
    assert.deepEqual(approval.effects, PUSHES, 'the technical list is copied word for word');
    assert.match(approval.plain, /Shop backend.*staging.*Nothing goes live for customers/);
  }
});

test('a failed check and an unmet point both go back to the Builder', () => {
  const items = buildStory(base({
    rounds: [round(1, 400, { checks: 'failed' }), round(2, 500, { met: [true, false] }), round(3, 600, { checks: 'timeout' })],
  }));
  const backs = items.filter((i) => i.kind === 'sendback');
  assert.deepEqual(backs.map((b) => `${b.from}>${b.to}`), ['checks>builder', 'checker>builder', 'checks>builder']);
  assert.equal(backs[0]!.text, 'The tests did not pass. Back to you.');
  assert.match(backs[1]!.text, /^1 of 2 points is not met yet: point 2 in total\.js\. Back to you\.$/);
  assert.equal(backs[2]!.text, 'The tests took too long. Back to you.');
  assert.deepEqual(items.filter((i) => i.kind === 'handoff' && i.from === 'builder').map((i) => i.text), ['Done. Please check it.', 'Fixed. Please check again.', 'Fixed. Please check again.']);
});

test('an open question can be answered from the chat; an answered one shows your answer', () => {
  const items = buildStory(base({
    task: { ...base().task, state: 'waiting_owner' },
    questions: [
      { id: 'q1', kind: 'clarify', question: 'Which colour?', options: [{ value: 'blue', label: 'Blue' }], askedBy: 'analyst', askedAt: 200, answer: 'blue', answeredAt: 250 },
      { id: 'q2', kind: 'clarify', question: 'Include phone numbers?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], askedBy: 'analyst', askedAt: 260, answer: null, answeredAt: null },
    ],
  }));
  assert.deepEqual(line(items), ['you:note', 'understander>you:question', 'you:note', 'understander>you:question']);
  assert.equal(items[1]!.action, null);
  assert.equal(items[2]!.text, 'Blue');
  assert.deepEqual(items[3]!.action, { kind: 'answer', questionId: 'q2', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], freeText: true });
});

test('only a clarifying question takes a written answer; a project or branch question is a choice', () => {
  const ask = (id: string, kind: 'clarify' | 'project' | 'branch') => ({ id, kind, question: `Question ${id}?`, options: [{ value: 'a', label: 'A' }], askedBy: 'analyst', askedAt: 200, answer: null, answeredAt: null });
  const items = buildStory(base({ task: { ...base().task, state: 'waiting_owner' }, questions: [ask('q1', 'clarify'), ask('q2', 'project'), ask('q3', 'branch')] }));
  const free = items.filter((i) => i.action?.kind === 'answer').map((i) => (i.action?.kind === 'answer' ? i.action.freeText : null));
  assert.deepEqual(free, [true, false, false]);
});

test('a token limit asks in plain words, in tokens and never in money', () => {
  assert.equal(plainApproval('continue_budget', { stage: { role: 'coder', round: 2 }, why: 'agent', usedTokens: 2_100_000 }, null), 'The Builder reached its token limit for one go. Let it go on?');
  assert.equal(plainApproval('continue_budget', { why: 'task', usedTokens: 1_234_567 }, null), 'This task has used its token budget (1.2M tokens). Let it go on?');
  assert.equal(plainApproval('continue_budget', { why: 'task' }, null), 'This task has used its token budget. Let it go on?');
  // A ticket stored by an earlier version (in dollars) shows no money figure.
  assert.doesNotMatch(plainApproval('continue_budget', { why: 'task', spentUsd: 10 }, null), /\$|spen/);
  assert.match(plainApproval('deploy_stg', { repoName: 'Shop backend' }, null), /staging server/);
  assert.equal(plainApproval('something_new', { summary: 'Do the thing in src/a/b.ts' }, null), 'Do the thing in b.ts');
});

test('testers report what they tried', () => {
  const verify: Verification = {
    status: 'failed', service: null, dataConnections: [], unavailable: [], refused: [], evidence: [],
    testers: [
      { kind: 'api', runId: 'r1', calls: 7, passed: false, report: { verdict: 'fail', summary: 'Empty file has no header row.', criteria: [], issues: [], notTested: [] } },
      { kind: 'ui', runId: 'r2', calls: 4, passed: true, report: null },
    ],
  };
  const items = buildStory(base({ rounds: [round(1, 400, { met: [true], verify })] }));
  const app = items.find((i) => i.from === 'app_tester')!;
  assert.equal(app.kind, 'sendback');
  assert.equal(app.text, 'Tried the app 7 times. Empty file has no header row. Back to you.');
  assert.equal(items.find((i) => i.from === 'page_tester')!.text, 'Used the pages 4 times: it works as planned.');
});

test('your decisions and the release appear, and a stop is explained', () => {
  const items = buildStory(base({
    task: { ...base().task, state: 'deployed' },
    approvals: [{ id: 'apr-1', action: 'release_stg', state: 'executed', payload: { summary: 's', pushes: PUSHES }, requestedAt: 500, resolvedAt: 600 }],
    release: { id: 'rel-1', state: 'pushed', at: 605 },
  }));
  assert.deepEqual(line(items).slice(-3), ['releaser>you:approval', 'you:note', 'releaser:outcome']);
  assert.equal(items.at(-2)!.text, 'Approved.');
  assert.equal(items.at(-1)!.text, 'The change is on staging.');
  assert.equal(items.find((i) => i.kind === 'approval')!.action, null, 'a decided approval has no buttons');

  const stopped = buildStory(base({ task: { ...base().task, state: 'needs_owner', note: 'The planner failed: see src/x.ts' } }));
  assert.equal(stopped.at(-1)!.text, 'I stopped and need you: The planner failed: see x.ts');
});

test('no paths in any text, and ids stay the same between calls', () => {
  const input = base({
    brief: { summary: 'Change src/orders/export.ts', at: 200 },
    plan: { summary: 'Edit lib/csv/write.js', criteria: 1, at: 300 },
    rounds: [round(1, 400, { met: [false] }), round(2, 500, { met: [true] })],
    agentEvents: [{ id: 7, author: 'analyst', body: 'This is for Shop backend. It names app/models/order.rb', at: 150 }],
    notes: [{ id: 9, body: 'Please also add phone numbers', at: 450 }],
  });
  const a = buildStory(input);
  const b = buildStory(input);
  assert.deepEqual(a.map((i) => i.id), b.map((i) => i.id));
  assert.equal(new Set(a.map((i) => i.id)).size, a.length, 'ids are unique');
  for (const item of a) assert.doesNotMatch(item.text, /[\w.-]\/[\w.-]/, item.id);
  assert.deepEqual(a.map((i) => i.at), [...a.map((i) => i.at)].sort((x, y) => x - y), 'oldest first');
});

test('the brief is not said twice when the Analyst also posted it as an event', () => {
  const items = buildStory(base({ brief: { summary: 'Same words.', at: 200 }, agentEvents: [{ id: 1, author: 'analyst', body: 'Same words.', at: 199 }] }));
  assert.equal(items.filter((i) => i.text === 'Same words.').length, 1);
});

test('right now: who is working and what they are doing', () => {
  assert.deepEqual(storyNow({ role: 'coder', tools: ['Bash'], toolInputs: ['npm test'], text: '', since: 5 }), { actor: 'builder', text: 'Running the tests', since: 5 });
  assert.equal(storyNow(null), null);
});

// ─── Endings, and the branches not covered above ──────────────────────────────

type Approval = StoryInput['approvals'][number];
const ticket = (id: string, action: string, state: string, requestedAt: number, payload: Record<string, unknown> = { summary: 's' }): Approval =>
  ({ id, action, state, payload, requestedAt, resolvedAt: state === 'pending' ? null : requestedAt + 10 });
const BANNED = /\b[0-9a-f]{7,40}\b|\b(token|mcp|worktree|run|round|diff|commit|branch|ci|sandbox|guard)\b/i;

test('how a task that is back with the owner ended, from stored facts', () => {
  const released = { state: 'needs_owner', approvals: [ticket('a1', 'release_stg', 'executed', 500)], release: { state: 'pushed', at: 520 }, deploy: null, hasStaging: true, hasDeployer: false, lastRunAt: 300 };
  assert.equal(outcomeOf(released), 'on_staging_no_deploy');
  const pushed = { state: 'needs_owner', approvals: [ticket('a1', 'push_branch', 'executed', 500)], release: null, deploy: null, hasStaging: false, hasDeployer: false, lastRunAt: null };
  assert.equal(outcomeOf(pushed), 'handed_over');
  // A deployer that could not be offered, or a staging release that could not be asked for: those need the owner.
  assert.equal(outcomeOf({ ...released, hasDeployer: true }), null);
  assert.equal(outcomeOf({ ...pushed, hasStaging: true }), null);
  // A project with a deployer: the deploy ticket is pending, Your OK really is waiting.
  assert.equal(outcomeOf({ ...released, state: 'awaiting_approval', approvals: [...released.approvals, ticket('a2', 'deploy_stg', 'pending', 600)] }), null);
  assert.equal(outcomeOf({ ...released, approvals: [...released.approvals, ticket('a2', 'deploy_stg', 'pending', 600)] }), null);
  // A deploy that was started and failed is not "deploy it yourself".
  assert.equal(outcomeOf({ ...released, deploy: { at: 700 } }), null);
  // You declined the deploy: not an ending FryDay chose.
  assert.equal(outcomeOf({ ...released, approvals: [...released.approvals, ticket('a2', 'deploy_stg', 'rejected', 600)] }), null);
  // The push went out, then the staging release stopped: that needs the owner.
  assert.equal(outcomeOf({ ...pushed, approvals: [...pushed.approvals, ticket('a2', 'release_stg', 'executed', 600)], release: { state: 'stopped', at: 620 } }), null);
  assert.equal(outcomeOf({ ...pushed, state: 'coding' }), null);
  assert.equal(outcomeOf({ ...pushed, approvals: [ticket('a1', 'push_branch', 'approved', 500)] }), null, 'approved but the push did not happen');
  assert.equal(outcomeOf({ ...pushed, approvals: [ticket('a1', 'release_stg', 'rejected', 500)] }), null);
});

test('a successful ending is said in plain words, not as a stop', () => {
  const note = 'Merged into staging and pushed (merge 2a85c981). Deploy staging yourself: this project has no deployer set up.';
  const staging = buildStory(base({
    task: { ...base().task, state: 'needs_owner', note },
    approvals: [ticket('a1', 'release_stg', 'executed', 500)], release: { id: 'rel-1', state: 'pushed', at: 520 }, outcome: 'on_staging_no_deploy',
  }));
  assert.equal(staging.at(-1)!.text, 'This project has no automatic deploy, so deploy staging yourself.');
  assert.equal(staging.filter((i) => /on staging/.test(i.text) && i.kind !== 'approval').length, 1, '"on staging" is said once, by the Releaser');
  assert.equal(staging.filter((i) => /I stopped/.test(i.text)).length, 0);

  const handed = buildStory(base({
    task: { ...base().task, state: 'needs_owner', note: 'Pushed cart-fix (2a85c981). Open a pull request from it into main; main itself was not pushed to. This project has no staging branch, so nothing else is waiting.' },
    approvals: [ticket('a1', 'push_branch', 'executed', 500, { summary: 's', targetBranch: 'main', owned: false })], outcome: 'handed_over',
  }));
  assert.equal(handed.at(-1)!.text, 'The work is saved and shared for review. Nothing was changed on staging.');

  const declined = buildStory(base({
    task: { ...base().task, state: 'needs_owner', note: 'You declined the release. The branch is kept; nothing was pushed.' },
    approvals: [ticket('a1', 'release_stg', 'rejected', 500)],
  }));
  assert.deepEqual(declined.slice(-2).map((i) => i.text), ['Not yet.', 'You said not yet. Nothing was changed on staging.']);
  for (const item of [...staging, ...handed, ...declined].filter((i) => i.from === 'fryday')) assert.doesNotMatch(item.text, BANNED, item.id);
});

test('any other stop has its hashes taken out and a link to what happened', () => {
  const items = buildStory(base({ task: { ...base().task, state: 'needs_owner', note: 'The remote moved on (now at 9f3e2a1b4c). Nothing was pushed.' } }));
  const last = items.at(-1)!;
  assert.equal(last.text, 'I stopped and need you: The remote moved on. Nothing was pushed.');
  assert.deepEqual(last.details, { label: 'What happened', ref: { kind: 'note' } });
  const pushed = buildStory(base({ task: { ...base().task, state: 'failed', note: 'Pushed cart-fix (2a85c981). It failed later.' } }));
  assert.equal(pushed.at(-1)!.text, 'The task stopped: Pushed cart-fix. It failed later.');
  assert.deepEqual(pushed.at(-1)!.details, { label: 'What happened', ref: { kind: 'note' } });
  // A word made of the letters a to f is not a hash.
  assert.match(buildStory(base({ task: { ...base().task, state: 'failed', note: 'It was defaced.' } })).at(-1)!.text, /defaced/);
});

test('the app not starting: back to the Builder when the change broke it, else to you', () => {
  const start = (status: 'failed' | 'error'): Verification => ({
    status, service: null, dataConnections: [], unavailable: [], refused: [], evidence: [], testers: [],
    startFailure: { reason: 'exit', detail: 'It exited at once', logTail: '', alsoWithoutTheChange: status === 'error' },
  } as unknown as Verification);
  const broke = buildStory(base({ rounds: [round(1, 400, { met: [true], verify: start('failed') })] })).find((i) => i.from === 'app_tester')!;
  assert.equal(broke.kind, 'sendback');
  assert.equal(broke.to, 'builder');
  assert.equal(broke.text, 'The app does not start with the change. Back to you.');
  const could = buildStory(base({ rounds: [round(1, 400, { met: [true], verify: start('error') })] })).find((i) => i.from === 'app_tester')!;
  assert.equal(could.kind, 'said');
  assert.equal(could.to, null);
  assert.equal(could.text, 'The app could not be started to try it, so this goes to you.');
});

test('a change FryDay does not allow goes back, even when the checks pass', () => {
  const items = buildStory(base({ rounds: [round(1, 400, { flags: [{ severity: 'blocking', kind: 'test-deleted', path: 'test/a.test.ts', detail: 'a test file was deleted' }] })] }));
  const back = items.find((i) => i.kind === 'sendback')!;
  assert.equal(back.text, 'The change does something FryDay does not allow. Back to you.');
  const both = buildStory(base({ rounds: [round(1, 400, { checks: 'failed', flags: [{ severity: 'blocking', kind: 'test-deleted', path: 'test/a.test.ts', detail: 'x' }] })] }));
  assert.equal(both.find((i) => i.kind === 'sendback')!.text, 'The tests did not pass and the change does something FryDay does not allow. Back to you.');
  const review = buildStory(base({ rounds: [round(1, 400, { flags: [{ severity: 'review', kind: 'hook-or-ci', path: '.github/x.yml', detail: 'x' }] })] }));
  assert.equal(review.filter((i) => i.kind === 'sendback').length, 0, 'a flag for review only does not send it back');
});

test('a push asks in plain words whose branch it is', () => {
  assert.equal(plainApproval('push_branch', { owned: true, targetBranch: 'cart-fix' }, null), 'When you approve, the work is added to the branch you started (cart-fix).');
  assert.equal(plainApproval('push_branch', { owned: false, targetBranch: 'main' }, null), 'When you approve, the work is shared on a new branch so the owner of main can review it.');
  assert.match(plainApproval('release_stg', {}, 'Shop backend'), /^When you approve, the change is added to Shop backend and put on staging\./);
});

test('the deploy outcome is said, with a link to its details', () => {
  const ok = buildStory(base({ task: { ...base().task, state: 'deployed' }, deploy: { id: 'dep-1', state: 'succeeded', at: 700 } })).at(-1)!;
  assert.equal(ok.text, 'The staging server is running the new version.');
  assert.deepEqual(ok.details, { label: 'Deploy details', ref: { kind: 'deploy' } });
  const failed = buildStory(base({ deploy: { id: 'dep-1', state: 'failed', at: 700 } })).find((i) => i.id === 'deploy:dep-1')!;
  assert.equal(failed.text, 'The staging deploy did not finish.');
  assert.equal(buildStory(base({ deploy: { id: 'dep-1', state: 'running', at: 700 } })).find((i) => i.id === 'deploy:dep-1'), undefined, 'nothing while it runs');
});

test('saying not yet shows as your reply, and the card has no buttons any more', () => {
  const items = buildStory(base({ approvals: [ticket('a1', 'release_stg', 'rejected', 500), ticket('a2', 'release_stg', 'expired', 400)] }));
  assert.equal(items.filter((i) => i.kind === 'approval').length, 1, 'an expired ticket is not shown');
  const decision = items.find((i) => i.id === 'decision:a1')!;
  assert.equal(decision.from, 'you');
  assert.equal(decision.text, 'Not yet.');
  assert.equal(items.find((i) => i.id === 'approval:a1')!.action, null);
});

// ─── Polish pass ──────────────────────────────────────────────────────────────

test('saying no at a token limit is not about staging; saying no to a deploy still is', () => {
  const budget = buildStory(base({
    task: { ...base().task, state: 'needs_owner', note: 'You stopped the task at its token limit. The branch and the work so far are kept.' },
    approvals: [ticket('a1', 'release_stg', 'rejected', 400), ticket('a2', 'continue_budget', 'rejected', 500, { why: 'task', usedTokens: 4_000_000 })],
  }));
  assert.equal(budget.at(-1)!.text, 'You stopped the task at its token limit. Nothing more was used.');
  const deploy = buildStory(base({
    task: { ...base().task, state: 'needs_owner' },
    approvals: [ticket('a1', 'release_stg', 'executed', 400), ticket('a2', 'deploy_stg', 'rejected', 500)], release: { id: 'rel-1', state: 'pushed', at: 420 },
  }));
  assert.equal(deploy.at(-1)!.text, 'You said not yet. The change is on staging, but the staging server was not updated.');
  const release = buildStory(base({ task: { ...base().task, state: 'needs_owner' }, approvals: [ticket('a1', 'release_stg', 'rejected', 500)] }));
  assert.equal(release.at(-1)!.text, 'You said not yet. Nothing was changed on staging.');
});

test('a hash goes out together with its label, and nothing is left dangling', () => {
  const said = (note: string) => buildStory(base({ task: { ...base().task, state: 'failed', note } })).at(-1)!.text.replace(/^The task stopped: /, '');
  // releaseFlow.ts: a release that hit an error after the push, a restart, a revert, a merge that is gone.
  assert.equal(said('Merged into staging and pushed (merge 2a85c981), but the release then hit an error: socket hang up'), 'Merged into staging and pushed, but the release then hit an error: socket hang up');
  assert.equal(said('Merged into staging and pushed (merge 2a85c981, through twin fryday/twin-T-1, after staging moved 2 times).'), 'Merged into staging and pushed (through twin twin-T-1, after staging moved 2 times).');
  assert.equal(said('Merged into staging and pushed (merge 2a85c981); Fryday restarted right after. Deploy it from the task when you are ready.'), 'Merged into staging and pushed; Fryday restarted right after. Deploy it from the task when you are ready.');
  assert.equal(said('Fryday restarted during the release and could not reach the remote to see whether merge 2a85c981 is on staging. Check before approving again.'), 'Fryday restarted during the release and could not reach the remote to see whether the merge is on staging. Check before approving again.');
  assert.equal(said('Reverted on staging with commit 9f3e2a1b. The task branch is kept. Deploy staging again to take the change out of staging.'), 'Reverted on staging. The task branch is kept. Deploy staging again to take the change out of staging.');
  assert.equal(said('The merge 2a85c981 is not on staging any more; nothing was reverted.'), 'The merge is not on staging any more; nothing was reverted.');
  assert.equal(said('Merge 2a85c981 is gone.'), 'The merge is gone.');
  // approvals.ts: an approval for a commit the branch has moved past.
  assert.equal(said('That approval was for commit 2a85c981, but the branch is now at 9F3E2A1B. Nothing was pushed.'), 'That approval was for an earlier version, but the branch has moved on. Nothing was pushed.');
  assert.equal(said('That approval was for commit 2a85c981, but the branch is now at an unknown commit. Nothing was pushed.'), 'That approval was for an earlier version, but the branch has moved on. Nothing was pushed.');
  // pushFlow.ts and the remote check.
  assert.equal(said('Pushed to cart-fix (2a85c981).'), 'Pushed to cart-fix.');
  assert.equal(said('The remote moved on (now at 9f3e2a1b4c). Nothing was pushed.'), 'The remote moved on. Nothing was pushed.');
  assert.equal(said('Dependencies are not available for 2a85c981: npm ci failed'), 'Dependencies are not available: npm ci failed');
  // Plain numbers, dates and words made of the letters a to f stay.
  assert.equal(said('Order 1234567 on 20261122 was defaced in 2 places.'), 'Order 1234567 on 20261122 was defaced in 2 places.');
  for (const note of ['(merge 2a85c981)', 'with commit 2a85c981.', 'for commit 2a85c981, but the branch is now at 9f3e2a1b.']) {
    const text = said(`It stopped ${note}`);
    assert.doesNotMatch(text, /\(\s*\)|\(merge\)|\(now at\)|with commit\.|for commit,|now at\.|\s\.|\s{2}/, text);
  }
});

test('the three notes that used to leave fragments now read as clean sentences', () => {
  const said = (note: string) => buildStory(base({ task: { ...base().task, state: 'needs_owner', note } })).at(-1)!.text.replace(/^I stopped and need you: /, '');
  const a = '9f3e2a1b';
  const b = '2a85c981';
  const c = '7d41c0ee';
  // release.ts: `${branch} is at ${sha8}, not the approved ${sha8}`, wrapped by releaseFlow.ts.
  const stale = said(`The approval no longer matches the branch (cart-fix is at ${a}, not the approved ${b}). Nothing was pushed.`);
  assert.equal(stale, 'The approval no longer matches the branch (it moved on after you approved it). Nothing was pushed.');
  // deployFlow.ts: no commit reported by Jenkins.
  const unconfirmed = said(`Deploy-stg #41 (https://ci.example.com/job/41): the build finished, but Jenkins does not say which commit it built, so FryDay cannot confirm that ${b} is what was deployed. Check in Jenkins.`);
  assert.match(unconfirmed, /cannot confirm that the change is what was deployed\. Check in Jenkins\.$/);
  // deployFlow.ts: it built other commits.
  const wrong = said(`Deploy-stg #41: the build finished, but it built ${a}, ${c}, which does not contain the merge ${b}. The change is not on staging; was the job told the right branch?`);
  assert.match(wrong, /but the build does not contain the merge\. The change is not on staging/);
  const one = said(`Deploy-stg #41: the build finished, but it built ${a}, which does not contain the merge ${b}. The change is not on staging.`);
  assert.match(one, /but the build does not contain the merge\./);
  // The success line.
  assert.equal(said(`Deployed to staging: Deploy-stg #41, the build finished and it contains ${b}.`).replace(/^Deploy-stg #41, /, ''), 'Deployed to staging: Deploy-stg #41, the build finished and it contains the change.');
  for (const text of [stale, unconfirmed, wrong, one]) {
    assert.doesNotMatch(text, new RegExp(`${a}|${b}|${c}`), text);
    assert.doesNotMatch(text, /,,|\(\s*\)|\bis,|\bbuilt,\s+which|\bis\s*\./, text);
  }
});

test('ask again can also be a deploy after a declined deploy, when the project has a deployer', () => {
  const declined = { state: 'needs_owner', approvals: [ticket('a1', 'deploy_stg', 'rejected', 500)], lastRoundOutcome: 'passed', hasLiveWorkspace: true, hasStaging: true, hasDeployer: true, release: { state: 'pushed' }, deploy: null };
  assert.equal(askAgainOf(declined), 'deploy');
  assert.equal(askAgainOf({ ...declined, hasDeployer: false }), null, 'no deployer: nothing to ask for');
  assert.equal(askAgainOf({ ...declined, state: 'awaiting_approval' }), null);
  assert.equal(askAgainOf({ ...declined, release: { state: 'stopped' } }), 'release');
  assert.equal(askAgainOf({ ...declined, approvals: [ticket('a2', 'deploy_stg', 'pending', 600)] }), null);
});

test('the hand-over says whose branch the work went to', () => {
  const handed = (owned: boolean) => buildStory(base({
    task: { ...base().task, state: 'needs_owner' },
    approvals: [ticket('a1', 'push_branch', 'executed', 500, { summary: 's', targetBranch: 'cart-fix', owned })], outcome: 'handed_over',
  })).at(-1)!.text;
  assert.equal(handed(true), 'The work is added to your branch. Nothing was changed on staging.');
  assert.equal(handed(false), 'The work is saved and shared for review. Nothing was changed on staging.');
});

test('an ending is not read from an old decision when an agent ran after it', () => {
  const pushed = { state: 'needs_owner', approvals: [ticket('a1', 'push_branch', 'executed', 500)], release: null, deploy: null, hasStaging: false, hasDeployer: false, lastRunAt: 400 };
  assert.equal(outcomeOf(pushed), 'handed_over');
  // ticket() resolves at requestedAt + 10.
  assert.equal(outcomeOf({ ...pushed, lastRunAt: 510 }), 'handed_over', 'a run that started when it was decided is not later');
  assert.equal(outcomeOf({ ...pushed, lastRunAt: 511 }), null);
  const released = { state: 'needs_owner', approvals: [ticket('a1', 'release_stg', 'executed', 500)], release: { state: 'pushed', at: 520 }, deploy: null, hasStaging: true, hasDeployer: false, lastRunAt: 900 };
  assert.equal(outcomeOf(released), null);
});

test('a question you skipped shows as going on without an answer', () => {
  const items = buildStory(base({
    task: { ...base().task, state: 'coding' },
    questions: [{ id: 'q1', kind: 'clarify', question: 'Which colour?', options: [], askedBy: 'analyst', askedAt: 200, answer: NO_ANSWER, answeredAt: 250 }],
  }));
  assert.equal(items.find((i) => i.id === 'answer:q1')!.text, 'Go on without an answer.');
});

test('ask again: for a release, for a deploy, or not at all', () => {
  const ready = { state: 'needs_owner', approvals: [ticket('a1', 'release_stg', 'rejected', 500)], lastRoundOutcome: 'passed', hasLiveWorkspace: true, hasStaging: true, release: null, deploy: null };
  assert.equal(askAgainOf(ready), 'release');
  assert.equal(askAgainOf({ ...ready, state: 'awaiting_approval' }), 'release');
  assert.equal(askAgainOf({ ...ready, release: { state: 'stopped' } }), 'release');
  assert.equal(askAgainOf({ ...ready, release: { state: 'reverted' } }), 'release');
  assert.equal(askAgainOf({ ...ready, approvals: [...ready.approvals, ticket('a2', 'release_stg', 'pending', 600)] }), null, 'something already waits');
  assert.equal(askAgainOf({ ...ready, lastRoundOutcome: 'failed' }), null);
  assert.equal(askAgainOf({ ...ready, lastRoundOutcome: null }), null);
  assert.equal(askAgainOf({ ...ready, hasLiveWorkspace: false }), null);
  assert.equal(askAgainOf({ ...ready, hasStaging: false }), null, 'nowhere to put it');
  assert.equal(askAgainOf({ ...ready, release: { state: 'running' } }), null);
  assert.equal(askAgainOf({ ...ready, state: 'coding' }), null);
  assert.equal(askAgainOf({ ...ready, state: 'deployed' }), null);

  const deployed = { ...ready, approvals: [ticket('a1', 'deploy_stg', 'executed', 500)], release: { state: 'pushed' }, deploy: { state: 'failed' } };
  assert.equal(askAgainOf(deployed), 'deploy');
  assert.equal(askAgainOf({ ...deployed, deploy: { state: 'stopped' } }), 'deploy');
  assert.equal(askAgainOf({ ...deployed, deploy: { state: 'succeeded' } }), null);
  assert.equal(askAgainOf({ ...deployed, deploy: { state: 'running' } }), null);
  assert.equal(askAgainOf({ ...deployed, deploy: null }), null);
  assert.equal(askAgainOf({ ...deployed, approvals: [ticket('a2', 'deploy_stg', 'pending', 600)] }), null);
});

test('FryDay answers every note of yours: who read it, or what to do for it to count', () => {
  const notes = [{ id: 1, body: 'use the red button', at: 150 }, { id: 2, body: 'did it work?', at: 900 }];
  const reply = (change: Partial<StoryInput>) => buildStory(base({ notes, runStarts: [{ role: 'coder', at: 200 }], ...change }))
    .filter((i) => i.id.startsWith('ack:')).map((i) => i.text);
  // The first note was read by the Builder that started after it; the second by nobody yet.
  assert.deepEqual(reply({}), ['Got it. I passed it on to the Builder.', 'Got it. The next teammate to start reads it.']);
  const stopped = { ...base().task, state: 'needs_owner' };
  assert.equal(reply({ task: stopped, choices: { tryAgain: true, accept: true, why: null } })[1], 'Got it. Press “Try again” below and the Builder starts on it.');
  assert.match(reply({ task: stopped })[1]!, /^Saved on the task\. Nothing is running right now/);
  const pending = [{ id: 'apr-1', action: 'release_stg', state: 'pending', payload: {}, requestedAt: 800, resolvedAt: null }];
  assert.match(reply({ task: { ...base().task, state: 'awaiting_approval' }, approvals: pending })[1]!, /press Approve.*A message does not approve anything/);
  const items = buildStory(base({ notes, runStarts: [] }));
  assert.ok(items.findIndex((i) => i.id === 'ack:1') === items.findIndex((i) => i.id === 'note:1') + 1, 'the reply sits right under the note');
});

test('a task that ran out of rounds says so plainly, with the Checker\'s words and your two choices', () => {
  const rounds = [round(1, 400, { met: [true, false] }), round(2, 500, { met: [true, false] }), round(3, 600, { met: [true, false] })];
  const items = buildStory(base({
    task: { ...base().task, state: 'needs_owner', note: 'Still not passing after 3 rounds — 1 unmet criterion' }, rounds,
    choices: { tryAgain: true, accept: true, why: 'The code is right, but npm run lint cannot pass here' },
  }));
  assert.equal(items.at(-1)!.text,
    'The team tried 3 times and it still does not pass. The Checker says: The code is right, but npm run lint cannot pass here. It is your call: try again (tell them what to do differently), or accept it as it is.');
});

test('no deploy is offered when Jenkins is not set up here, however the project is configured', () => {
  const pushed = { state: 'needs_owner', approvals: [], lastRoundOutcome: 'passed', hasLiveWorkspace: true, hasStaging: true, hasDeployer: true, release: { state: 'pushed' }, deploy: null };
  // The project names a Jenkins job, so the deploy step is not skipped, but Jenkins is not set up
  // on this machine: pressing the button could only fail, so the task offers nothing to press.
  assert.equal(askAgainOf({ ...pushed, jenkinsReady: false }), null);
  assert.equal(askAgainOf({ ...pushed, jenkinsReady: true }), 'deploy');
  // The same holds after a deploy that failed or was stopped.
  for (const state of ['failed', 'stopped']) {
    assert.equal(askAgainOf({ ...pushed, deploy: { state }, jenkinsReady: false }), null, state);
    assert.equal(askAgainOf({ ...pushed, deploy: { state }, jenkinsReady: true }), 'deploy', state);
  }
});

test('a round you accepted shows your decision and lets the release be asked for again', () => {
  const accepted = { ...round(3, 600, { met: [true, false] }), outcome: 'accepted' as const };
  const items = buildStory(base({ task: { ...base().task, state: 'awaiting_approval' }, rounds: [accepted] }));
  assert.equal(items.find((i) => i.id === 'accepted:3')!.text, 'Accept it as it is.');
  const facts = { state: 'needs_owner', approvals: [], hasLiveWorkspace: true, hasStaging: true, release: null, deploy: null };
  assert.equal(askAgainOf({ ...facts, lastRoundOutcome: 'accepted' }), 'release');
  assert.equal(askAgainOf({ ...facts, lastRoundOutcome: 'escalated' }), null);
});

test('a task whose work was discarded says it cannot go on, not that it needs you', () => {
  const items = buildStory(base({ task: { ...base().task, state: 'needs_owner', note: 'Still not passing after 3 rounds' }, discarded: true }));
  assert.equal(items.at(-1)!.text, 'The work on this task was discarded, so it cannot go on. To try again, start a new task.');
});

test('the Checker\'s words in the stop message end on a whole sentence', () => {
  const why = 'The code looks correct, but criterion 10 is only half met. npm run build succeeds: the /user route built at 5.43 kB. npm run lint cannot pass because there is no ESLint config file in this repository, and next lint only opens a setup prompt that waits for an answer.';
  const items = buildStory(base({ task: { ...base().task, state: 'needs_owner', note: 'x' }, rounds: [round(3, 600, { met: [false] })], choices: { tryAgain: true, accept: true, why } }));
  assert.match(items.at(-1)!.text, /The Checker says: The code looks correct, but criterion 10 is only half met\. npm run build succeeds: the \/user route built at 5\.43 kB\. It is your call/);
});

test('the Builder says in its own words what it did, not just "Fixed"', () => {
  const report = "I fixed the loader in `getUsers`. `npm run lint` still cannot pass: the repo has no ESLint config.\n\n**Fixed in `src/pages/user/index.tsx`:**\n- a long list that should not reach the chat";
  const items = buildStory(base({ rounds: [round(1, 400, { met: [true] }), round(2, 500, { met: [true] })], builderSaid: { 2: report } }));
  const said = items.filter((i) => i.kind === 'handoff' && i.from === 'builder').map((i) => i.text);
  assert.equal(said[0], 'Done. Please check it.', 'a round with no report keeps the short line');
  assert.equal(said[1], 'I fixed the loader in `getUsers`. `npm run lint` still cannot pass: the repo has no ESLint config. Please check again.');
});

test('a note on work that can go back to the Builder says how to send it there', () => {
  const items = buildStory(base({ task: { ...base().task, state: 'needs_owner' }, notes: [{ id: 1, body: 'it does not work', at: 900 }], runStarts: [], canSendBack: true }));
  assert.match(items.find((i) => i.id === 'ack:1')!.text, /^Saved as a note, so nobody is working on it yet\. .*Send back to fix/);
});

test('work that changed after it was merged into staging is offered for a new merge first', () => {
  const facts = { state: 'needs_owner', approvals: [], lastRoundOutcome: 'passed', hasLiveWorkspace: true, hasStaging: true, hasDeployer: true, jenkinsReady: true, deploy: null };
  assert.equal(askAgainOf({ ...facts, release: { state: 'pushed', head: 'aaa1111' }, head: 'bbb2222' }), 'release', 'the new commits need their own merge');
  assert.equal(askAgainOf({ ...facts, release: { state: 'pushed', head: 'aaa1111' }, head: 'aaa1111' }), 'deploy', 'the same commit is on staging: deploy it');
});

test('nothing is offered to deploy again while the agents are rewriting the change', () => {
  const pushed = { approvals: [], lastRoundOutcome: 'passed', hasLiveWorkspace: true, hasStaging: true, hasDeployer: true, jenkinsReady: true, release: { state: 'pushed' }, deploy: { state: 'stopped' } };
  assert.equal(askAgainOf({ ...pushed, state: 'needs_owner' }), 'deploy');
  for (const state of ['coding', 'testing', 'verifying']) assert.equal(askAgainOf({ ...pushed, state }), null, state);
});
