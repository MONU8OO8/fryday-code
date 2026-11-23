// Guard decision logic — plain JavaScript with no dependencies, because it runs inside
// the PreToolUse hook (guard/hook.mjs) on every tool call an agent makes.
//
// Default-deny: a call is allowed only when the policy explicitly covers it. This is
// the second layer; the first is that an agent is only given the tools in its policy,
// and Bash additionally runs inside an OS sandbox.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ check: 'none' | 'sql' | 'mongo' | 'url' | 'no-file', origin?: string }} McpRule
 * @typedef {{ role: string, allowedTools: string[], readRoots: string[], writeRoots: string[], mcp?: Record<string, McpRule> }} GuardPolicy
 * @typedef {{ allow: true } | { allow: false, reason: string }} Decision
 */

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

// Roles that read only the text core gives them (policy.ts NO_TOOL_ROLES). Every call but
// their final structured answer is refused, even if their policy file lists tools by mistake.
const NO_TOOL_ROLES = new Set(['fryday', 'reflector', 'system']);
const STRUCTURED_OUTPUT = 'StructuredOutput';
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// Files that hold secrets, wherever they are — even inside a root the agent may read.
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|p12|pfx|keystore)|.*creds?.*\.sh|credentials(\.json)?|secrets?(\.(json|ya?ml|env))?)$/i;
const SECRET_OK = /(^|\/)\.env\.(example|sample|template)$/i;

// Paths inside a writable root that are never an agent's to change: git internals and
// Claude settings or hooks, which would run as the owner the next time they are loaded.
const NO_WRITE = /(^|\/)(\.git(\/|$)|\.claude\/(settings[^/]*\.json|hooks(\/|$)))/;

