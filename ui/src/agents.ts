/**
 * How each agent (and each step core does itself) looks everywhere in the UI: its name,
 * colour and icon. One place, so the flow, the Agents page and Settings agree.
 */

import { FileSearch, ClipboardList, CodeXml, ListChecks, Eye, ServerCog, Monitor, User, Rocket, MessageCircle, Wrench, GitMerge, Lightbulb, type LucideIcon } from 'lucide-react';

export interface AgentLook {
  name: string;
  /** What it does, in a few words. */
  job: string;
  /** Hex, for SVG and inline styles. */
  color: string;
  icon: LucideIcon;
}

export const AGENT_LOOK: Record<string, AgentLook> = {
  analyst:    { name: 'Understander', job: 'understands the task',           color: '#0ea5e9', icon: FileSearch },
  planner:    { name: 'Planner',      job: 'design and acceptance criteria', color: '#8b5cf6', icon: ClipboardList },
  coder:      { name: 'Builder',      job: 'writes the change',              color: '#d97706', icon: CodeXml },
  checks:     { name: 'Automatic checks', job: "the project's own tests",    color: '#64748b', icon: ListChecks },
  reviewer:   { name: 'Checker',      job: 'reads the change',               color: '#059669', icon: Eye },
  tester:     { name: 'Checker',      job: 'reads the change',               color: '#059669', icon: Eye },
  api_tester: { name: 'App tester',   job: 'uses the running service',       color: '#0d9488', icon: ServerCog },
  ui_tester:  { name: 'Page tester',  job: 'uses the pages in a browser',    color: '#db2777', icon: Monitor },
  owner:      { name: 'You',          job: 'answers and approves',           color: '#4f46e5', icon: User },
  release:    { name: 'Releaser',     job: 'push and merge into staging',    color: '#6366f1', icon: GitMerge },
  deploy:     { name: 'Deploy',       job: 'Jenkins deploys staging',        color: '#65a30d', icon: Rocket },
  fryday:     { name: 'FryDay',       job: 'answers you in chat',            color: '#4f46e5', icon: MessageCircle },
  reflector:  { name: 'Reflector',    job: 'proposes lessons after a task',  color: '#a855f7', icon: Lightbulb },
  system:     { name: 'System',       job: 'small internal runs',            color: '#64748b', icon: Wrench },
};

export const look = (role: string): AgentLook => AGENT_LOOK[role] ?? { name: role, job: '', color: '#64748b', icon: Wrench };

/** 950, 12.3k, 1.2M — the same short form core writes (formatTokens in core/src/pipeline/plainWords.ts). */
export function fmtTokens(n: number): string {
  const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  const short = (x: number, unit: string) => `${x >= 100 ? Math.round(x) : Number(x.toFixed(1))}${unit}`;
  if (v < 1000) return String(v);
  if (v < 999_500) return short(v / 1000, 'k');
  return short(v / 1_000_000, 'M');
}

/** "1.5M", "400k", "250,000" or "250000" → a whole number of tokens; null when it is not one. */
export function parseTokens(text: string): number | null {
  const m = text.trim().replace(/[,_\s]/g, '').match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (m[2] === '' ? 1 : m[2].toLowerCase() === 'k' ? 1000 : 1_000_000));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

interface TokenCounts { inputTokens: number; outputTokens: number; cacheWriteTokens: number }
/**
 * The tokens that count toward a limit: input + output + cache writes. Cache reads are shown
 * apart, as "reused". The same rule as countedTokens in core/src/runner/usage.ts.
 */
export const countedTokens = (u: TokenCounts) => (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheWriteTokens ?? 0);

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "claude-sonnet-5-5" → "Sonnet 5.5" */
export const modelName = (id: string | null | undefined) =>
  id ? id.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^\w/, (c) => c.toUpperCase()) : '';
