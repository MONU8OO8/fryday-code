/**
 * Runners: the programs an agent can run as. The supervisor (supervisor.ts) starts a run
 * through its runner and reads the runner's output back in Claude Code's event shape, so
 * offsets, the database, usage and live events work the same for every runner.
 *
 *   claude       Claude Code on this Mac. Every guarantee: the per-run guard hook on every
 *                tool call, structured output, a spending limit, the OS sandbox around its
 *                shell, MCP tools only as core grants them.
 *   cursor       The Cursor CLI on this Mac, for read-only agents only (Analyst, Planner).
 *                It has no per-run guard hook and no structured output, so: it runs in
 *                Cursor's read-only "ask" mode; the whole Cursor process runs inside the OS
 *                sandbox (reads: its checkout and its own install; writes: a throwaway home;
 *                network: Cursor's servers only); with a throwaway HOME, so none of the
 *                owner's Cursor hooks, MCP servers, rules or credential files are loaded; and
 *                signed in with a Cursor API key the owner gave FryDay. Its JSON answer is
 *                read from its last message and checked like any other.
 *   claude-ssh   Claude Code on another machine over SSH. Defined, not usable: there is no
 *                machine to prove its guarantees on yet.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getConfig, findOnPath } from '../config.js';
import { policyCliFlags, type AgentRole } from '../guard/policy.js';
import { writeRunGuard, type McpRule } from '../guard/runGuard.js';
import { parseLine, type ClaudeEvent } from './streamParser.js';
import { nestedSandbox } from '../platform.js';
import { ciNetworkSettings, ciSandboxSettings, srtPkgDir } from '../pipeline/sandbox.js';

export type RunnerId = 'claude' | 'cursor' | 'claude-ssh';

export interface RunnerCaps {
  /** Every tool call passes FryDay's guard hook. */
  guardHook: boolean;
  /** The answer is forced into a JSON schema by the engine itself. */
  structuredOutput: boolean;
  /** What the OS sandbox covers: only the agent's shell, or the whole agent process. */
  osSandbox: 'shell' | 'whole-process' | 'none';
  /** A spending limit the engine stops at. */
  budgetStop: boolean;
  /** Roles it may be used for. */
  roles: AgentRole[];
}

export interface PrepareInput {
  runId: string;
  role: AgentRole;
  model: string;
  effort: string;
  budgetUsd: number;
  prompt: string;
  appendSystemPrompt?: string;
  jsonSchema?: Record<string, unknown>;
  resumeSessionId?: string;
  workspacePath?: string;
  mcp?: { configPath: string; tools: Record<string, McpRule> };
  /** Files the process gets as its stdin, stdout and stderr. */
  stdioFiles?: string[];
}

export interface PreparedRun {
  bin: string;
  args: string[];
  /** What goes to the program's stdin (the prompt; never on the command line). */
  stdinText: string;
  /** Environment beyond the supervisor's own short list. */
  env: Record<string, string>;
  /** Remove what prepare() created for this run. */
  cleanup: () => void;
}

export interface NormalizeContext {
  /** The run was asked for an answer in a JSON schema. */
  wantsJson: boolean;
  seq: number;
}

export interface AgentRunner {
  id: RunnerId;
  label: string;
  caps: RunnerCaps;
  /** Whether it can run on this Mac now, and if not, why. */
  available(): { ok: boolean; why?: string };
  prepare(input: PrepareInput): PreparedRun;
  /** One output line → Claude-shaped events (none, one or more). */
  normalize(line: string, ctx: NormalizeContext): ClaudeEvent[];
  /** A word in the process's command line, to recognise it after a restart. */
  processMarker: string;
}

// ─── Claude Code ──────────────────────────────────────────────────────────────

