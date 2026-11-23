/**
 * Health: how the machine is doing, what each running agent uses, and why the scheduler is
 * or is not starting more work. Read-only; everything comes from core's own sampler.
 */

import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Activity, Cpu, HardDrive, MemoryStick } from 'lucide-react';
import { fmtBytes, PRESSURE, useHealth } from '../hooks/useHealth';
import Sparkline from '../components/Sparkline';
import { ago } from '../plain';
import { Badge, EmptyState, PageHeader, cardClass } from '../ui';
import type { ReactNode } from 'react';

const ROLE_NAME: Record<string, string> = {
  analyst: 'Understander', planner: 'Planner', coder: 'Builder', tester: 'Checker', api_tester: 'App tester', ui_tester: 'Page tester', reflector: 'Reflector', fryday: 'FryDay', system: 'FryDay',
};

type Level = 'none' | 'ok' | 'warn' | 'bad';

/** A disk is judged by what is left, not by the share used: 90% of a large disk can be plenty. */
const diskLevel = (freeBytes: number): Level => (freeBytes < 5 * 1024 ** 3 ? 'bad' : freeBytes < 15 * 1024 ** 3 ? 'warn' : 'ok');

function Gauge({ icon, title, pct, level: given, detail, children }: { icon: ReactNode; title: string; pct: number | null; level?: Level; detail: ReactNode; children?: ReactNode }) {
  const level: Level = given ?? (pct === null ? 'none' : pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'ok');
  const tone = { none: 'text-hud-dim', bad: 'text-hud-red', warn: 'text-hud-amber', ok: 'text-hud-green' }[level];
  const bar = { none: 'bg-hud-dim', bad: 'bg-hud-red', warn: 'bg-hud-amber', ok: 'bg-hud-green' }[level];
  return (
    <section className={cardClass('md')} aria-label={title}>
      <div className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</div>
      <div className={clsx('mt-2 text-3xl font-semibold tabular-nums', tone)}>{pct === null ? '—' : `${Math.round(pct)}%`}</div>
      <div className="mt-1 text-xs text-hud-dim">{detail}</div>
      {pct !== null && (
        <div className="mt-3 h-1.5 rounded-full bg-hud-border/60 overflow-hidden" aria-hidden>
          <div className={clsx('h-full rounded-full', bar)} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
      {children && <div className="mt-3">{children}</div>}
    </section>
  );
}

export default function HealthView() {
  const health = useHealth();
  if (!health?.latest) {
    return (
      <div className="p-4 md:p-6 max-w-6xl mx-auto">
        <PageHeader title="Health" subtitle="How this computer is doing while the agents work." />
        <div className={clsx(cardClass('none'), 'mt-5')}>
          <EmptyState icon={<Activity className="w-5 h-5" />} title="No readings yet" text="FryDay Code reads the machine every few seconds once it is running on this computer." />
        </div>
      </div>
    );
  }
  const s = health.latest;
  const { history, admission, scheduler } = health;
  const pressure = s.memory.pressure !== null ? PRESSURE[s.memory.pressure] : undefined;
  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-5">
      <PageHeader title="Health" subtitle={`How this computer is doing while the agents work · read ${ago(s.at)}`}
        actions={admission.ok ? <Badge tone="ok" dot>Room for more work</Badge> : <Badge tone="warn" dot>New work held back: {admission.why}</Badge>} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Gauge icon={<Cpu aria-hidden className="w-4 h-4 text-hud-dim" />} title="CPU" pct={s.cpu.pct}
          detail={<>{s.cpu.cores} cores · load {s.cpu.load1.toFixed(1)} / {s.cpu.load5.toFixed(1)} / {s.cpu.load15.toFixed(1)}</>}>
          <Sparkline values={history.map((h) => h.cpu.pct)} label="CPU over the last 15 minutes" />
        </Gauge>
        <Gauge icon={<MemoryStick aria-hidden className="w-4 h-4 text-hud-dim" />} title="Memory" pct={s.memory.pct}
          detail={<>{fmtBytes(s.memory.usedBytes)} of {fmtBytes(s.memory.totalBytes)}{pressure && <> · pressure <Badge tone={pressure.tone}>{pressure.label}</Badge></>}</>}>
          <Sparkline values={history.map((h) => h.memory.pct)} label="Memory over the last 15 minutes" className="text-hud-amber" />
        </Gauge>
        <Gauge icon={<HardDrive aria-hidden className="w-4 h-4 text-hud-dim" />} title="Disk" pct={s.disk?.pct ?? null} level={s.disk ? diskLevel(s.disk.freeBytes) : 'none'}
          detail={s.disk ? <>{fmtBytes(s.disk.freeBytes)} free of {fmtBytes(s.disk.totalBytes)}</> : 'Could not be read'} />
      </div>

      <section className={cardClass('md')} aria-labelledby="agents-now">
        <h2 id="agents-now" className="text-sm font-semibold">Agents running now</h2>
        {!s.agentsKnown ? (
          <p className="mt-2 text-sm text-hud-amber">The process list could not be read, so what the agents use is unknown.</p>
        ) : s.agents.length === 0 ? (
          <p className="mt-2 text-sm text-hud-dim">None. FryDay Code itself uses {fmtBytes(s.core.rssBytes)}.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-xs text-hud-dim text-left">
              <tr><th className="font-medium py-1">Agent</th><th className="font-medium">Task</th><th className="font-medium text-right">CPU</th><th className="font-medium text-right">Memory</th><th className="font-medium text-right">Processes</th></tr>
            </thead>
            <tbody>
              {s.agents.map((a) => (
                <tr key={a.runId} className="border-t border-hud-border">
                  <td className="py-1.5">{ROLE_NAME[a.role] ?? a.role}</td>
                  <td>{a.taskId ? <Link to={`/home/${a.taskId}`} className="text-hud-cyan">{a.taskId}</Link> : '—'}</td>
                  <td className="text-right tabular-nums">{a.cpuPct.toFixed(1)}%</td>
                  <td className="text-right tabular-nums">{fmtBytes(a.rssBytes)}</td>
                  <td className="text-right tabular-nums">{a.processes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {scheduler && (
        <section className={cardClass('md')} aria-labelledby="scheduler">
          <h2 id="scheduler" className="text-sm font-semibold">Scheduler</h2>
          <p className="mt-1 text-sm text-hud-dim">
            {scheduler.slots.used} of {scheduler.slots.max} slots working.{' '}
            {scheduler.paused ? <>Not starting more: {scheduler.paused}.</> : 'Starts queued auto-start tasks as soon as they may.'}
          </p>
          {scheduler.waiting.length > 0 && (
            <ul className="mt-3 space-y-1.5 text-sm">
              {scheduler.waiting.map((w) => (
                <li key={w.id} className="flex gap-2"><Link to={`/home/${w.id}`} className="text-hud-cyan font-medium">{w.id}</Link><span className="text-hud-dim">{w.why}</span></li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
