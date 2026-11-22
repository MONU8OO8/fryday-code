/**
 * Data connections — MCP servers Claude Code already knows on this machine that the
 * developer lets a tester agent use, to read data while it verifies a change.
 *
 * Everything is off until the developer turns it on, server by server and tool by tool:
 *   - a server is known by name; how it starts stays in Claude Code's own settings file;
 *   - the developer states what it points at and that its database user can only read.
 *     A production server can never be turned on for an agent, and a name that says
 *     production cannot be relabelled as something else;
 *   - only ticked tools exist for the agent, each with a check on its arguments;
 *   - a project gets a connection only when it is granted to that project;
 *   - if the server's definition changes afterwards, all of that is void until the
 *     developer looks again.
 *
 * MCP servers run outside the sandbox with the developer's own access. The argument
 * checks stop obvious writes; the real guarantee is a database user that can only read.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import { getDb, nowMs } from '../db/db.js';
import { getConfig } from '../config.js';
import { getRepo } from '../registry/registry.js';
import { guessEnvironment, type ServerEnvironment } from './doctor.js';
import { discoverTools, McpError, type McpTool, type StdioDefinition } from './mcpClient.js';

export type AccessKind = 'read_only' | 'read_write' | 'unknown';
export type CheckKind = 'sql' | 'mongo' | 'plain';
/** The role data connections are granted to. Testers that exercise the API are the only ones that read data. */
export const DATA_ROLE = 'api_tester';

export interface ReportedTool {
  name: string;
  description: string;
  /** The argument check suggested for this tool. */
  suggested: CheckKind;
  /** It looks like it changes data or where the server points; it cannot be given to an agent. */
  risky: boolean;
}

export interface DataConnection {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  /** Core can only start, and so list the tools of, servers that run as a local program. */
  canDiscover: boolean;
  /** What the name suggests. "production" here cannot be overridden. */
  guessedEnv: ServerEnvironment;
  envKind: ServerEnvironment;
  access: AccessKind;
  enabled: boolean;
  /** The definition changed since the developer reviewed it; nothing is granted until they look again. */
  changed: boolean;
  /** Still defined in Claude Code's settings. */
  present: boolean;
  tools: ReportedTool[];
  allowed: Array<{ tool: string; check: CheckKind }>;
  projects: string[];
  checkedAt: number | null;
}

export class ConnectionError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

type Definition = Record<string, unknown>;

/** A name that can be part of an MCP tool name. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Names core uses for its own servers in an agent's run. */
export const RESERVED_SERVERS = new Set(['fryday_service', 'fryday_browser']);

// ─── Claude Code's definitions ────────────────────────────────────────────────

/** The MCP servers defined for this user, by name. Read fresh each time: the file is Claude Code's. */
export function readDefinitions(file = getConfig().claudeSettingsPath): Map<string, Definition> {
  const out = new Map<string, Definition>();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  let servers: unknown;
  try {
    servers = (JSON.parse(raw) as { mcpServers?: unknown }).mcpServers;
  } catch {
    return out;
  }
  if (!servers || typeof servers !== 'object') return out;
  for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
    if (def && typeof def === 'object' && !Array.isArray(def)) out.set(name, def as Definition);
  }
  return out;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

/** A fingerprint of a server's definition. It changes when anything about how the server starts changes. */
export function definitionHash(def: Definition): string {
  return createHash('sha256').update(JSON.stringify(canonical(def))).digest('hex');
}

function transportOf(def: Definition): DataConnection['transport'] {
  if (def['type'] === 'http' || def['type'] === 'sse') return def['type'];
  return typeof def['url'] === 'string' && !def['command'] ? 'http' : 'stdio';
}

