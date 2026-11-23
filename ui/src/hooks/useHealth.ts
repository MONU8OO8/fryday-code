/**
 * The machine and the scheduler (GET /api/system/health, then the `health` and `scheduler`
 * events), shared by the header strip and the Health page.
 */

import { useEffect, useState } from 'react';
import { transport } from '@transport';
import { useSse } from './useSse';

export interface AgentUsage { runId: string; taskId: string | null; role: string; cpuPct: number; rssBytes: number; processes: number }

export interface HealthSample {
  at: number;
  cpu: { pct: number; cores: number; load1: number; load5: number; load15: number };
  memory: { totalBytes: number; usedBytes: number; pct: number; pressure: number | null };
  disk: { totalBytes: number; freeBytes: number; pct: number } | null;
  agents: AgentUsage[];
  agentsKnown: boolean;
  core: { rssBytes: number };
}

export interface SchedulerStatus {
  running: boolean;
  slots: { used: number; max: number };
  paused: string | null;
  waiting: Array<{ id: string; why: string }>;
  lastTickAt: number | null;
}

export interface Health {
  latest: HealthSample | null;
  history: HealthSample[];
  admission: { ok: boolean; why?: string };
  scheduler: SchedulerStatus | null;
}

const KEEP = 180;
let current: Health | null = null;
const listeners = new Set<(h: Health | null) => void>();
let asked = false;

function publish(next: Health | null) {
  current = next;
  for (const l of listeners) l(next);
}

function ask() {
  if (asked) return;
  asked = true;
  transport.request('GET', '/system/health')
    .then((h: Partial<Health>) => {
      // The public demo has no machine to read.
      if (!h || !('latest' in h)) { asked = false; return; }
      publish({ latest: h.latest ?? null, history: h.history ?? [], admission: h.admission ?? { ok: true }, scheduler: h.scheduler ?? null });
    })
    .catch(() => { asked = false; });
}

/** Null until known (and in the public demo, which has no machine). */
export function useHealth(): Health | null {
  const [health, setHealth] = useState<Health | null>(current);
  useEffect(() => {
    listeners.add(setHealth);
    ask();
    return () => { listeners.delete(setHealth); };
  }, []);
  useSse('/api/events', (ev) => {
    if (ev['type'] === 'health' && ev['sample']) {
      const sample = ev['sample'] as HealthSample;
      const base = current ?? { latest: null, history: [], admission: { ok: true }, scheduler: null };
      // One subscriber is enough to keep the shared copy up to date.
      if (base.latest?.at === sample.at) return;
      publish({ ...base, latest: sample, history: [...base.history, sample].slice(-KEEP), admission: (ev['admission'] as Health['admission']) ?? base.admission });
    } else if (ev['type'] === 'scheduler' && ev['status'] && current) {
      publish({ ...current, scheduler: ev['status'] as SchedulerStatus });
    }
  });
  return health;
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export const PRESSURE: Record<number, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  1: { label: 'Normal', tone: 'ok' },
  2: { label: 'Warning', tone: 'warn' },
  4: { label: 'Critical', tone: 'bad' },
};
