// The coder's self-check: read from the end of its report, compared with the tester's
// verdict, told back to the coder when it was wrong, and counted on the scorecard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const tmp = path.join(os.tmpdir(), `fryday-selfcheck-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';

import { initDb, getDb } from '../src/db/db';
import { calibrate, coderFeedback, parseSelfCheck, type Verdict } from '../src/pipeline/review';
import { getRound, saveGate, saveSelfCheck, saveVerdict } from '../src/pipeline/rounds';
import { scorecards } from '../src/runner/scorecard';

before(() => initDb(process.env.FRYDAY_DB!));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CRITERIA = ['The cart total includes tax', 'Empty carts show a message', 'Discount codes are case-insensitive'];
const verdict = (met: boolean[]): Verdict => ({
  verdict: met.every(Boolean) ? 'pass' : 'fail',
  summary: '',
  issues: [],
  criteria: CRITERIA.map((criterion, i) => ({ criterion, met: met[i]!, evidence: met[i] ? 'seen' : 'not seen' })),
});

const REPORT = `Changed cart.js to add tax.

## Self-check
1. met — test "cart total with tax" passes
2) Not sure: no UI test runs here
- 3. met: discount test
4. met — there is no fourth criterion
1. not sure — a repeat is ignored

## Anything else
5. met — after the section ends
`;

test('the self-check is read from its section: numbered lines, met or not sure, nothing after the next heading', () => {
  assert.deepEqual(parseSelfCheck(REPORT, 3), [
    { index: 1, claim: 'met', evidence: 'test "cart total with tax" passes' },
    { index: 2, claim: 'unsure', evidence: 'no UI test runs here' },
    { index: 3, claim: 'met', evidence: 'discount test' },
  ]);
  assert.deepEqual(parseSelfCheck('All done, everything works.', 3), [], 'no section, no claims');
  assert.deepEqual(parseSelfCheck(REPORT, 0), [], 'no criteria, nothing to claim');
  assert.deepEqual(parseSelfCheck(null, 3), []);
  assert.equal(parseSelfCheck('### Self check\n1. not met — ran out of time', 1)[0]!.claim, 'unsure', '"not met" is not a claim of met');
});

test('calibration: a "met" the tester disagrees with is overconfident; a "not sure" that was unmet is honest', () => {
  const claims = parseSelfCheck(REPORT, 3);
  assert.deepEqual(calibrate(CRITERIA, claims, verdict([true, false, false])), {
    claimedMet: 2, overconfident: 1, unsure: 1, unsureUnmet: 1, misses: ['Discount codes are case-insensitive'],
  });
  assert.deepEqual(calibrate(CRITERIA, claims, verdict([true, true, true]))?.overconfident, 0);
  assert.equal(calibrate(CRITERIA, [], verdict([true, true, true])), null, 'no self-check, nothing to compare');
  assert.equal(calibrate(CRITERIA, claims, null), null, 'no verdict, nothing to compare');
});

test('the coder is told which of its "met" claims were wrong, and nothing when it was right', () => {
  const v = verdict([true, false, false]);
  const wrong = calibrate(CRITERIA, parseSelfCheck(REPORT, 3), v);
  const text = coderFeedback(1, [], [], v, wrong);
  assert.match(text, /## Your self-check/);
  assert.match(text, /- Discount codes are case-insensitive/);
  assert.doesNotMatch(coderFeedback(1, [], [], v, null), /self-check/i);
  assert.doesNotMatch(coderFeedback(1, [], [], v, { claimedMet: 1, overconfident: 0, unsure: 0, unsureUnmet: 0, misses: [] }), /self-check/i);
});

test('the self-check is stored on its round, cleared by a fresh gate, and counted on the scorecard', () => {
  const now = Date.now();
  getDb().prepare(`INSERT INTO tasks (id, title, description, state, created_at, updated_at) VALUES ('T-1', 't', '', 'deployed', ?, ?)`).run(now, now);
  getDb().prepare(`INSERT INTO runs (id, task_id, role, round, state, log_path, started_at, ended_at) VALUES ('r1', 'T-1', 'coder', 1, 'completed', 'x', ?, ?)`).run(now, now + 1000);
  saveGate('T-1', 1, 'abc', [], []);
  const v = verdict([true, false, false]);
  saveVerdict('T-1', 1, v);
  const claims = parseSelfCheck(REPORT, 3);
  saveSelfCheck('T-1', 1, { claims, calibration: calibrate(CRITERIA, claims, v) });
  getDb().prepare(`UPDATE task_rounds SET outcome = 'changes_requested' WHERE task_id = 'T-1'`).run();
  assert.equal(getRound('T-1', 1)!.selfCheck!.calibration!.overconfident, 1);

  const coder = scorecards(now + 2000).find((c) => c.role === 'coder')!;
  assert.equal(coder.month.selfCheckAccuracy, 0.5);
  assert.equal(coder.month.overconfidentClaims, 1);

  saveGate('T-1', 1, 'def', [], []);
  assert.equal(getRound('T-1', 1)!.selfCheck, null, 'a new attempt at the round starts without the old self-check');
});
