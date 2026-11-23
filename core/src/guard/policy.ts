/**
 * Guard policy — default-deny, per role. The single source of what each agent may use.
 *
 * Enforced in two layers:
 *   1. Capability removal: `allowedTools` becomes the agent's `--tools` list and the
 *      supervisor loads no MCP server core did not put in that run's own config, so a
 *      tool that is not here does not exist for that agent.
 *   2. A PreToolUse hook that checks paths, commands and MCP tool arguments on every call.
 */

export type AgentRole = 'fryday' | 'analyst' | 'planner' | 'coder' | 'tester' | 'api_tester' | 'ui_tester' | 'reflector' | 'system';

/** Roles that read only the text core gives them. The guard hook refuses every tool for these, whatever a policy file says. */
export const NO_TOOL_ROLES: readonly AgentRole[] = ['fryday', 'reflector', 'system'];

export interface RolePolicy {
  /** Built-in tools the role gets. Empty means none. */
  allowedTools: string[];
  /**
   * Whether a run of this role may be given tools from MCP servers. Which ones is
   * decided per run by core (the service under test, a browser, granted data
   * connections) and written into that run's guard policy tool by tool.
   */
  mayUseMcp: boolean;
  /** No role acts outward itself: pushes, deploys and messages go through approval tickets. */
  mayActOutward: false;
  /** Whether the role may write outside the task worktree. */
  mayWriteOutsideWorktree: boolean;
  /** Claude Code permission mode. `dontAsk` denies anything not pre-approved. */
  permissionMode: 'dontAsk' | 'acceptEdits';
}

export const ROLE_POLICIES: Record<AgentRole, RolePolicy> = {
  fryday: {
    allowedTools: [],
    mayUseMcp: false,
    mayActOutward: false,
    mayWriteOutsideWorktree: false,
    permissionMode: 'dontAsk',
  },
  analyst: {
    allowedTools: ['Read', 'Grep', 'Glob'],
    mayUseMcp: false,
    mayActOutward: false,
    mayWriteOutsideWorktree: false,
    permissionMode: 'dontAsk',
  },
  planner: {
    allowedTools: ['Read', 'Grep', 'Glob'],
    mayUseMcp: false,
    mayActOutward: false,
    mayWriteOutsideWorktree: false,
    permissionMode: 'dontAsk',
  },
  coder: {
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    mayUseMcp: false,
    mayActOutward: false,
    mayWriteOutsideWorktree: false,
    permissionMode: 'acceptEdits',
  },
  tester: {
    allowedTools: ['Read', 'Bash', 'Grep', 'Glob'],
    mayUseMcp: false,
    mayActOutward: false,
    mayWriteOutsideWorktree: false,
    permissionMode: 'acceptEdits',
  },
  // Exercises the running service. Its shell has no network: the service is reached
  // only through the tool core gives it, and data only through granted read-only tools.
  api_tester: {
    allowedTools: ['Read', 'Bash', 'Grep', 'Glob'],
    mayUseMcp: true,
    mayActOutward: false,
    mayWriteOutsideWorktree: false,
    permissionMode: 'acceptEdits',
  },
  // Looks at the pages in a browser that can open the service under test and nothing else.
  ui_tester: {
    allowedTools: ['Read', 'Grep', 'Glob'],
    mayUseMcp: true,
    mayActOutward: false,
    mayWriteOutsideWorktree: false,
    permissionMode: 'dontAsk',
  },
  // Reads a finished task's record (text from core) and proposes lessons for the owner to approve.
  reflector: {
    allowedTools: [],
    mayUseMcp: false,
    mayActOutward: false,
    mayWriteOutsideWorktree: false,
    permissionMode: 'dontAsk',
  },
  system: {
    allowedTools: [],
    mayUseMcp: false,
    mayActOutward: false,
    mayWriteOutsideWorktree: false,
    permissionMode: 'dontAsk',
  },
};

export function isToolAllowed(role: AgentRole, toolName: string): boolean {
  return ROLE_POLICIES[role]?.allowedTools.includes(toolName) ?? false;
}

/** CLI flags that apply a role's policy to a `claude` process. */
export function policyCliFlags(role: AgentRole): string[] {
  const policy = ROLE_POLICIES[role];
  return ['--permission-mode', policy.permissionMode, '--tools', policy.allowedTools.join(',')];
}
