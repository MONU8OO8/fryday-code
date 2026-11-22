// Data connections: nothing is usable until the developer turns it on, production never
// is, and a server whose definition changes loses everything that was granted.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const tmp = path.join(os.tmpdir(), `fryday-connections-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
const settingsFile = path.join(tmp, 'claude.json');
const dbFile = path.join(tmp, 'stage.sqlite');
const FIXTURE = path.join(__dirname, 'fixtures', 'sqlite-mcp.mjs');
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_CLAUDE_SETTINGS = settingsFile;
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';

import { initDb, getDb } from '../src/db/db';
import { saveProject } from '../src/registry/registry';
import {
  classifyTool, configureConnection, definitionHash, discoverConnection, getDataConnection, grantsFor, listDataConnections, readDefinitions, ConnectionError,
} from '../src/connections/store';
import { apiTesterMcp } from '../src/verify/tools';
import { McpClient } from '../src/connections/mcpClient';

const server = (extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [FIXTURE, dbFile], ...extra });
function writeSettings(servers: Record<string, unknown>): void {
  fs.writeFileSync(settingsFile, JSON.stringify({ someOtherSetting: true, mcpServers: servers }));
}

before(() => {
  initDb(process.env.FRYDAY_DB!);
  saveProject({ id: 'shop', name: 'Shop', localPath: '/tmp/shop', prodBranch: 'main', verified: true });
  saveProject({ id: 'other', name: 'Other', localPath: '/tmp/other', prodBranch: 'main', verified: true });
  writeSettings({
    'app-stg-db': server(),
    'app-prod-db': server(),
    'reports-db': server(),
    'remote-docs': { type: 'http', url: 'https://mcp.example.invalid/mcp' },
    'bad name!': server(),
    fryday_service: server(),
    broken: { command: process.execPath, args: ['-e', 'process.exit(2)'] },
  });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const rejects = async (work: () => unknown, pattern: RegExp) => {
  await assert.rejects(async () => work(), (err: unknown) => err instanceof ConnectionError && pattern.test(err.message), String(pattern));
};

test('every server Claude Code defines is listed, all of them off', () => {
  const all = listDataConnections();
  assert.deepEqual(all.map((c) => c.name), ['app-prod-db', 'app-stg-db', 'bad name!', 'broken', 'fryday_service', 'remote-docs', 'reports-db']);
  assert.ok(all.every((c) => !c.enabled && c.allowed.length === 0 && c.projects.length === 0));
  const by = Object.fromEntries(all.map((c) => [c.name, c]));
  assert.equal(by['app-prod-db']!.envKind, 'production');
  assert.equal(by['app-stg-db']!.envKind, 'staging', 'a guess until the developer says');
  assert.equal(by['reports-db']!.envKind, 'unknown');
  assert.equal(by['remote-docs']!.canDiscover, false, 'only servers that run as a program');
  assert.equal(by['bad name!']!.canDiscover, false, 'a name that cannot be part of a tool name');
  assert.equal(by['fryday_service']!.canDiscover, false, "a name core uses for its own server");
  assert.deepEqual(grantsFor('shop'), { granted: [], unavailable: [] });
  // Nothing about how a server starts is in what the UI gets.
  assert.doesNotMatch(JSON.stringify(all), /sqlite-mcp|stage\.sqlite|mcp\.example/);
});

test('tools are suggested a check from what they are, and ones that change things are marked', () => {
  const tool = (name: string, properties: Record<string, unknown> = {}) => classifyTool({ name, description: '', inputSchema: { type: 'object', properties } });
  assert.deepEqual(tool('mysql_query', { query: {} }), { suggested: 'sql', risky: false });
  assert.deepEqual(tool('execute_sql', { sql: {} }), { suggested: 'sql', risky: false }, 'named "execute", but it takes SQL that is checked');
  assert.deepEqual(tool('aggregate', { pipeline: {} }), { suggested: 'mongo', risky: false });
  assert.deepEqual(tool('find', { filter: {} }), { suggested: 'mongo', risky: false });
  assert.deepEqual(tool('list-collections'), { suggested: 'plain', risky: false });
  assert.deepEqual(tool('mysql_describe_table', { table: {} }), { suggested: 'plain', risky: false });
  for (const name of ['mysql_connect', 'insert-many', 'update-many', 'drop_collection', 'export', 'create-index', 'execute_write', 'delete-many', 'switch-connection', 'run_command']) {
    assert.equal(tool(name, { sql: {} }).risky || tool(name).risky, true, name);
  }
});

test('listing the tools starts the server once and records what it has', async () => {
  const c = await discoverConnection('app-stg-db');
  assert.deepEqual(c.tools.map((t) => [t.name, t.suggested, t.risky]), [
    ['connect', 'plain', true], ['execute_write', 'plain', true], ['list_tables', 'plain', false], ['query', 'sql', false],
  ]);
  assert.equal(c.enabled, false, 'listing turns nothing on');
  assert.ok(c.checkedAt);
  await rejects(() => discoverConnection('remote-docs'), /not a local program/);
  await rejects(() => discoverConnection('nope'), /no MCP server named nope/);
  await rejects(() => discoverConnection('bad name!'), /cannot be used in a tool name/);
  await rejects(() => discoverConnection('broken'), /did not list its tools/);
});

test('a connection is turned on only as local or staging, read-only, with safe tools', async () => {
  const set = (change: Parameters<typeof configureConnection>[1]) => configureConnection('app-stg-db', change);
  await rejects(() => configureConnection('reports-db', { enabled: true }), /List the tools of reports-db first/);
  await rejects(() => set({ enabled: true }), /can only read/);
  await rejects(() => set({ enabled: true, access: 'read_write' }), /can only read/);
  await rejects(() => set({ enabled: true, access: 'read_only', envKind: 'unknown' }), /Say what this connection points at/);
  await rejects(() => set({ enabled: true, access: 'read_only', envKind: 'production' }), /production connection cannot be turned on/);
  await rejects(() => set({ tools: [{ tool: 'execute_write', check: 'plain' }] }), /cannot be given to an agent/);
  await rejects(() => set({ tools: [{ tool: 'connect', check: 'plain' }] }), /cannot be given to an agent/);
  await rejects(() => set({ tools: [{ tool: 'query', check: 'plain' }] }), /keeps the SQL check/);
  await rejects(() => set({ tools: [{ tool: 'made_up', check: 'plain' }] }), /no tool named made_up/);
  await rejects(() => set({ projects: ['missing'] }), /Unknown project/);
  assert.equal(getDataConnection('app-stg-db')!.enabled, false, 'a refused change changes nothing');

  const on = set({ enabled: true, access: 'read_only', envKind: 'staging', tools: [{ tool: 'query', check: 'sql' }, { tool: 'list_tables', check: 'plain' }], projects: ['shop'] });
  assert.equal(on.enabled, true);
  assert.deepEqual(on.allowed, [{ tool: 'list_tables', check: 'plain' }, { tool: 'query', check: 'sql' }]);
  assert.deepEqual(on.projects, ['shop']);

  const grants = grantsFor('shop');
  assert.deepEqual(grants.unavailable, []);
  assert.equal(grants.granted.length, 1);
  assert.equal(grants.granted[0]!.envKind, 'staging');
  assert.deepEqual(grantsFor('other'), { granted: [], unavailable: [] }, 'a project it was not granted to gets nothing');
});

test('a production connection can never be enabled, by the API or straight in the database', async () => {
  await discoverConnection('app-prod-db');
  await rejects(() => configureConnection('app-prod-db', { envKind: 'staging' }), /says production/);
  await rejects(() => configureConnection('app-prod-db', { enabled: true, access: 'read_only' }), /production connection cannot be turned on/);
  const db = getDb();
  assert.throws(() => db.prepare(`UPDATE connections SET enabled = 1 WHERE name = 'app-prod-db'`).run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare(`UPDATE connections SET env_kind = 'production' WHERE name = 'app-stg-db'`).run(), /CHECK constraint failed/, 'an enabled one cannot be flipped to production');
  assert.throws(() => db.prepare(`UPDATE connections SET access = 'read_write' WHERE name = 'app-stg-db'`).run(), /CHECK constraint failed/);
  // Even a row forced into the grants table gives the project nothing.
  db.prepare(`INSERT INTO role_grants (role, connection, project_id) VALUES ('api_tester', 'app-prod-db', 'shop')`).run();
  const grants = grantsFor('shop');
  assert.deepEqual(grants.granted.map((g) => g.name), ['app-stg-db']);
  assert.deepEqual(grants.unavailable, [{ name: 'app-prod-db', why: 'it is turned off' }]);
  db.prepare(`DELETE FROM role_grants WHERE connection = 'app-prod-db'`).run();
});

test("the run's MCP config carries only what was granted, tool by tool", async () => {
  const grants = grantsFor('shop');
  const mcp = apiTesterMcp({ key: 'T-1.r1.api', runsDir: tmp, service: { origin: 'http://127.0.0.1:4310', logPath: path.join(tmp, 'svc.log') }, granted: grants.granted });
  assert.deepEqual(Object.keys(mcp.tools).sort(), [
    'mcp__app-stg-db__list_tables', 'mcp__app-stg-db__query', 'mcp__fryday_service__log', 'mcp__fryday_service__request',
  ]);
  assert.deepEqual(mcp.tools['mcp__app-stg-db__query'], { check: 'sql' });
  assert.deepEqual(mcp.tools['mcp__app-stg-db__list_tables'], { check: 'none' });
  const config = JSON.parse(fs.readFileSync(mcp.configPath, 'utf8')) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ['app-stg-db', 'fryday_service']);
  assert.equal(fs.statSync(mcp.configPath).mode & 0o777, 0o600, 'the config can hold how a server starts; only the owner reads it');
  // The granted server really answers through that definition.
  const client = new McpClient(config.mcpServers['app-stg-db'] as { command: string; args: string[] });
  try {
    await client.start();
    assert.equal((await client.callTool('query', { query: 'select 1 as one' })).text, '[{"one":1}]');
  } finally {
    client.stop();
  }
});

test('a changed definition voids the grant until the developer looks again', async () => {
  const before = definitionHash(readDefinitions().get('app-stg-db')!);
  writeSettings({ 'app-stg-db': server({ env: { EXTRA: '1' } }), 'app-prod-db': server() });
  assert.notEqual(definitionHash(readDefinitions().get('app-stg-db')!), before);
  assert.equal(definitionHash({ a: 1, b: { c: 2, d: 3 } }), definitionHash({ b: { d: 3, c: 2 }, a: 1 }), 'key order is not a change');

  const c = getDataConnection('app-stg-db')!;
  assert.equal(c.changed, true);
  assert.deepEqual(grantsFor('shop'), { granted: [], unavailable: [{ name: 'app-stg-db', why: 'its definition changed since you reviewed it' }] });
  await rejects(() => configureConnection('app-stg-db', { enabled: true }), /has changed in Claude Code's settings/);

  // Looking again starts from nothing: off, no tools, no projects.
  const again = await discoverConnection('app-stg-db');
  assert.equal(again.changed, false);
  assert.equal(again.enabled, false);
  assert.deepEqual(again.allowed, []);
  assert.deepEqual(again.projects, []);

  // A server removed from Claude Code is still listed (so the developer sees it went) and gives nothing.
  writeSettings({});
  assert.equal(getDataConnection('app-stg-db')!.present, false);
  assert.deepEqual(grantsFor('shop'), { granted: [], unavailable: [] });
});
