/**
 * The public demo's banner (demo builds only): says plainly that this is a replay with stand-in
 * agents, links to the landing page and the source, offers "Replay", and shows the demo's short
 * notices ("settings are not saved"). It talks to the replay only through the transport, like
 * every other screen.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import { transport } from '@transport';
import { useSse } from '../hooks/useSse';
import { Badge, Button } from '../ui';

/** The project's home on GitHub; the owner fills in OWNER when the repository is published. */
export const GITHUB_URL = 'https://github.com/OWNER/fryday-code';
const NOTICE_MS = 4500;

type Phase = 'idle' | 'playing' | 'paused' | 'done';

export default function DemoBanner() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<{ text: string; at: number } | null>(null);

  useEffect(() => { transport.request('GET', '/demo/state').then((s: { phase: Phase }) => setPhase(s.phase)).catch(() => {}); }, []);
  useSse('/api/events', (ev) => {
    if (ev['type'] === 'demo_state') setPhase(ev['phase'] as Phase);
    if (ev['type'] === 'demo_notice') setNotice({ text: String(ev['text'] ?? ''), at: Date.now() });
  });
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);

  const replay = async () => {
    const { id } = (await transport.request('POST', '/demo/replay', {})) as { id: string };
    navigate(`/home/${id}`);
  };

  return (
    <>
      <div role="note" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-1.5 text-xs text-hud-dim bg-hud-cyan/[0.07] border-b border-hud-cyan/20 flex-shrink-0">
        <Badge tone="accent">Live demo</Badge>
        <span>Stand-in agents replay a recorded task. Install FryDay Code to run real agents on your code.</span>
        <span className="flex items-center gap-3">
          <a href={import.meta.env.BASE_URL} className="font-semibold text-hud-cyan hover:underline">About FryDay Code</a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="font-semibold text-hud-cyan hover:underline">GitHub</a>
          {phase !== 'idle' && (
            <Button variant="ghost" size="sm" onClick={() => void replay()} icon={<RotateCcw aria-hidden className="w-3.5 h-3.5" />}>Replay</Button>
          )}
        </span>
      </div>
      {notice && (
        <div role="status" aria-live="polite" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 max-w-[90vw] rounded-xl border border-hud-border bg-hud-surface px-4 py-2.5 text-sm text-hud-bright shadow-lg flow-in">
          {notice.text}
        </div>
      )}
    </>
  );
}