export const claudeRunner: AgentRunner = {
  id: 'claude',
  label: 'Claude Code',
  caps: { guardHook: true, structuredOutput: true, osSandbox: 'shell', budgetStop: true, roles: ['fryday', 'analyst', 'planner', 'coder', 'tester', 'api_tester', 'ui_tester', 'system'] },
  available() {
    const bin = getConfig().claudeBin;
    return path.isAbsolute(bin) ? (fs.existsSync(bin) ? { ok: true } : { ok: false, why: `${bin} was not found` }) : findOnPath(bin) ? { ok: true } : { ok: false, why: 'claude is not on PATH' };
  },
  get processMarker() { return path.basename(getConfig().claudeBin); },
  prepare(input) {
    const cfg = getConfig();
    const flags = [
      '-p', '--verbose', '--output-format', 'stream-json',
      '--model', input.model, '--effort', input.effort, '--max-budget-usd', input.budgetUsd.toFixed(4),
      ...policyCliFlags(input.role),
      '--strict-mcp-config',
      // No user, project or local settings files: nothing in a repo or in the owner's own
      // Claude setup can add hooks, widen permissions or load unrelated instructions.
      '--setting-sources', '',
    ];
    if (input.workspacePath) {
      const guard = writeRunGuard({
        runId: input.runId, role: input.role, workspacePath: input.workspacePath, runsDir: cfg.runsDir, structuredOutput: input.jsonSchema !== undefined,
        mcpTools: input.mcp?.tools,
      });
      flags.push('--settings', guard.settingsPath);
    }
    if (input.mcp) {
      if (!input.workspacePath) throw new Error('An agent with MCP tools must be confined to a workspace');
      flags.push('--mcp-config', input.mcp.configPath);
    }
    if (input.appendSystemPrompt) flags.push('--append-system-prompt', input.appendSystemPrompt);
    if (input.resumeSessionId) flags.push('--resume', input.resumeSessionId);
    if (input.jsonSchema) flags.push('--json-schema', JSON.stringify(input.jsonSchema));
    return { bin: cfg.claudeBin, args: flags, stdinText: input.prompt, env: {}, cleanup: () => undefined };
  },
  normalize(line) {
    const e = parseLine(line);
    return e ? [e] : [];
  },
};

// ─── Cursor CLI ───────────────────────────────────────────────────────────────

/** Hosts the Cursor CLI may reach from its sandbox. */
export const CURSOR_HOSTS = ['cursor.sh', '*.cursor.sh', 'cursor.com', '*.cursor.com'];
const CURSOR_MODEL = /^[a-z0-9][a-z0-9.\-]{0,60}$/;

const cursorKeyFile = () => path.join(getConfig().home, 'cursor-api-key');

