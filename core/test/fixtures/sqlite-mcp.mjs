#!/usr/bin/env node
// A stand-in for a database MCP server, for tests and the check scripts.
// Usage: node sqlite-mcp.mjs <database file>
//
// It runs whatever SQL it is given on a SQLite file — writes included. That is the
// point: if the guard ever let a write through, the file would show it. Every call it
// receives is appended to <database file>.calls.jsonl.

import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const file = process.argv[2];
if (!file) {
  process.stderr.write('sqlite-mcp: a database file is required\n');
  process.exit(1);
}
const db = new Database(file);

const TOOLS = [
  {
    name: 'query',
    description: 'Run one SQL statement on the database (SQLite dialect) and return the rows as JSON.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
  },
  { name: 'list_tables', description: 'The tables in the database.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'execute_write',
    description: 'Run a statement that changes data.',
    inputSchema: { type: 'object', required: ['sql'], properties: { sql: { type: 'string' } } },
  },
  {
    name: 'connect',
    description: 'Point the server at another database.',
    inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
  },
];

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

function run(sql) {
  try {
    const statement = db.prepare(String(sql));
    if (statement.reader) return text(JSON.stringify(statement.all()));
    const info = statement.run();
    return text(JSON.stringify({ changes: info.changes }));
  } catch (err) {
    return text(`SQL error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

function call(name, args) {
  appendFileSync(`${file}.calls.jsonl`, `${JSON.stringify({ tool: name, args })}\n`);
  if (name === 'query') return run(args.query);
  if (name === 'execute_write') return run(args.sql);
  if (name === 'list_tables') return text(JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name)));
  if (name === 'connect') return text('connected');
  return null;
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return;
  const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
  const fail = (code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } })}\n`);
  if (msg.method === 'initialize') {
    return reply({ protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'sqlite-fixture', version: '1.0.0' } });
  }
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') return reply({ tools: TOOLS });
  if (msg.method === 'tools/call') {
    const result = call(msg.params?.name, msg.params?.arguments ?? {});
    return result ? reply(result) : fail(-32602, 'unknown tool');
  }
  return fail(-32601, 'unknown method');
});
