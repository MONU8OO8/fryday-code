#!/usr/bin/env node
// The only way a tester agent reaches the service under test.
// Usage: node serviceTool.mjs <config.json>
//
// A small MCP server (JSON-RPC over stdin/stdout, one message per line) with two tools:
//   request  one HTTP request to the service core started for this review, and nowhere else
//   log      the last part of what that service printed
//
// It is plain JavaScript with no dependencies because the agent's `claude` process starts
// it, outside core. The address it talks to comes from the config file core wrote; the
// agent chooses only the path, and a redirect is reported, never followed.

import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
// Headers that would change where a request goes or how the connection behaves.
const REFUSED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'te', 'trailer']);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** @param {string} file */
export function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = new URL(String(raw.baseUrl));
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || !base.port) {
    throw new Error('the service address must be http on this machine, with a port');
  }
  return {
    origin: base.origin,
    logPath: typeof raw.logPath === 'string' ? raw.logPath : null,
    // Which of the tools this run offers. Default: all. An agent is not shown a tool it may not use.
    tools: Array.isArray(raw.tools) ? raw.tools.filter((t) => typeof t === 'string') : null,
    maxBodyChars: Number.isInteger(raw.maxBodyChars) && raw.maxBodyChars > 0 ? raw.maxBodyChars : 60_000,
    timeoutMs: Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : 30_000,
  };
}

/**
 * The full address for a path the agent gave, or the reason it is refused.
 * Only a path on the service is accepted: no scheme, no host, no user info.
 * @param {string} origin @param {unknown} path @returns {{ url: string } | { error: string }}
 */
export function resolveTarget(origin, path) {
  if (typeof path !== 'string' || path === '') return { error: 'path is required, for example "/api/items?limit=5"' };
  if (!path.startsWith('/')) return { error: 'path must start with "/": only the service under test can be reached, so give the path, not a full address' };
  // "//host/x" and "/\host/x" are read by URL parsers as another host.
  if (/^\/[/\\]/.test(path) || /[\u0000-\u001f\u007f]/.test(path)) return { error: 'that path is not accepted' };
  let url;
  try {
    url = new URL(path, origin);
  } catch {
    return { error: 'that path is not accepted' };
  }
  if (url.origin !== origin || url.username || url.password) return { error: 'only the service under test can be reached' };
  return { url: url.href };
}

/** @param {unknown} headers @returns {{ headers: Record<string, string> } | { error: string }} */
export function cleanHeaders(headers) {
  if (headers === undefined || headers === null) return { headers: {} };
  if (typeof headers !== 'object' || Array.isArray(headers)) return { error: 'headers must be an object of name: value' };
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) return { error: `"${name}" is not a header name` };
    if (REFUSED_HEADERS.has(name.toLowerCase())) return { error: `the ${name} header cannot be set` };
    if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) return { error: `the value of ${name} must be one line of text` };
    out[name] = value;
  }
  return { headers: out };
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** Cookies the service set, kept for this run so a login carries over to the next request. */
const cookies = new Map();

function rememberCookies(response) {
  const set = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const line of set) {
    const pair = line.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '' || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) cookies.delete(name);
    else cookies.set(name, value);
  }
}

