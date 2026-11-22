// The guard's rules for tools that come from MCP servers: only listed tools exist, and
// the ones that take a query, a pipeline or an address are checked on every call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// Plain JS on purpose: the same file runs inside the hook without a build step.
import { decide, decideMcp, sqlDenyReason, sqlSkeleton, mongoDenyReason } from '../src/guard/decide.mjs';
import { buildPolicy, buildSettings } from '../src/guard/runGuard';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-mcpguard-')));
const hook = path.join(__dirname, '..', 'src', 'guard', 'hook.mjs');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
before(() => fs.mkdirSync(path.join(tmp, 'ws'), { recursive: true }));

const ws = path.join(tmp, 'ws');
const ORIGIN = 'http://127.0.0.1:4310';
const policy = {
  role: 'api_tester',
  allowedTools: ['Read', 'Bash', 'Grep', 'Glob'],
  readRoots: [ws],
  writeRoots: [] as string[],
  mcp: {
    mcp__fryday_service__request: { check: 'none' },
    mcp__stagedb__query: { check: 'sql' },
    mcp__docs__aggregate: { check: 'mongo' },
    mcp__fryday_browser__browser_navigate: { check: 'url', origin: ORIGIN },
    mcp__fryday_browser__browser_take_screenshot: { check: 'no-file' },
  },
};
const allowed = (tool: string, input: Record<string, unknown>) => decide(policy, tool, input, ws).allow;

test('reading statements pass', () => {
  for (const sql of [
    'select * from users where id = 1',
    'SELECT 1;',
    '  select count(*) from orders  ;  ',
    'show tables',
    'SHOW CREATE TABLE users',
    'describe users',
    'explain select * from users',
    'with recent as (select * from orders where created_at > now() - interval 1 day) select count(*) from recent',
    // Words that look like commands inside a string, an identifier or a comment are not commands.
    "select * from notes where body = 'please update; then delete the draft'",
    'select `set`, `update` from t',
    'select updated_at, created_by, deleted from t',
    'select 1 -- ; drop table t',
    'select /* delete me */ 1',
    "select 'it''s; fine' as a",
    'select $$a ; b$$ as a',
  ]) {
    assert.equal(sqlDenyReason(sql), null, sql);
  }
});

test('anything that writes, runs code, or is more than one statement is refused', () => {
  for (const sql of [
    'update users set name = 1',
    'delete from users',
    'insert into t values (1)',
    'drop table t',
    'truncate t',
    'alter table t add column c int',
    'create table t (a int)',
    'select 1; drop table t',
    'select 1; select 2',
    'with gone as (delete from t returning *) select * from gone',
    'select * into outfile "/tmp/x" from t',
    'select * into newtable from t',
    'select * from t for update',
    'select * from t lock in share mode',
    'explain analyze delete from t',
    'select /*! 1; drop table t */ 1',
    'select sleep(30)',
    'select benchmark(1000000, md5(1))',
    "select load_file('/etc/passwd')",
    "select pg_read_file('/etc/passwd')",
    "select nextval('s')",
    'call cleanup()',
    'set global general_log = 1',
    'use other_db',
    'grant all on *.* to x',
    "select 'never closed",
    'select /* never closed',
    '',
    '   ',
  ]) {
    assert.notEqual(sqlDenyReason(sql), null, `must be refused: ${sql}`);
  }
  assert.notEqual(sqlDenyReason(123), null);
  assert.notEqual(sqlDenyReason(`select ${'1,'.repeat(20000)}1`), null, 'a huge query');
});

test('the skeleton empties strings and drops comments, and says when one never ends', () => {
  assert.equal(sqlSkeleton("select 'a; b' -- c\nfrom t")?.replace(/\s+/g, ' ').trim(), "select '' from t");
  assert.equal(sqlSkeleton("select 'x"), null);
  assert.equal(sqlSkeleton('select $tag$ ; $tag$')?.includes(';'), false);
});

test('a pipeline that writes or runs code is refused, in either shape it can arrive in', () => {
  assert.equal(mongoDenyReason({ collection: 'c', pipeline: [{ $match: { a: 1 } }, { $group: { _id: '$a' } }] }), null);
  assert.equal(mongoDenyReason({ filter: { name: 'outfit', merged: true } }), null, 'plain words are fine');
  assert.match(mongoDenyReason({ pipeline: [{ $match: {} }, { $out: 'copy' }] })!, /\$out/);
  assert.match(mongoDenyReason({ pipeline: [{ $merge: { into: 'x' } }] })!, /\$merge/);
  assert.match(mongoDenyReason({ pipeline: '[{"$out":"copy"}]' })!, /\$out/, 'a pipeline passed as text');
  assert.match(mongoDenyReason({ filter: { $where: 'sleep(1000)' } })!, /\$where/);
  assert.match(mongoDenyReason({ pipeline: [{ $addFields: { x: { $function: { body: 'x', args: [], lang: 'js' } } } }] })!, /\$function/);
});

test('an MCP tool that is not listed does not exist, whatever its name', () => {
  assert.equal(allowed('mcp__fryday_service__request', { path: '/x' }), true);
  for (const tool of ['mcp__stagedb__execute', 'mcp__proddb__query', 'mcp__fryday_browser__browser_run_code_unsafe', 'mcp__fryday_browser__browser_file_upload', 'mcp____proto__', 'mcp__constructor__x']) {
    assert.equal(allowed(tool, { query: 'select 1' }), false, tool);
  }
  // A policy with no MCP section at all refuses every MCP tool.
  assert.equal(decide({ ...policy, mcp: undefined }, 'mcp__fryday_service__request', {}, ws).allow, false);
});