function stdioDefinition(def: Definition): StdioDefinition | null {
  if (transportOf(def) !== 'stdio' || typeof def['command'] !== 'string' || !def['command']) return null;
  const args = Array.isArray(def['args']) ? def['args'].filter((a): a is string => typeof a === 'string') : [];
  const env: Record<string, string> = {};
  if (def['env'] && typeof def['env'] === 'object') {
    for (const [k, v] of Object.entries(def['env'] as Record<string, unknown>)) if (typeof v === 'string') env[k] = v;
  }
  return { command: def['command'], args, env };
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const RISKY_TOOL = /(^|[_.-])(insert|update|upsert|delete|drop|create|write|remove|rename|import|export|kill|admin|alter|truncate|grant|exec|execute|run|connect|disconnect|switch|use|set|put|post|patch|save|apply|migrate|restore|backup|shutdown)([_.-]|$)/i;
const SQL_TOOL = /sql|query/i;
const MONGO_TOOL = /^(find|aggregate|count|distinct|explain|aggregate-db|collection-|list-|db-stats)/i;

/** What to suggest for a tool, from its name and what it takes. A suggestion: the developer decides. */
export function classifyTool(tool: McpTool): Pick<ReportedTool, 'suggested' | 'risky'> {
  // "execute_sql" and "run_query" are how read tools are often named: the SQL check is what makes them safe.
  const properties = (tool.inputSchema?.['properties'] ?? {}) as Record<string, unknown>;
  const takesQuery = Object.keys(properties).some((k) => /sql|query|statement/i.test(k));
  if (takesQuery && SQL_TOOL.test(tool.name)) return { suggested: 'sql', risky: false };
  if (RISKY_TOOL.test(tool.name)) return { suggested: 'plain', risky: true };
  if (MONGO_TOOL.test(tool.name) && Object.keys(properties).some((k) => /pipeline|filter|query/i.test(k))) return { suggested: 'mongo', risky: false };
  return { suggested: 'plain', risky: false };
}

// ─── Stored state ─────────────────────────────────────────────────────────────

interface ConnectionRow {
  name: string; definition_hash: string; env_kind: ServerEnvironment; access: AccessKind; enabled: number;
  tools_json: string | null; checked_at: number | null;
}

const getRow = (name: string) => getDb().prepare('SELECT * FROM connections WHERE name = ?').get(name) as ConnectionRow | undefined;

function reportedTools(row: ConnectionRow | undefined): ReportedTool[] {
  if (!row?.tools_json) return [];
  try {
    const tools = JSON.parse(row.tools_json) as ReportedTool[];
    return Array.isArray(tools) ? tools : [];
  } catch {
    return [];
  }
}

function describe(name: string, def: Definition | undefined, row: ConnectionRow | undefined): DataConnection {
  const guessedEnv = guessEnvironment(name);
  const changed = Boolean(row && def && row.definition_hash !== definitionHash(def));
  const allowed = getDb().prepare('SELECT tool, check_kind FROM connection_tools WHERE connection = ? ORDER BY tool').all(name) as Array<{ tool: string; check_kind: CheckKind }>;
  const projects = getDb().prepare('SELECT project_id FROM role_grants WHERE connection = ? AND role = ? ORDER BY project_id').all(name, DATA_ROLE) as Array<{ project_id: string }>;
  return {
    name,
    transport: def ? transportOf(def) : 'stdio',
    canDiscover: Boolean(def && stdioDefinition(def)) && SERVER_NAME.test(name) && !RESERVED_SERVERS.has(name),
    guessedEnv,
    envKind: guessedEnv === 'production' ? 'production' : row?.env_kind ?? guessedEnv,
    access: row?.access ?? 'unknown',
    enabled: row?.enabled === 1,
    changed,
    present: def !== undefined,
    tools: reportedTools(row),
    allowed: allowed.map((a) => ({ tool: a.tool, check: a.check_kind })),
    projects: projects.map((p) => p.project_id),
    checkedAt: row?.checked_at ?? null,
  };
}

/** Every server Claude Code defines, with what the developer has decided about each. */
export function listDataConnections(): DataConnection[] {
  const definitions = readDefinitions();
  const names = new Set<string>(definitions.keys());
  for (const row of getDb().prepare('SELECT name FROM connections').all() as Array<{ name: string }>) names.add(row.name);
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => describe(name, definitions.get(name), getRow(name)));
}

