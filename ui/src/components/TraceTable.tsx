/**
 * A task's traceability table: each acceptance criterion of the plan, the tests the plan named
 * for it, what the Checker found and what each tester found, from the latest reviewed round.
 * `version` changes when a round changes, so the table is read again.
 */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Table2 } from 'lucide-react';
import { useCoreApi } from '../hooks/useSse';
import type { Traceability, TraceRow } from '../runTypes';

const MARK = {
  met: { sign: '✓', tone: 'text-hud-green', say: 'met' },
  not_met: { sign: '✗', tone: 'text-hud-red', say: 'not met' },
  not_checked: { sign: '–', tone: 'text-hud-dim', say: 'not checked' },
  none: { sign: '○', tone: 'text-hud-dim', say: 'not reviewed yet' },
} as const;

function Finding({ result, evidence }: { result: keyof typeof MARK; evidence?: string }) {
  const m = MARK[result];
  return (
    <div className="flex gap-1.5">
      <span aria-hidden className={clsx('flex-shrink-0', m.tone)}>{m.sign}</span>
      <span className="min-w-0">
        <span className="sr-only">{m.say}. </span>
        {evidence ? <span className="text-hud-bright">{evidence}</span> : <span className="text-hud-dim">{result === 'none' ? 'Not reviewed yet' : m.say}</span>}
      </span>
    </div>
  );
}

function Row({ row, testers }: { row: TraceRow; testers: Array<'App tester' | 'Page tester'> }) {
  return (
    <tr className="align-top">
      <th scope="row" className="py-2 pr-3 text-left font-normal text-hud-bright">{row.criterion}</th>
      <td className="py-2 pr-3">
        {row.tests.length ? <ul className="space-y-0.5">{row.tests.map((t) => <li key={t} className="text-hud-bright">{t}</li>)}</ul> : <span className="text-hud-dim">None named</span>}
      </td>
      <td className="py-2 pr-3"><Finding result={row.checker ? (row.checker.met ? 'met' : 'not_met') : 'none'} evidence={row.checker?.evidence} /></td>
      {testers.map((who) => {
        const t = row.testers.find((x) => x.who === who);
        return <td key={who} className="py-2 pr-3">{t ? <Finding result={t.result} evidence={t.evidence} /> : <span className="text-hud-dim">–</span>}</td>;
      })}
    </tr>
  );
}

export default function TraceTable({ taskId, version }: { taskId: string; version: string }) {
  const api = useCoreApi();
  const [trace, setTrace] = useState<Traceability | null>(null);
  useEffect(() => {
    let gone = false;
    api.get(`/tasks/${taskId}/trace`).then((d) => { if (!gone) setTrace(Array.isArray(d?.rows) ? (d as Traceability) : null); }).catch(() => {});
    return () => { gone = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, version]);

  if (!trace || trace.rows.length === 0) return null;
  const testers = (['App tester', 'Page tester'] as const).filter((who) => trace.rows.some((r) => r.testers.some((t) => t.who === who)));
  const met = trace.rows.filter((r) => r.checker?.met).length;
  return (
    <section aria-label="Traceability" className="rounded-xl border border-hud-border p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Table2 aria-hidden className="h-4 w-4 text-hud-cyan" />
        <h3 className="text-sm font-semibold text-hud-bright">Each criterion, its tests and what was found</h3>
        <span className="text-xs text-hud-dim">{trace.round ? `round ${trace.round} · ${met} of ${trace.rows.length} confirmed by the Checker` : 'not reviewed yet'}</span>
      </div>
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[40rem] text-xs">
          <thead>
            <tr className="border-b border-hud-border text-left text-[11px] uppercase tracking-wide text-hud-dim">
              <th scope="col" className="py-1.5 pr-3 font-semibold">Criterion</th>
              <th scope="col" className="py-1.5 pr-3 font-semibold">Tests in the plan</th>
              <th scope="col" className="py-1.5 pr-3 font-semibold">Checker</th>
              {testers.map((who) => <th key={who} scope="col" className="py-1.5 pr-3 font-semibold">{who}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-hud-border/60">
            {trace.rows.map((r, i) => <Row key={i} row={r} testers={testers} />)}
          </tbody>
        </table>
      </div>
      {trace.otherTests.length > 0 && (
        <p className="mt-2 text-xs text-hud-dim">Other tests in the plan: <span className="text-hud-bright">{trace.otherTests.join(' · ')}</span></p>
      )}
    </section>
  );
}
