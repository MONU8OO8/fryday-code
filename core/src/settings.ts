/**
 * Settings the developer can change while FryDay Code is running: which model each
 * agent uses, how hard it thinks, how many tokens it may use and how long it may run.
 *
 * Stored in the database; anything not stored uses the default below. The point of
 * per-agent settings is usage: a planner or reviewer deserves a strong model, a chat
 * reply does not, and the strongest model is something you opt into per agent.
 * Limits are in tokens (input + output + cache writes, see countedTokens in
 * runner/usage.ts), never in money.
 */

import { z } from 'zod';
import { getDb, nowMs } from './db/db.js';
import type { AgentRole } from './guard/policy.js';

export const MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const ROLES = ['fryday', 'analyst', 'planner', 'coder', 'tester', 'api_tester', 'ui_tester', 'reflector', 'system'] as const satisfies readonly AgentRole[];

export const ENGINES = ['claude', 'cursor'] as const;
/** Roles the Cursor CLI may run: read-only ones, because it has no guard on each tool call. */
export const CURSOR_ROLES: readonly string[] = ['analyst', 'planner'];

/** Sane ceilings, so a typo cannot allow an unbounded run or task. */
export const MAX_RUN_TOKENS = 50_000_000;
export const MAX_TASK_TOKENS = 500_000_000;

/** Keys of earlier versions, when limits were in dollars. A stored value with them still loads; they are dropped. */
const LEGACY_ROLE_KEYS = ['budgetUsd'] as const;
const LEGACY_KEYS = ['taskBudgetUsd'] as const;

const RoleSettings = z.object({
  /** Which program runs the agent. Cursor only for read-only roles (checked below). */
  engine: z.enum(ENGINES).default('claude'),
  /** The model when Cursor runs it (Cursor's own model names). */
  cursorModel: z.string().regex(/^[a-z0-9][a-z0-9.\-]{0,60}$/, 'is not a Cursor model name').default('auto'),
  model: z.enum(MODELS),
  effort: z.enum(EFFORTS),
  /** Most tokens one run of this agent may use (input + output + cache writes). */
  tokenLimit: z.number().int().positive().max(MAX_RUN_TOKENS),
  /** Longest one run may take before it is stopped. */
  timeoutMinutes: z.number().int().positive().max(24 * 60),
}).strict();
export type RoleSettings = z.infer<typeof RoleSettings>;

const SettingsSchema = z.object({
  roles: z.object({
    fryday: RoleSettings,
    analyst: RoleSettings,
    planner: RoleSettings,
    coder: RoleSettings,
    tester: RoleSettings,
    api_tester: RoleSettings,
    ui_tester: RoleSettings,
    reflector: RoleSettings,
    system: RoleSettings,
  }).strict(),
  /** From this coder round on, use a stronger model: the cheap one has had its chances. */
  coderEscalation: z.object({ fromRound: z.number().int().min(2).max(20), model: z.enum(MODELS) }).strict().nullable(),
  /** Most tokens one task may use across all its agents before FryDay asks whether to go on. */
  taskTokenLimit: z.number().int().positive().max(MAX_TASK_TOKENS),
  /** Coder rounds before a task is handed back to the owner. */
  maxRounds: z.number().int().min(1).max(20),
  /**
   * How many times the owner is asked on the way to staging. once: the yes to the merge also
   * starts the staging deploy and answers the pipeline's own staging prompt (the ticket says so).
   * each_step: the merge, the deploy and every pipeline prompt are asked one by one.
   * Production is outside both: FryDay never deploys it and never answers a prompt about it.
   */
  stagingApprovals: z.enum(['once', 'each_step']),
  /**
   * Search code by meaning as well as by keyword. Uses a small embedding model that runs inside
   * FryDay (downloaded once into the state folder); no code leaves the machine. Off: keyword only.
   */
  semanticSearch: z.boolean(),
  /**
   * The Checker's model for a later round that only re-checks earlier findings. A cheaper model
   * is enough to confirm a fix; the first round, and any round with new work, keep the Checker's own.
   */
  recheckModel: z.enum(MODELS).nullable(),
  /**
   * Bugs the agents find that the task at hand did not cause: core files them as bug cards
   * (bugs.ts). autoStart: the scheduler picks them up like any auto-start task, within the agent
   * slots and the machine's limits; pushes and deploys still wait for the owner. dailyCap: at most
   * this many filed in 24 hours.
   */
  autoBugs: z.object({ enabled: z.boolean(), autoStart: z.boolean(), dailyCap: z.number().int().min(1).max(50) }).strict(),
  /** Agents running at the same time. */
  maxAgents: z.number().int().min(1).max(16),
  /** How the owner is nudged besides the Chat space: a macOS notification. The in-app toast is always on. */
  alerts: z.object({ mac: z.boolean() }).strict(),
  /** Hosts a dependency install may reach from its sandbox. */
  installDomains: z.array(z.string().regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'must be a host name such as registry.npmjs.org')).max(20),
}).strict().superRefine((s, ctx) => {
  for (const [role, rs] of Object.entries(s.roles)) {
    if (rs.engine === 'cursor' && !CURSOR_ROLES.includes(role)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['roles', role, 'engine'], message: 'the Cursor CLI is only for the Analyst and the Planner: it has no guard on each tool call' });
    }
  }
});
export type Settings = z.infer<typeof SettingsSchema>;

