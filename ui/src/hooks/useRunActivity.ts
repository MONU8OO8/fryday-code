/**
 * What an agent run did: loaded once from its log, then kept current from the live
 * event stream while it runs.
 */

import { useEffect, useState } from 'react';
import { useSse, useCoreApi } from './useSse';

export interface Step {
  text: string;
  tools: string[];
  toolInputs: string[];
  /** When it arrived here (live steps only). */
  at?: number;
}

const MAX_STEPS = 60;

export function useRunActivity(runId: string | null, live: boolean): Step[] {
  const [steps, setSteps] = useState<Step[]>([]);
  const api = useCoreApi();

  useEffect(() => {
    setSteps([]);
    if (!runId) return;
    let cancelled = false;
    api.get(`/agents/${runId}/activity?max=${MAX_STEPS}`)
      .then((d) => { if (!cancelled) setSteps((d.activity ?? []).map((a: Step) => ({ text: a.text ?? '', tools: a.tools ?? [], toolInputs: a.toolInputs ?? [] }))); })
      .catch(() => { /* the live stream still fills it */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useSse('/api/events', (ev) => {
    if (!live || !runId || ev['type'] !== 'run_event' || ev['runId'] !== runId || ev['kind'] !== 'assistant') return;
    const step: Step = { text: String(ev['text'] ?? ''), tools: (ev['tools'] as string[]) ?? [], toolInputs: (ev['toolInputs'] as string[]) ?? [], at: Date.now() };
    setSteps((prev) => [...prev, step].slice(-MAX_STEPS));
  }, [runId, live]);

  return steps;
}

/** "mcp__fryday_browser__browser_click" → "browser click", "mcp__app-db__query" → "app-db · query" */
export function toolLabel(name: string): string {
  const m = name.match(/^mcp__([^_]+(?:[-_][^_]+)*?)__(.+)$/);
  if (!m) return name;
  const [, server, tool] = m;
  if (server === 'fryday_browser') return tool!.replace(/^browser_/, '').replace(/_/g, ' ');
  if (server === 'fryday_service') return tool === 'request' ? 'request' : 'service log';
  return `${server} · ${tool}`;
}
