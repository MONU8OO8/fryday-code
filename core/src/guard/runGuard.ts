/**
 * Per-run confinement for an agent that works in a task workspace.
 *
 * Three layers, each verified against the real CLI (see core/scripts/redteam.ts):
 *   1. PreToolUse hook (guard/hook.mjs) on every tool call, failing closed.
 *   2. Claude Code's own file-tool limits: no reads or writes outside the workspace.
 *   3. OS sandbox around Bash: writes only inside the workspace, the home folder
 *      unreadable apart from the workspace and the Node install, and no network at
 *      all (including localhost, so an agent cannot reach core's API).
 *
 * The policy and settings files live in the runs directory, which the agent can
 * neither read nor write.
 */

import fs from 'fs';
import path from 'path';
import { ROLE_POLICIES, type AgentRole } from './policy.js';
import { nestedSandbox } from '../platform.js';

export interface RunGuardOptions {
  runId: string;
  role: AgentRole;
  /** The only directory the agent may work in. */
  workspacePath: string;
  /** Where the policy and settings files are written. */
  runsDir: string;
  /** The run answers through the StructuredOutput tool (a JSON schema was given). */
  structuredOutput?: boolean;
  /** MCP tools this run may call, by full name (mcp__server__tool), each with its argument check. */
  mcpTools?: Record<string, McpRule>;
}

export interface McpRule {
  /** none: any arguments. sql / mongo: reading only. url: only this origin. no-file: no file name of the agent's choosing. */
  check: 'none' | 'sql' | 'mongo' | 'url' | 'no-file';
  origin?: string;
}

export interface GuardPolicyFile {
  role: AgentRole;
  allowedTools: string[];
  readRoots: string[];
  writeRoots: string[];
  mcp: Record<string, McpRule>;
}

const HOOK_PATH = path.join(__dirname, 'hook.mjs');
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
/** How the CLI delivers an answer that must match a JSON schema. It touches nothing. */
const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
/** Roles whose shell may not write even inside their own workspace. */
const READ_ONLY_SHELL = new Set<AgentRole>(['api_tester']);

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The Node installation the agent's commands need to read (it is often under the home folder). */
function nodeInstallDir(): string {
  return path.dirname(path.dirname(fs.realpathSync(process.execPath)));
}

const MCP_TOOL_NAME = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/;

/** The MCP tools a run really gets: none unless its role may have them, and only well-formed names. */
function mcpToolsFor(opts: RunGuardOptions): Record<string, McpRule> {
  const tools = opts.mcpTools ?? {};
  const names = Object.keys(tools);
  if (names.length === 0) return {};
  if (!ROLE_POLICIES[opts.role].mayUseMcp) throw new Error(`A ${opts.role} agent may not be given MCP tools`);
  for (const name of names) if (!MCP_TOOL_NAME.test(name)) throw new Error(`"${name}" is not an MCP tool name`);
  return tools;
}

export function buildPolicy(opts: RunGuardOptions): GuardPolicyFile {
  const policy = ROLE_POLICIES[opts.role];
  const mayWrite = policy.allowedTools.some((t) => WRITE_TOOLS.includes(t));
  return {
    role: opts.role,
    allowedTools: opts.structuredOutput ? [...policy.allowedTools, STRUCTURED_OUTPUT_TOOL] : policy.allowedTools,
    readRoots: [opts.workspacePath],
    writeRoots: mayWrite ? [opts.workspacePath] : [],
    mcp: mcpToolsFor(opts),
  };
}

export function buildSettings(opts: RunGuardOptions, policyPath: string): Record<string, unknown> {
  const policy = ROLE_POLICIES[opts.role];
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `${shellQuote(process.execPath)} ${shellQuote(HOOK_PATH)} ${shellQuote(policyPath)}`,
              timeout: 10,
              // Without this a hook that crashes or times out lets the call through.
              onFailure: 'block',
            },
          ],
        },
      ],
    },
    permissions: {
      // Read-only tools need no prompt; the hook and the two limits below bound them.
      // An MCP tool is listed by its full name: one that is not listed cannot be called.
      allow: [...policy.allowedTools.filter((t) => READ_ONLY_TOOLS.includes(t)), ...Object.keys(mcpToolsFor(opts))],
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true,
      // Bash runs without a prompt because it is sandboxed; nothing may run outside it.
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: {
        denyRead: ['~/'],
        allowRead: [opts.workspacePath, nodeInstallDir()],
        // A tester works in the checkout the service under test runs from. Its shell may
        // look, but not change a file there: it must not be able to alter what it tests.
        ...(READ_ONLY_SHELL.has(opts.role) ? { denyWrite: [opts.workspacePath] } : {}),
      },
      network: { allowedDomains: [] },
      // Docker only (FRYDAY_IN_DOCKER=1): Claude Code's sandbox in its nested mode, see platform.ts.
      ...nestedSandbox(),
    },
  };
}

/** Write the policy and settings for a run. Returns the path to pass as `--settings`. */
export function writeRunGuard(opts: RunGuardOptions): { settingsPath: string; policyPath: string } {
  fs.mkdirSync(opts.runsDir, { recursive: true });
  const policyPath = path.join(opts.runsDir, `${opts.runId}.policy.json`);
  const settingsPath = path.join(opts.runsDir, `${opts.runId}.settings.json`);
  fs.writeFileSync(policyPath, JSON.stringify(buildPolicy(opts), null, 2), { mode: 0o600 });
  fs.writeFileSync(settingsPath, JSON.stringify(buildSettings(opts, policyPath), null, 2), { mode: 0o600 });
  return { settingsPath, policyPath };
}