const envInt = (key: string, fallback: number): number => {
  const n = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function defaultSettings(): Settings {
  return {
    roles: {
      fryday:  { engine: 'claude', cursorModel: 'auto', model: 'claude-haiku-5-5',  effort: 'low',    tokenLimit: 100_000,   timeoutMinutes: 5 },
      analyst: { engine: 'claude', cursorModel: 'auto', model: 'claude-sonnet-5-5', effort: 'medium', tokenLimit: 400_000,   timeoutMinutes: 10 },
      planner: { engine: 'claude', cursorModel: 'auto', model: 'claude-opus-5-5',   effort: 'high',   tokenLimit: 400_000,   timeoutMinutes: 15 },
      coder:   { engine: 'claude', cursorModel: 'auto', model: 'claude-sonnet-5-5', effort: 'medium', tokenLimit: 1_500_000, timeoutMinutes: 45 },
      tester:  { engine: 'claude', cursorModel: 'auto', model: 'claude-opus-5-5',   effort: 'medium', tokenLimit: 600_000,   timeoutMinutes: 20 },
      // Trying things out is many small steps, not deep thought: the mid model does it well.
      api_tester: { engine: 'claude', cursorModel: 'auto', model: 'claude-sonnet-5-5', effort: 'medium', tokenLimit: 600_000, timeoutMinutes: 20 },
      ui_tester:  { engine: 'claude', cursorModel: 'auto', model: 'claude-sonnet-5-5', effort: 'medium', tokenLimit: 800_000, timeoutMinutes: 20 },
      // One structured answer from a text record: no tools, no exploring.
      reflector: { engine: 'claude', cursorModel: 'auto', model: 'claude-sonnet-5-5', effort: 'low', tokenLimit: 150_000, timeoutMinutes: 5 },
      system:  { engine: 'claude', cursorModel: 'auto', model: 'claude-haiku-5-5',  effort: 'low',    tokenLimit: 100_000,   timeoutMinutes: 5 },
    },
    coderEscalation: { fromRound: 3, model: 'claude-opus-5-5' },
    taskTokenLimit: 4_000_000,
    maxRounds: envInt('FRYDAY_MAX_ROUNDS', 3),
    stagingApprovals: process.env['FRYDAY_STAGING_APPROVALS'] === 'each_step' ? 'each_step' : 'once',
    semanticSearch: process.env['FRYDAY_EMBED'] !== 'off',
    recheckModel: 'claude-sonnet-5-5',
    autoBugs: { enabled: true, autoStart: true, dailyCap: 5 },
    maxAgents: envInt('FRYDAY_MAX_AGENTS', 2),
    installDomains: ['registry.npmjs.org', 'registry.yarnpkg.com'],
    alerts: { mac: true },
  };
}

export class SettingsError extends Error {}

/** Stored settings merged over the defaults. A stored value that no longer validates is ignored. */
export function getSettings(): Settings {
  const defaults = defaultSettings();
  let stored: unknown = null;
  try {
    const row = getDb().prepare(`SELECT value_json FROM settings WHERE key = 'settings'`).get() as { value_json: string } | undefined;
    stored = row ? JSON.parse(row.value_json) : null;
  } catch {
    stored = null; // database not open yet, or unreadable: defaults
  }
  if (!stored || typeof stored !== 'object') return defaults;
  const s = withoutLegacyKeys(stored as Record<string, unknown>) as Partial<Settings>;
  const merged = {
    ...defaults,
    ...s,
    roles: Object.fromEntries(ROLES.map((r) => [r, { ...defaults.roles[r], ...(s.roles?.[r] ?? {}) }])),
  };
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaults;
}

/**
 * A stored value from a version that set limits in dollars: those keys are dropped, so the
 * token defaults apply and everything else stored is kept.
 */
function withoutLegacyKeys(stored: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...stored };
  for (const key of LEGACY_KEYS) delete out[key];
  const roles = out['roles'];
  if (roles && typeof roles === 'object') {
    out['roles'] = Object.fromEntries(Object.entries(roles as Record<string, unknown>).map(([role, rs]) => {
      if (!rs || typeof rs !== 'object') return [role, rs];
      const copy: Record<string, unknown> = { ...(rs as Record<string, unknown>) };
      for (const key of LEGACY_ROLE_KEYS) delete copy[key];
      return [role, copy];
    }));
  }
  return out;
}

/** Change some settings. The whole result must be valid or nothing is stored. */
export function updateSettings(change: unknown): Settings {
  if (!change || typeof change !== 'object') throw new SettingsError('Settings must be an object');
  const current = getSettings();
  const c = change as Partial<Settings>;
  const merged = {
    ...current,
    ...c,
    roles: Object.fromEntries(ROLES.map((r) => [r, { ...current.roles[r], ...(c.roles?.[r] ?? {}) }])),
  };
  const parsed = SettingsSchema.safeParse(merged);
  if (!parsed.success) {
    throw new SettingsError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  getDb().prepare(`
    INSERT INTO settings (key, value_json, updated_at) VALUES ('settings', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(parsed.data), nowMs());
  return parsed.data;
}

export interface RunSettings {
  engine: 'claude' | 'cursor';
  cursorModel: string;
  model: string;
  effort: string;
  tokenLimit: number;
  timeoutMs: number;
}

/**
 * What one run of `role` gets. FRYDAY_MODEL, when set, forces one model for every
 * agent (the test scripts use it to stay cheap).
 */
export function runSettingsFor(role: AgentRole, round = 0, settings: Settings = getSettings()): RunSettings {
  const rs = settings.roles[role];
  const escalated = role === 'coder' && settings.coderEscalation && round >= settings.coderEscalation.fromRound;
  const model = process.env.FRYDAY_MODEL || (escalated ? settings.coderEscalation!.model : rs.model);
  return { engine: rs.engine ?? 'claude', cursorModel: rs.cursorModel ?? 'auto', model, effort: rs.effort, tokenLimit: rs.tokenLimit, timeoutMs: rs.timeoutMinutes * 60_000 };
}