export function cursorKeySet(): boolean {
  try {
    return fs.readFileSync(cursorKeyFile(), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

export class RunnerConfigError extends Error {}

/** Keep the owner's Cursor API key (Cursor → Dashboard → Integrations → User API Keys). Never returned. */
export function saveCursorKey(raw: unknown): void {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length < 20 || key.length > 400 || /\s/.test(key)) throw new RunnerConfigError('That does not look like a Cursor API key');
  fs.mkdirSync(path.dirname(cursorKeyFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cursorKeyFile(), `${key}\n`, { mode: 0o600 });
  fs.chmodSync(cursorKeyFile(), 0o600);
}

export function removeCursorKey(): void {
  fs.rmSync(cursorKeyFile(), { force: true });
}

/** The cursor-agent program, with links followed (its install lives under ~/.local/share). */
export function cursorBin(): string | null {
  const configured = process.env['CURSOR_AGENT_BIN'];
  const found = configured && fs.existsSync(configured) ? configured : findOnPath('cursor-agent');
  if (!found) return null;
  try {
    return fs.realpathSync(found);
  } catch {
    return found;
  }
}

function srtCli(): string {
  return path.join(path.dirname(require.resolve('@anthropic-ai/sandbox-runtime/package.json')), 'dist', 'cli.js');
}
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const nodeInstallDir = () => path.dirname(path.dirname(fs.realpathSync(process.execPath)));

/**
 * The sandbox around the whole Cursor process. Its own stdin/stdout/stderr files are
 * readable too: Node checks them when it starts and aborts when it may not. They hold
 * nothing but this run's prompt and output; other runs' files stay out of reach.
 */
export function cursorSandbox(workspacePath: string, home: string, tmp: string, bin: string, stdioFiles: string[] = []): Record<string, unknown> {
  // The install folder holds the program and its bundled runtime; nothing of the owner's.
  const install = path.dirname(bin);
  return {
    network: { allowedDomains: CURSOR_HOSTS, deniedDomains: [], ...ciNetworkSettings() },
    filesystem: {
      denyRead: [os.homedir()],
      // srtPkgDir: the sandbox runtime runs apply-seccomp out of its own package, and a
      // checkout under the home folder would otherwise be hidden by the denyRead above.
      allowRead: [workspacePath, home, tmp, install, nodeInstallDir(), srtPkgDir(), ...stdioFiles],
      // The checkout is read-only for Cursor; it may write only its own throwaway home and temp folder.
      allowWrite: [home, tmp],
      denyWrite: [],
    },
    ...ciSandboxSettings(),
    ...nestedSandbox(),
  };
}

export const cursorRunner: AgentRunner = {
  id: 'cursor',
  label: 'Cursor CLI (reduced isolation)',
  caps: { guardHook: false, structuredOutput: false, osSandbox: 'whole-process', budgetStop: false, roles: ['analyst', 'planner'] },
  processMarker: 'cursor-agent',
  available() {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return { ok: false, why: 'the sandbox around Cursor needs macOS or Linux' };
    if (!cursorBin()) return { ok: false, why: 'cursor-agent is not installed' };
    if (!cursorKeySet()) return { ok: false, why: 'no Cursor API key is set (Connections page)' };
    return { ok: true };
  },
  prepare(input) {
    if (!this.caps.roles.includes(input.role)) throw new RunnerConfigError(`The Cursor CLI is not used for the ${input.role}: it has no guard on each tool call`);
    if (!input.workspacePath) throw new RunnerConfigError('A Cursor agent must have a workspace');
    if (input.mcp) throw new RunnerConfigError('A Cursor agent gets no MCP tools');
    const bin = cursorBin();
    if (!bin) throw new RunnerConfigError('cursor-agent is not installed');
    let key = '';
    try { key = fs.readFileSync(cursorKeyFile(), 'utf8').trim(); } catch { /* checked below */ }
    if (!key) throw new RunnerConfigError('No Cursor API key is set (Connections page)');
    if (!CURSOR_MODEL.test(input.model)) throw new RunnerConfigError(`"${input.model}" is not a Cursor model name`);

    const cfg = getConfig();
    // Short paths: the sandbox keeps sockets in the temp folder.
    const base = path.join(cfg.runsDir, `${input.runId.slice(0, 16)}.cursor`);
    const home = path.join(base, 'home');
    const tmp = path.join(base, 'tmp');
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    // Cursor's own settings in the throwaway home: no rules, no hooks, no MCP servers, and
    // writes and shell refused by Cursor itself on top of ask mode and the sandbox.
    fs.writeFileSync(path.join(home, '.cursor', 'cli-config.json'), JSON.stringify({ version: 1, permissions: { allow: [], deny: ['Shell(*)', 'Write(**)'] } }), { mode: 0o600 });
    const settings = path.join(base, 'sandbox.json');
    fs.writeFileSync(settings, JSON.stringify(cursorSandbox(input.workspacePath, home, tmp, bin, input.stdioFiles)), { mode: 0o600 });

    // Cursor has no system prompt or JSON schema flags: both go into the prompt itself.
    const parts = [
      input.appendSystemPrompt ? `# How you work\n\n${input.appendSystemPrompt}` : '',
      `# Your task\n\n${input.prompt}`,
      input.jsonSchema ? `# Your answer\n\nEnd with one JSON object that matches this JSON schema, in a fenced \`\`\`json block, and nothing after it:\n\n${JSON.stringify(input.jsonSchema)}` : '',
    ].filter(Boolean);
    const command = [
      `export TMPDIR=${shq(tmp)} HOME=${shq(home)};`,
      shq(bin), '-p', '--mode', 'ask', '--sandbox', 'enabled', '--trust', '--output-format', 'stream-json', '--model', shq(input.model),
      ...(input.resumeSessionId ? ['--resume', shq(input.resumeSessionId)] : []),
    ].join(' ');
    return {
      bin: process.execPath,
      args: [srtCli(), '--settings', settings, '-c', command],
      stdinText: parts.join('\n\n'),
      env: { CURSOR_API_KEY: key, HOME: home },
      cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
    };
  },
  normalize(line, ctx) {
    const e = parseLine(line) as Record<string, any> | null;
    if (!e) return [];
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    switch (e['type']) {
      case 'system':
        return e['subtype'] === 'init' ? [{ type: 'system', subtype: 'init', session_id: String(e['session_id'] ?? ''), model: String(e['model'] ?? 'cursor'), tools: [], mcp_servers: [] }] : [];
      case 'assistant': {
        const text = (e['message']?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => String(c.text)).join('');
        if (!text) return [];
        return [{ type: 'assistant', message: { id: String(e['model_call_id'] ?? `cursor-${ctx.seq++}`), role: 'assistant', model: 'cursor', stop_reason: '', content: [{ type: 'text', text }], usage: zero }, session_id: String(e['session_id'] ?? '') }];
      }
      case 'tool_call': {
        if (e['subtype'] !== 'started') return [];
        const call = e['tool_call'] ?? {};
        const kind = Object.keys(call).find((k) => k.endsWith('ToolCall')) ?? 'tool';
        const name = ({ readToolCall: 'Read', editToolCall: 'Edit', writeToolCall: 'Write', shellToolCall: 'Bash', grepToolCall: 'Grep', globToolCall: 'Glob', lsToolCall: 'LS' } as Record<string, string>)[kind] ?? kind.replace(/ToolCall$/, '');
        return [{ type: 'assistant', message: { id: `cursor-tool-${String(e['call_id'] ?? ctx.seq++)}`, role: 'assistant', model: 'cursor', stop_reason: '', content: [{ type: 'tool_use', id: String(e['call_id'] ?? ''), name, input: call[kind]?.args ?? {} }], usage: zero }, session_id: '' }];
      }
      case 'result': {
        const u = e['usage'] ?? {};
        const result = typeof e['result'] === 'string' ? e['result'] : '';
        const structured = ctx.wantsJson ? lastJsonObject(result) : undefined;
        return [{
          type: 'result', subtype: e['is_error'] ? 'error_during_execution' : 'success', is_error: Boolean(e['is_error']), result, session_id: String(e['session_id'] ?? ''),
          usage: { input_tokens: Number(u.inputTokens ?? 0), output_tokens: Number(u.outputTokens ?? 0), cache_read_input_tokens: Number(u.cacheReadTokens ?? 0), cache_creation_input_tokens: Number(u.cacheWriteTokens ?? 0) },
          // Cursor bills by plan, not per run: no dollar figure is invented here.
          total_cost_usd: 0,
          ...(structured !== undefined ? { structured_output: structured } : {}),
        }];
      }
      default:
        return [];
    }
  },
};

/** The last JSON object in a message: a fenced ```json block, or the whole text when it is one. */
export function lastJsonObject(text: string): unknown {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  for (const candidate of [...blocks.reverse(), text.trim()]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

// ─── Claude Code over SSH (defined, not usable) ───────────────────────────────

export const sshRunner: AgentRunner = {
  id: 'claude-ssh',
  label: 'Claude Code on another machine (SSH)',
  // What it would have to keep to be offered: the same as local Claude Code, proven on a real machine.
  caps: { guardHook: true, structuredOutput: true, osSandbox: 'shell', budgetStop: true, roles: [] },
  processMarker: 'ssh',
  available: () => ({ ok: false, why: 'running agents on another machine is not built yet: there is no machine to prove the guard and the sandbox on' }),
  prepare() { throw new RunnerConfigError('Claude Code over SSH is not available'); },
  normalize: () => [],
};

export const RUNNERS: Record<RunnerId, AgentRunner> = { claude: claudeRunner, cursor: cursorRunner, 'claude-ssh': sshRunner };

export function runnerFor(id: string | null | undefined): AgentRunner {
  return RUNNERS[(id ?? 'claude') as RunnerId] ?? claudeRunner;
}