/** @param {ReturnType<typeof loadConfig>} cfg @param {Record<string, unknown>} args */
export async function request(cfg, args) {
  const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
  if (!METHODS.includes(method)) return text(`method must be one of ${METHODS.join(', ')}`, true);
  const target = resolveTarget(cfg.origin, args.path);
  if ('error' in target) return text(target.error, true);
  const cleaned = cleanHeaders(args.headers);
  if ('error' in cleaned) return text(cleaned.error, true);
  const headers = cleaned.headers;

  let body;
  if (args.json !== undefined && args.body !== undefined) return text('give either json or body, not both', true);
  if (args.json !== undefined) {
    body = JSON.stringify(args.json);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  } else if (args.body !== undefined) {
    if (typeof args.body !== 'string') return text('body must be text; use json for a JSON value', true);
    body = args.body;
  }
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) return text(`a ${method} request cannot have a body`, true);
  if (cookies.size > 0 && !Object.keys(headers).some((h) => h.toLowerCase() === 'cookie')) {
    headers['cookie'] = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  const started = Date.now();
  let response;
  try {
    // A redirect is never followed: it could point anywhere.
    response = await fetch(target.url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(cfg.timeoutMs) });
  } catch (err) {
    const why = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    return text(`The request did not complete: ${why}. The service may have stopped; the "log" tool shows what it printed.`, true);
  }
  rememberCookies(response);
  let bodyText = '';
  try {
    bodyText = method === 'HEAD' ? '' : await response.text();
  } catch (err) {
    bodyText = `[the body could not be read: ${err instanceof Error ? err.message : String(err)}]`;
  }
  const cut = bodyText.length > cfg.maxBodyChars;
  const lines = [`HTTP ${response.status} ${response.statusText}`.trim(), `(${Date.now() - started} ms)`];
  for (const [name, value] of response.headers) lines.push(`${name}: ${name.toLowerCase() === 'set-cookie' ? value.split(';')[0].replace(/=.*/, '=[kept for your next requests]') : value}`);
  if (response.status >= 300 && response.status < 400) {
    lines.push('', 'This is a redirect and it was not followed. If the Location is a path on this service, request that path yourself.');
  }
  lines.push('', cut ? `${bodyText.slice(0, cfg.maxBodyChars)}\n[body cut: ${bodyText.length} characters in all]` : bodyText);
  return text(lines.join('\n'));
}

/** @param {ReturnType<typeof loadConfig>} cfg @param {Record<string, unknown>} args */
export function serviceLog(cfg, args) {
  if (!cfg.logPath) return text('No log is kept for this service.', true);
  const max = Math.min(Math.max(Number.isInteger(args.maxChars) ? Number(args.maxChars) : 8000, 500), 40_000);
  try {
    const size = fs.statSync(cfg.logPath).size;
    const fd = fs.openSync(cfg.logPath, 'r');
    try {
      const length = Math.min(size, max * 4);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      const tail = buf.toString('utf8').slice(-max);
      return text(tail.trim() === '' ? '(the service has printed nothing)' : tail);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return text('(the service has printed nothing)');
  }
}

export const TOOLS = [
  {
    name: 'request',
    description:
      'Send one HTTP request to the service under test and get its status, headers and body. Only that service can be reached: give a path such as "/api/items?limit=5", never a full address. Redirects are reported, not followed. Cookies the service sets are kept for your later requests.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        method: { type: 'string', enum: METHODS, description: 'Default GET.' },
        path: { type: 'string', description: 'Path and query on the service, starting with "/".' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        json: { description: 'A JSON value to send as the body (sets content-type: application/json).' },
        body: { type: 'string', description: 'A text body, when not sending JSON.' },
      },
    },
  },
  {
    name: 'log',
    description: 'The last part of what the service under test printed (stdout and stderr). Use it when a request fails or behaves oddly.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { maxChars: { type: 'integer', description: 'How much of the end to return. Default 8000.' } },
    },
  },
];

/** @param {ReturnType<typeof loadConfig>} cfg @param {string} name */
const offered = (cfg, name) => !cfg.tools || cfg.tools.includes(name);

/** @param {ReturnType<typeof loadConfig>} cfg @param {any} msg @returns {Promise<object | null>} the reply, or null for a notification */
export async function handle(cfg, msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return msg && msg.id !== undefined ? fail(-32600, 'not a request') : null;
  if (msg.id === undefined || msg.id === null) return null; // a notification: nothing to answer
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fryday-service', version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.filter((t) => offered(cfg, t.name)) });
    case 'tools/call': {
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
      const name = msg.params?.name;
      if (name === 'request' && offered(cfg, name)) return reply(await request(cfg, args));
      if (name === 'log' && offered(cfg, name)) return reply(serviceLog(cfg, args));
      return fail(-32602, `unknown tool: ${String(name)}`);
    }
    default:
      return fail(-32601, `unknown method: ${msg.method}`);
  }
}

function main() {
  let cfg;
  try {
    cfg = loadConfig(process.argv[2] ?? '');
  } catch (err) {
    process.stderr.write(`fryday service tool: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    // One at a time, in order, so cookies from one request are there for the next.
    pending = pending.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } })}\n`);
        return;
      }
      const out = await handle(cfg, msg).catch((err) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }));
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    });
  });
  rl.on('close', () => { void pending.then(() => process.exit(0)); });
}

// Run as a program (not imported by a test). fileURLToPath, because a folder name may hold spaces.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