export function getDataConnection(name: string): DataConnection | undefined {
  const def = readDefinitions().get(name);
  const row = getRow(name);
  return def || row ? describe(name, def, row) : undefined;
}

function requireDefinition(name: string): Definition {
  const def = readDefinitions().get(name);
  if (!def) throw new ConnectionError(`Claude Code has no MCP server named ${name}`, 404);
  if (!SERVER_NAME.test(name) || RESERVED_SERVERS.has(name)) throw new ConnectionError(`The name "${name}" cannot be used in a tool name; rename the server in Claude Code first`);
  return def;
}

/**
 * Start the server once and record which tools it has. This also records the definition
 * as reviewed: after a change, the developer lists the tools again and decides again.
 */
export async function discoverConnection(name: string, timeoutMs = 45_000): Promise<DataConnection> {
  const def = requireDefinition(name);
  const stdio = stdioDefinition(def);
  if (!stdio) throw new ConnectionError(`${name} is not a local program, so FryDay Code cannot list its tools. Only servers that start as a command are supported for agents so far.`);
  let tools: McpTool[];
  try {
    tools = await discoverTools(stdio, { timeoutMs });
  } catch (err) {
    if (!(err instanceof McpError)) throw err;
    throw new ConnectionError(`${name} did not list its tools: ${err.message}`, 502);
  }
  const reported: ReportedTool[] = tools
    .map((t) => ({ name: t.name, description: t.description.replace(/\s+/g, ' ').slice(0, 300), ...classifyTool(t) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const hash = definitionHash(def);
  const db = getDb();
  db.transaction(() => {
    const before = getRow(name);
    if (before && before.definition_hash !== hash) {
      // The server is not the one that was reviewed: start over with nothing granted.
      db.prepare('UPDATE connections SET enabled = 0 WHERE name = ?').run(name);
      db.prepare('DELETE FROM connection_tools WHERE connection = ?').run(name);
      db.prepare('DELETE FROM role_grants WHERE connection = ?').run(name);
    }
    db.prepare(`
      INSERT INTO connections (name, definition_hash, env_kind, tools_json, checked_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET definition_hash = excluded.definition_hash, tools_json = excluded.tools_json,
                                      checked_at = excluded.checked_at, updated_at = excluded.updated_at
    `).run(name, hash, guessEnvironment(name), JSON.stringify(reported), nowMs(), nowMs());
    // A tool that is gone, or that now looks risky, is no longer allowed.
    const usable = new Set(reported.filter((t) => !t.risky).map((t) => t.name));
    for (const row of db.prepare('SELECT tool FROM connection_tools WHERE connection = ?').all(name) as Array<{ tool: string }>) {
      if (!usable.has(row.tool)) db.prepare('DELETE FROM connection_tools WHERE connection = ? AND tool = ?').run(name, row.tool);
    }
  })();
  return getDataConnection(name)!;
}

export interface ConnectionChange {
  envKind?: ServerEnvironment;
  access?: AccessKind;
  enabled?: boolean;
  tools?: Array<{ tool: string; check: CheckKind }>;
  projects?: string[];
}

/** Apply what the developer decided about a connection. All of it is checked; nothing is half-applied. */
export function configureConnection(name: string, change: ConnectionChange): DataConnection {
  const def = requireDefinition(name);
  const row = getRow(name);
  if (!row) throw new ConnectionError(`List the tools of ${name} first`, 409);
  if (row.definition_hash !== definitionHash(def)) throw new ConnectionError(`${name} has changed in Claude Code's settings since you reviewed it. List its tools again.`, 409);

  const guessed = guessEnvironment(name);
  const envKind = change.envKind ?? row.env_kind;
  if (guessed === 'production' && envKind !== 'production') {
    throw new ConnectionError(`The name ${name} says production. It stays marked production and cannot be given to an agent; if the name is wrong, rename the server in Claude Code.`);
  }
  const access = change.access ?? row.access;
  const enabled = change.enabled ?? row.enabled === 1;
  if (enabled && envKind === 'production') throw new ConnectionError('A production connection cannot be turned on for agents');
  if (enabled && envKind === 'unknown') throw new ConnectionError('Say what this connection points at (local or staging) before turning it on');
  if (enabled && access !== 'read_only') throw new ConnectionError('Turn a connection on only when its database user can only read');

  const reported = new Map(reportedTools(row).map((t) => [t.name, t]));
  const tools = change.tools;
  if (tools) {
    for (const t of tools) {
      const known = reported.get(t.tool);
      if (!known) throw new ConnectionError(`${name} has no tool named ${t.tool}`);
      if (known.risky) throw new ConnectionError(`${t.tool} looks like it changes data or where the server points, so it cannot be given to an agent`);
      if (!['sql', 'mongo', 'plain'].includes(t.check)) throw new ConnectionError(`Unknown check for ${t.tool}`);
      if (known.suggested === 'sql' && t.check !== 'sql') throw new ConnectionError(`${t.tool} takes a query, so it keeps the SQL check`);
    }
  }
  const projects = change.projects;
  if (projects) for (const id of projects) if (!getRepo(id)) throw new ConnectionError(`Unknown project ${id}`);

  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE connections SET env_kind = ?, access = ?, enabled = ?, updated_at = ? WHERE name = ?').run(envKind, access, enabled ? 1 : 0, nowMs(), name);
    if (tools) {
      db.prepare('DELETE FROM connection_tools WHERE connection = ?').run(name);
      for (const t of tools) db.prepare('INSERT INTO connection_tools (connection, tool, check_kind) VALUES (?, ?, ?)').run(name, t.tool, t.check);
    }
    if (projects) {
      db.prepare('DELETE FROM role_grants WHERE connection = ? AND role = ?').run(name, DATA_ROLE);
      for (const id of projects) db.prepare('INSERT INTO role_grants (role, connection, project_id) VALUES (?, ?, ?)').run(DATA_ROLE, name, id);
    }
  })();
  return getDataConnection(name)!;
}

// ─── What a run gets ──────────────────────────────────────────────────────────

export interface GrantedConnection {
  name: string;
  envKind: 'local' | 'staging';
  /** The server's definition, copied as it is into the run's own MCP config. Never shown or logged. */
  definition: Definition;
  tools: Array<{ tool: string; check: CheckKind }>;
}

export interface Grants {
  granted: GrantedConnection[];
  /** Connections granted to the project that could not be given, each with the reason. */
  unavailable: Array<{ name: string; why: string }>;
}

/** The data connections a tester on this project gets right now. Everything is checked again at this moment. */
export function grantsFor(projectId: string, role: string = DATA_ROLE): Grants {
  const definitions = readDefinitions();
  const rows = getDb().prepare('SELECT connection FROM role_grants WHERE role = ? AND project_id = ? ORDER BY connection').all(role, projectId) as Array<{ connection: string }>;
  const out: Grants = { granted: [], unavailable: [] };
  for (const { connection: name } of rows) {
    const row = getRow(name);
    const def = definitions.get(name);
    const skip = (why: string) => out.unavailable.push({ name, why });
    if (!row || row.enabled !== 1) { skip('it is turned off'); continue; }
    if (!def) { skip("it is no longer in Claude Code's settings"); continue; }
    if (!SERVER_NAME.test(name) || RESERVED_SERVERS.has(name)) { skip('its name cannot be used'); continue; }
    if (row.definition_hash !== definitionHash(def)) { skip('its definition changed since you reviewed it'); continue; }
    if (guessEnvironment(name) === 'production' || (row.env_kind !== 'local' && row.env_kind !== 'staging')) { skip('it is not marked local or staging'); continue; }
    if (row.access !== 'read_only') { skip('it is not marked read-only'); continue; }
    const tools = (getDb().prepare('SELECT tool, check_kind FROM connection_tools WHERE connection = ? ORDER BY tool').all(name) as Array<{ tool: string; check_kind: CheckKind }>)
      .map((t) => ({ tool: t.tool, check: t.check_kind }));
    if (tools.length === 0) { skip('no tool is ticked for it'); continue; }
    out.granted.push({ name, envKind: row.env_kind, definition: def, tools });
  }
  return out;
}
