/** The header's view of the machine: CPU, memory, agents at work and free slots. Opens the Health page. */

import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Cpu, MemoryStick, Bot } from 'lucide-react';
import { useHealth } from '../hooks/useHealth';

const tone = (pct: number) => (pct >= 90 ? 'text-hud-red' : pct >= 75 ? 'text-hud-amber' : 'text-hud-dim');

export default function HealthStrip() {
  const health = useHealth();
  const s = health?.latest;
  if (!s) return null;
  const slots = health.scheduler?.slots;
  const held = !health.admission.ok;
  return (
    <Link to="/health" aria-label={`Machine health: CPU ${Math.round(s.cpu.pct)}%, memory ${Math.round(s.memory.pct)}%${held ? `, new work held back: ${health.admission.why}` : ''}`}
      title={held ? `New work is held back: ${health.admission.why}` : 'Machine health'}
      className={clsx('hidden lg:flex items-center gap-3 rounded-full border px-3 py-1 text-xs tabular-nums transition-colors hover:bg-hud-border/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60',
        held ? 'border-hud-amber/50 bg-hud-amber/10' : 'border-hud-border')}>
      <span className={clsx('inline-flex items-center gap-1', tone(s.cpu.pct))}><Cpu aria-hidden className="w-3.5 h-3.5" />{Math.round(s.cpu.pct)}%</span>
      <span className={clsx('inline-flex items-center gap-1', tone(s.memory.pct), s.memory.pressure === 4 && 'text-hud-red')}>
        <MemoryStick aria-hidden className="w-3.5 h-3.5" />{Math.round(s.memory.pct)}%
      </span>
      <span className="inline-flex items-center gap-1 text-hud-dim">
        <Bot aria-hidden className="w-3.5 h-3.5" />{s.agentsKnown ? s.agents.length : '?'}{slots ? ` · ${slots.used}/${slots.max} slots` : ''}
      </span>
    </Link>
  );
}
