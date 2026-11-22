/** Names, icons, colours and small wording helpers for the simple screens. */

import type { Actor, StopId, TaskGroup } from './storyTypes';

export const ACTORS: Record<Actor, { name: string; icon: string; color: string }> = {
  understander: { name: 'Understander', icon: '🔎', color: '#0ea5e9' },
  planner: { name: 'Planner', icon: '🗺️', color: '#8b5cf6' },
  builder: { name: 'Builder', icon: '🛠️', color: '#f59e0b' },
  checks: { name: 'Automatic checks', icon: '✔️', color: '#64748b' },
  checker: { name: 'Checker', icon: '🧪', color: '#10b981' },
  app_tester: { name: 'App tester', icon: '📡', color: '#14b8a6' },
  page_tester: { name: 'Page tester', icon: '🖥️', color: '#ec4899' },
  releaser: { name: 'Releaser', icon: '🚀', color: '#6366f1' },
  fryday: { name: 'FryDay', icon: '⚡', color: '#4f46e5' },
  you: { name: 'You', icon: '🙋', color: '#4f46e5' },
};

export const STOPS: Array<{ id: StopId; name: string; icon: string }> = [
  { id: 'understand', name: 'Understand', icon: '🔎' },
  { id: 'plan', name: 'Plan', icon: '🗺️' },
  { id: 'build', name: 'Build', icon: '🛠️' },
  { id: 'check', name: 'Check', icon: '🧪' },
  { id: 'approve', name: 'Your OK', icon: '🙋' },
  { id: 'live', name: 'Live', icon: '🚀' },
];

export const GROUP_TITLE: Record<TaskGroup, string> = { needs_you: 'Needs you', working: 'Agents working', done: 'Done this week' };

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export const fixedTimes = (n: number) => (n === 1 ? 'fixed once' : n === 2 ? 'fixed twice' : `fixed ${n} times`);

/** An API error as one readable sentence. */
export function readError(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  try { return (JSON.parse(text) as { error?: string }).error ?? text; } catch { return text; }
}
