/**
 * Toasts for what needs the owner: a question, a decision, a task that stopped or
 * finished. The same nudges as the Mac notification and the Chat space; click one to
 * open the task.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HelpCircle, ShieldQuestion, AlertTriangle, XCircle, CheckCircle, X } from 'lucide-react';
import clsx from 'clsx';
import { useSse } from '../hooks/useSse';

interface Toast { id: number; taskId: string; title: string; text: string; kind: string; at: number }

const KIND: Record<string, { icon: typeof HelpCircle; cls: string; label: string }> = {
  question: { icon: HelpCircle, cls: 'border-hud-amber/60 text-hud-amber', label: 'A question for you' },
  decision: { icon: ShieldQuestion, cls: 'border-hud-amber/60 text-hud-amber', label: 'Needs your decision' },
  stopped: { icon: AlertTriangle, cls: 'border-hud-amber/50 text-hud-amber', label: 'Back with you' },
  failed: { icon: XCircle, cls: 'border-hud-red/60 text-hud-red', label: 'Failed' },
  done: { icon: CheckCircle, cls: 'border-hud-green/60 text-hud-green', label: 'Done' },
};
const LIFETIME_MS = 12_000;
let nextId = 1;

export default function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const navigate = useNavigate();

  useSse('/api/events', (ev) => {
    if (ev['type'] !== 'owner_alert') return;
    const toast: Toast = { id: nextId++, taskId: String(ev['taskId'] ?? ''), title: String(ev['title'] ?? ''), text: String(ev['text'] ?? ''), kind: String(ev['kind'] ?? 'stopped'), at: Date.now() };
    // One toast per task: a newer nudge replaces the older one.
    setToasts((prev) => [...prev.filter((t) => t.taskId !== toast.taskId), toast].slice(-4));
  });

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setInterval(() => setToasts((prev) => prev.filter((t) => Date.now() - t.at < LIFETIME_MS)), 1000);
    return () => clearInterval(timer);
  }, [toasts.length]);

  const close = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));
  if (toasts.length === 0) return null;
  return (
    <div className="fixed top-3 right-3 z-50 w-80 space-y-2" role="status" aria-live="polite">
      {toasts.map((t) => {
        const k = KIND[t.kind] ?? KIND['stopped']!;
        const Icon = k.icon;
        return (
          <div key={t.id} className={clsx('flow-in bg-hud-surface/95 backdrop-blur border rounded-lg p-2.5 shadow-lg cursor-pointer', k.cls)}
            onClick={() => { if (t.taskId) navigate(`/home/${t.taskId}`); close(t.id); }}>
            <div className="flex items-start gap-2">
              <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold">{k.label}</div>
                <div className="text-sm text-hud-bright truncate">{t.title.replace(/^T-\d+\s*·\s*/, '')}</div>
              </div>
              <button onClick={(e) => { e.stopPropagation(); close(t.id); }} aria-label="Dismiss" className="text-hud-dim hover:text-hud-bright"><X className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