// Programs an agent has no business running. Checked at command position (the first
// word of each part of a pipeline or list), so the word may still appear as an argument.
const DENIED_PROGRAMS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp',
  'sudo', 'su', 'doas', 'osascript', 'open', 'security', 'launchctl', 'crontab', 'at',
  'pm2', 'clasp', 'gh', 'aws', 'gcloud', 'kubectl', 'docker', 'terraform', 'defaults', 'pbcopy', 'pbpaste',
  // Linux: opening things in the desktop session, and starting or talking to services
  // that run outside the sandbox (systemd units, the D-Bus session and system buses).
  'xdg-open', 'gio', 'systemctl', 'systemd-run', 'dbus-send', 'gdbus', 'busctl',
  'x-www-browser', 'sensible-browser', 'loginctl',
  // Linux: running as another user (polkit, systemd), leaving the sandbox through the host's
  // Flatpak portal, entering or making namespaces, and containers.
  'pkexec', 'run0', 'flatpak-spawn', 'nsenter', 'unshare', 'podman',
]);
// Words that only introduce another command.
const WRAPPERS = new Set(['env', 'xargs', 'exec', 'nohup', 'time', 'command', 'builtin', 'nice', 'timeout', 'caffeinate', 'then', 'do', 'else', '!', '{']);
// Code handed to an interpreter as a string cannot be split into commands here, so
// with one of these present the denied programs are refused anywhere in the command.
const INLINE_CODE = /(^|[\s;&|(`])(sh|bash|zsh|dash|ksh|python3?|node|deno|bun|perl|ruby|php)\b[^;&|]*\s-(c|e|-eval|-exec)\b|(^|[\s;&|(`])(eval|source|\.)\s/;
const ANYWHERE = new RegExp(`(^|[^A-Za-z0-9_.-])(${[...DENIED_PROGRAMS].join('|')})(?=$|[^A-Za-z0-9_.-])`);
const DENIED_PKG = /\b(npm|pnpm|yarn)\b[^;&|]*\b(publish|login|adduser|token|owner|dist-tag|unpublish)\b/;
// The workspace's git data lives in the owner's repository, which an agent cannot read
// or write. Fryday records the agent's changes itself.
const GIT_REASON = 'git is not available in this workspace; Fryday records your changes, so just edit the files';
const RAW_SOCKET = /\/dev\/(tcp|udp)\//;

/** The program at the start of each part of a shell command line. @param {string} command */
export function commandPrograms(command) {
  const programs = [];
  for (const part of command.split(/\$\(|[;&|()`\n]/)) {
    for (const word of part.trim().split(/\s+/).filter(Boolean)) {
      const bare = word.replace(/^['"]+|['"]+$/g, '');
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(bare) || bare.startsWith('-') || /^\d+[smhd]?$/.test(bare)) continue;
      const name = path.basename(bare);
      if (WRAPPERS.has(name)) continue;
      programs.push(name);
      break;
    }
  }
  return programs;
}

/**
 * Absolute path with symlinks resolved. Works for paths that do not exist yet by
 * resolving the deepest existing ancestor and appending the rest.
 * @param {string} p @param {string} cwd
 */
export function resolveReal(p, cwd) {
  let current = path.resolve(cwd, p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail.reverse());
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** @param {string} target @param {string[]} roots @param {string} cwd */
export function isInside(target, roots, cwd) {
  return roots.some((root) => {
    const r = resolveReal(root, cwd);
    return target === r || target.startsWith(r + path.sep);
  });
}

/** @param {string} realPath */
export function isSecretFile(realPath) {
  return SECRET_FILE.test(realPath) && !SECRET_OK.test(realPath);
}

/** @param {string} command @returns {string | null} the reason it is refused, or null */
export function bashDenyReason(command) {
  const programs = commandPrograms(command);
  if (programs.includes('git')) return GIT_REASON;
  const denied = programs.find((name) => DENIED_PROGRAMS.has(name));
  if (denied) return `the program "${denied}" is not available to this agent`;
  if (INLINE_CODE.test(command)) {
    const hidden = command.match(ANYWHERE);
    if (hidden) return `"${hidden[2]}" inside inline code is not available to this agent`;
    if (/(^|[^A-Za-z0-9_.-])git(?=$|[^A-Za-z0-9_.-])/.test(command)) return GIT_REASON;
  }
  if (DENIED_PKG.test(command)) return 'package registry commands are not available to this agent';
  if (RAW_SOCKET.test(command)) return 'network access is not available to this agent';
  return null;
}

const deny = (reason) => ({ allow: false, reason });

// ─── Tools from MCP servers ────────────────────────────────────────────────────
//
// An agent only has the MCP tools its policy lists, by full name. Some carry a check on
// what is passed to them. These checks stop the obvious ways to change data or leave
// the service under test; they do not replace a database user that can only read.

const SQL_MAX_CHARS = 20_000;
const SQL_START = /^(select|show|explain|describe|desc|with)\b/i;
// Anything that changes data, structure, session or server state, or writes a file.
const SQL_FORBIDDEN = new RegExp(`\\b(${[
  'insert', 'update', 'delete', 'merge', 'upsert', 'drop', 'alter', 'create', 'truncate', 'rename', 'grant', 'revoke',
  'call', 'exec', 'execute', 'do', 'set', 'lock', 'unlock', 'load', 'copy', 'handler', 'into', 'outfile', 'dumpfile',
  'prepare', 'deallocate', 'begin', 'start', 'commit', 'rollback', 'savepoint', 'use', 'kill', 'shutdown', 'vacuum',
  'analyze', 'reindex', 'refresh', 'attach', 'detach', 'pragma', 'flush', 'reset', 'purge', 'install', 'uninstall',
  'optimize', 'repair', 'notify', 'listen', 'discard', 'comment', 'cluster', 'checkpoint',
].join('|')})\\b`, 'i');
// Functions that act rather than compute: sleeping, locking, files, other servers, sequences.
const SQL_FUNCTIONS = /\b(pg_[a-z0-9_]+|lo_[a-z0-9_]+|dblink[a-z0-9_]*|nextval|setval|set_config|sleep|benchmark|load_file|get_lock|release_lock|xp_[a-z0-9_]+|sp_[a-z0-9_]+)\s*\(/i;

/**
 * SQL with its string literals emptied and its comments removed, so that words inside
 * them are not mistaken for commands. Null when a literal or comment never ends.
 * @param {string} sql @returns {string | null}
 */
export function sqlSkeleton(sql) {
  let out = '';
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--' || ch === '#') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      out += ' ';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return null;
        if (sql[j] === '\\' && ch !== '`') { j += 2; continue; }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; } // a doubled quote is the quote itself
          break;
        }
        j++;
      }
      out += ch === '`' ? ' ident ' : "''";
      i = j + 1;
    } else if (ch === '$') {
      // PostgreSQL dollar quoting: $$text$$ or $tag$text$tag$
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (!tag) { out += ch; i++; continue; }
      const end = sql.indexOf(tag[0], i + tag[0].length);
      if (end === -1) return null;
      out += "''";
      i = end + tag[0].length;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** @param {unknown} sql @returns {string | null} why the statement is refused, or null when it only reads */
export function sqlDenyReason(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') return 'a query is required';
  if (sql.length > SQL_MAX_CHARS) return 'the query is too long';
  // MySQL runs what is inside /*! ... */, so it is not a comment.
  if (/\/\*[!+]/.test(sql)) return 'comments that the database executes (/*! ... */) are not accepted';
  const skeleton = sqlSkeleton(sql);
  if (skeleton === null) return 'the query has a string or comment that never ends';
  const statement = skeleton.trim().replace(/[;\s]+$/, '');
  if (statement.includes(';')) return 'only one statement at a time is accepted';
  if (!SQL_START.test(statement)) return 'only SELECT, SHOW, EXPLAIN and DESCRIBE are available: this connection is for reading';
  // SHOW and DESCRIBE only report ("SHOW CREATE TABLE" writes nothing), so their words are not commands.
  if (/^(show|describe|desc)\b/i.test(statement)) return null;
  const word = statement.match(SQL_FORBIDDEN);
  if (word) return `"${word[1].toUpperCase()}" is not accepted: this connection is for reading only`;
  const fn = statement.match(SQL_FUNCTIONS);
  if (fn) return `the function ${fn[1]}() is not accepted: this connection is for reading only`;
  return null;
}

// Stages and operators that write, or run code on the server.
const MONGO_FORBIDDEN = /\$(out|merge|function|accumulator|where)\b/;

/** @param {Record<string, unknown>} input @returns {string | null} */
export function mongoDenyReason(input) {
  let flat;
  try {
    flat = JSON.stringify(input);
  } catch {
    return 'the arguments could not be read';
  }
  // A pipeline may also arrive as text; the escaped form is matched the same way.
  const hit = flat.match(MONGO_FORBIDDEN);
  return hit ? `"$${hit[1]}" is not accepted: this connection is for reading only` : null;
}

/** @param {McpRule} rule @param {Record<string, unknown>} input @returns {Decision} */
export function decideMcp(rule, input) {
  if (!rule || typeof rule !== 'object') return deny('guard policy is missing or malformed');
  if (rule.check === 'none') return { allow: true };
  if (rule.check === 'sql') {
    const queries = Object.entries(input).filter(([key, value]) => /sql|query|statement/i.test(key) && typeof value === 'string');
    if (queries.length === 0) return deny('no query was found in the arguments, so it could not be checked');
    for (const [, query] of queries) {
      const reason = sqlDenyReason(query);
      if (reason) return deny(reason);
    }
    return { allow: true };
  }
  if (rule.check === 'mongo') {
    const reason = mongoDenyReason(input);
    return reason ? deny(reason) : { allow: true };
  }
  if (rule.check === 'url') {
    let url;
    try {
      url = new URL(String(input['url'] ?? ''));
    } catch {
      return deny('a full address on the service under test is required');
    }
    if (typeof rule.origin !== 'string' || url.origin !== rule.origin || url.username || url.password) {
      return deny(`only the service under test (${rule.origin ?? 'none'}) can be opened`);
    }
    return { allow: true };
  }
  if (rule.check === 'no-file') {
    if (input['filename'] !== undefined && input['filename'] !== null && input['filename'] !== '') {
      return deny('leave "filename" out: the file is named and kept for you');
    }
    return { allow: true };
  }
  return deny(`no guard rule covers the check "${String(rule.check)}"`);
}

/**
 * @param {GuardPolicy} policy
 * @param {string} toolName
 * @param {Record<string, unknown>} toolInput
 * @param {string} cwd
 * @returns {Decision}
 */
export function decide(policy, toolName, toolInput, cwd) {
  if (!policy || !Array.isArray(policy.allowedTools) || !Array.isArray(policy.readRoots) || !Array.isArray(policy.writeRoots)) {
    return deny('guard policy is missing or malformed');
  }
  if (NO_TOOL_ROLES.has(policy.role) && !(toolName === STRUCTURED_OUTPUT && policy.allowedTools.includes(STRUCTURED_OUTPUT))) {
    return deny(`the ${policy.role} agent has no tools: it answers from the text it was given`);
  }
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
    const rule = policy.mcp && typeof policy.mcp === 'object' && Object.prototype.hasOwnProperty.call(policy.mcp, toolName) ? policy.mcp[toolName] : null;
    if (!rule) return deny(`the tool "${toolName}" is not available to the ${policy.role} agent`);
    return decideMcp(rule, input);
  }
  if (typeof toolName !== 'string' || !policy.allowedTools.includes(toolName)) {
    return deny(`the tool "${toolName}" is not available to the ${policy.role} agent`);
  }

  if (READ_TOOLS.has(toolName)) {
    const raw = toolName === 'Read' ? input['file_path'] : input['path'] ?? cwd;
    if (typeof raw !== 'string' || raw === '') return deny(`${toolName} needs a path`);
    const target = resolveReal(raw, cwd);
    // A glob pattern can itself point somewhere else ("/etc/**", "../../x/*").
    const pattern = toolName === 'Glob' ? input['pattern'] : undefined;
    if (typeof pattern === 'string') {
      const fixedPart = pattern.split(/[*?[{]/)[0] ?? '';
      const from = pattern.startsWith('~') ? null : resolveReal(path.resolve(target, fixedPart), cwd);
      if (from === null || !isInside(from, policy.readRoots, cwd)) return deny(`the pattern ${pattern} reaches outside this task's workspace`);
    }
    if (!isInside(target, policy.readRoots, cwd)) return deny(`${target} is outside this task's workspace`);
    if (isSecretFile(target)) return deny(`${path.basename(target)} looks like a secrets file`);
    return { allow: true };
  }

  if (WRITE_TOOLS.has(toolName)) {
    const raw = input['file_path'] ?? input['notebook_path'];
    if (typeof raw !== 'string' || raw === '') return deny(`${toolName} needs a path`);
    const target = resolveReal(raw, cwd);
    if (!isInside(target, policy.writeRoots, cwd)) return deny(`${target} is outside this task's workspace`);
    if (isSecretFile(target)) return deny(`${path.basename(target)} looks like a secrets file`);
    const root = policy.writeRoots.map((r) => resolveReal(r, cwd)).find((r) => target === r || target.startsWith(r + path.sep));
    if (NO_WRITE.test(path.relative(root, target))) return deny(`${path.relative(root, target)} is protected`);
    return { allow: true };
  }

  if (toolName === 'Bash') {
    const command = input['command'];
    if (typeof command !== 'string' || command.trim() === '') return deny('Bash needs a command');
    const reason = bashDenyReason(command);
    return reason ? deny(reason) : { allow: true };
  }

  // The agent's final answer in a required JSON shape; it reads and writes nothing.
  if (toolName === 'StructuredOutput') return { allow: true };

  // A tool the policy lists but this guard does not know how to check.
  return deny(`no guard rule covers the tool "${toolName}"`);
}
