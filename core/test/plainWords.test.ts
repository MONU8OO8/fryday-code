// Plain words: how agents and what they do are said to someone who is not a developer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorOfRole, ACTOR_NAME, clip, plainText, checkName, doingText, joinWords, capital, times, formatTokens } from '../src/pipeline/plainWords';

test('every agent role has a plain name', () => {
  assert.equal(actorOfRole('analyst'), 'understander');
  assert.equal(actorOfRole('coder'), 'builder');
  assert.equal(actorOfRole('tester'), 'checker');
  assert.equal(actorOfRole('api_tester'), 'app_tester');
  assert.equal(actorOfRole('ui_tester'), 'page_tester');
  assert.equal(actorOfRole('owner'), 'you');
  assert.equal(actorOfRole('something-new'), 'fryday');
  assert.equal(ACTOR_NAME.checks, 'Automatic checks');
});

test('paths become a file name, and long text is clipped', () => {
  assert.equal(plainText('The bug is in src/cart/total.js near the end'), 'The bug is in total.js near the end');
  assert.equal(plainText('no paths here'), 'no paths here');
  assert.equal(plainText('It called mcp__stg_db__query twice'), 'It called the app twice');
  assert.equal(plainText('It called mcp__stg-db__query once'), 'It called the app once');
  assert.equal(clip('a  b\n c'), 'a b c');
  assert.equal(clip('x'.repeat(300), 10).length, 10);
  assert.ok(clip('x'.repeat(300), 10).endsWith('…'));
});

test('web addresses become a plain pointer, never a number', () => {
  assert.equal(
    plainText('See https://jenkins.example.com/job/deploy/41/ for details.'),
    'See the link on the Technical details page for details.',
  );
  assert.equal(plainText('(https://x.example/a/b)'), '(the link on the Technical details page)');
  assert.equal(plainText('Done, see https://x.example/a.'), 'Done, see the link on the Technical details page.');
});

test('what an agent is doing, in words', () => {
  assert.equal(doingText(['Read'], ['src/cart/total.js'], ''), 'Reading the total code');
  assert.equal(doingText(['Grep'], ['TODO'], ''), 'Searching the code');
  assert.equal(doingText(['Edit'], ['src/orders/export.ts'], ''), 'Changing the export code');
  assert.equal(doingText(['Bash'], ['npm test'], ''), 'Running the tests');
  assert.equal(doingText(['Bash'], ['npx eslint .'], ''), 'Running the style check');
  assert.equal(doingText(['Bash'], ['npx tsc --noEmit'], ''), 'Running the type check');
  assert.equal(doingText(['Bash'], ['npm ci'], ''), 'Installing what the project needs');
  assert.equal(doingText(['Bash'], ['ls -la'], ''), 'Running a command');
  assert.equal(doingText(['mcp__fryday_service__request'], ['GET /orders'], ''), 'Trying the app');
  assert.equal(doingText(['mcp__fryday_browser__browser_click'], [''], ''), 'Using the pages in a browser');
  assert.equal(doingText(['mcp__stg-db__query'], ['SELECT 1'], ''), 'Looking at the test data');
  assert.equal(doingText([], [], 'Let me think'), 'Thinking it through');
  assert.equal(doingText([], [], ''), 'Getting started');
  for (const t of ['Read', 'Edit', 'Bash', 'mcp__x__y', 'StructuredOutput', 'Weird']) {
    assert.doesNotMatch(doingText([t], ['src/a/b.ts'], ''), /\/|Bash|mcp|Read\b|Edit\b/, t);
  }
});

test('small sentence helpers', () => {
  assert.equal(checkName('test'), 'the tests');
  assert.equal(checkName('lint'), 'the style check');
  assert.equal(checkName('typecheck'), 'the type check');
  assert.equal(joinWords(['a']), 'a');
  assert.equal(joinWords(['a', 'b']), 'a and b');
  assert.equal(joinWords(['a', 'b', 'c']), 'a, b and c');
  assert.equal(capital('the tests'), 'The tests');
  assert.deepEqual([1, 2, 5].map(times), ['once', 'twice', '5 times']);
});

test('token counts are written short: 950, 12.3k, 1.2M', () => {
  const cases: Array<[number, string]> = [
    [0, '0'], [950, '950'], [999, '999'], [1000, '1k'], [12_345, '12.3k'], [400_000, '400k'], [999_499, '999k'],
    [999_500, '1M'], [1_234_567, '1.2M'], [1_500_000, '1.5M'], [4_000_000, '4M'], [2_100_000, '2.1M'], [123_456_789, '123M'],
    [-5, '0'], [Number.NaN, '0'],
  ];
  for (const [n, text] of cases) assert.equal(formatTokens(n), text, String(n));
});
