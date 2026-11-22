/**
 * Agent roles — what each one is for. What each may do lives in guard/policy.ts.
 */

import type { AgentRole } from '../guard/policy.js';

export type { AgentRole };

export const ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  fryday: 'Concierge — talks to the owner and coordinates tasks',
  analyst: 'Read-only analyst — understands the task and its documents, finds the project and any existing branch, asks what is unclear',
  planner: 'Read-only planner — identifies repos and branches, writes HLD and acceptance criteria',
  coder: 'Implements the task in an isolated worktree; no push or deploy capability',
  tester: 'Reviews coder output against the plan and repo conventions; runs checks',
  api_tester: 'Exercises the running service through its HTTP API and checks data read-only',
  ui_tester: 'Opens the running service in a browser and checks what a person would see and do',
  system: 'Internal one-shot runs started by core itself',
};