test('a query tool only lets reading through, and refuses when it finds no query to check', () => {
  assert.equal(allowed('mcp__stagedb__query', { query: 'select * from plans' }), true);
  assert.equal(allowed('mcp__stagedb__query', { sql: 'select 1', database: 'app' }), true);
  assert.equal(allowed('mcp__stagedb__query', { query: 'update plans set price = 0' }), false);
  assert.equal(allowed('mcp__stagedb__query', { query: 'select 1', sql: 'drop table plans' }), false, 'every query-like argument is checked');
  assert.equal(allowed('mcp__stagedb__query', { text: 'drop table plans' }), false, 'nothing recognisable as a query');
  assert.equal(allowed('mcp__stagedb__query', {}), false);
  assert.equal(allowed('mcp__docs__aggregate', { pipeline: [{ $match: {} }] }), true);
  assert.equal(allowed('mcp__docs__aggregate', { pipeline: [{ $out: 'x' }] }), false);
});

test('the browser may only be sent to the service under test', () => {
  const nav = (url: unknown) => allowed('mcp__fryday_browser__browser_navigate', { url });
  assert.equal(nav(`${ORIGIN}/`), true);
  assert.equal(nav(`${ORIGIN}/cart?x=1#top`), true);
  for (const url of [
    'http://127.0.0.1:4311/', 'http://localhost:4310/', 'https://127.0.0.1:4310/', 'http://example.com/', 'file:///etc/hosts',
    'javascript:alert(1)', 'data:text/html,hi', 'chrome://settings', `${ORIGIN}@evil.example/`, 'http://user:pw@127.0.0.1:4310/', '/relative', '', undefined, 42,
  ]) {
    assert.equal(nav(url), false, String(url));
  }
  assert.equal(allowed('mcp__fryday_browser__browser_take_screenshot', {}), true);
  assert.equal(allowed('mcp__fryday_browser__browser_take_screenshot', { type: 'png', fullPage: true }), true);
  assert.equal(allowed('mcp__fryday_browser__browser_take_screenshot', { filename: '../../x.png' }), false);
  assert.equal(decideMcp({ check: 'url' }, { url: `${ORIGIN}/` }).allow, false, 'a url rule with no origin allows nothing');
  assert.equal(decideMcp({ check: 'something-new' } as never, {}).allow, false, 'an unknown check allows nothing');
});

test('only tester roles can be given MCP tools, and only well-formed names', () => {
  const base = { runId: 'r', workspacePath: ws, runsDir: tmp };
  const tools = { mcp__fryday_service__request: { check: 'none' as const } };
  const p = buildPolicy({ ...base, role: 'api_tester', mcpTools: tools });
  assert.deepEqual(p.mcp, tools);
  assert.deepEqual(p.writeRoots, [], 'a tester writes nowhere');
  for (const role of ['coder', 'tester', 'planner', 'analyst', 'fryday'] as const) {
    assert.throws(() => buildPolicy({ ...base, role, mcpTools: tools }), /may not be given MCP tools/, role);
    assert.deepEqual(buildPolicy({ ...base, role }).mcp, {}, `${role} has none by default`);
  }
  for (const name of ['Bash', 'mcp__x', 'mcp__a b__c', 'mcp__x__y;rm', '*']) {
    assert.throws(() => buildPolicy({ ...base, role: 'api_tester', mcpTools: { [name]: { check: 'none' } } }), /not an MCP tool name/, name);
  }
  // The same names, and nothing else from MCP, are what Claude Code is told to allow.
  const settings = buildSettings({ ...base, role: 'ui_tester', mcpTools: tools }, path.join(tmp, 'p.json')) as { permissions: { allow: string[] }; sandbox: { network: { allowedDomains: string[] } } };
  assert.deepEqual(settings.permissions.allow, ['Read', 'Grep', 'Glob', 'mcp__fryday_service__request']);
  assert.deepEqual(settings.sandbox.network.allowedDomains, [], "a tester's own shell still has no network");
  // The API tester's shell may not change the checkout the service under test runs from.
  const fsOf = (role: 'api_tester' | 'tester' | 'coder') => (buildSettings({ ...base, role }, path.join(tmp, 'p.json')) as { sandbox: { filesystem: { denyWrite?: string[] } } }).sandbox.filesystem;
  assert.deepEqual(fsOf('api_tester').denyWrite, [ws]);
  assert.equal(fsOf('coder').denyWrite, undefined);
});

test('the real hook process refuses a write through a granted query tool', () => {
  const file = path.join(tmp, 'policy.json');
  fs.writeFileSync(file, JSON.stringify(policy));
  const run = (tool: string, input: Record<string, unknown>) =>
    spawnSync(process.execPath, [hook, file], { input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: ws }), encoding: 'utf8' });
  assert.equal(run('mcp__stagedb__query', { query: 'select 1' }).status, 0);
  const refused = run('mcp__stagedb__query', { query: 'delete from plans' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Blocked by Fryday guard: .*for reading/);
  assert.equal(run('mcp__stagedb__other', { query: 'select 1' }).status, 2);
  assert.equal(run('mcp__fryday_browser__browser_navigate', { url: 'http://example.com/' }).status, 2);
});
