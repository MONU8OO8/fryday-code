/**
 * What happened when a round's change was started and used: the service, what each
 * tester did and found, and the screenshots the UI tester took.
 */

import { useState } from 'react';
import clsx from 'clsx';
import { Badge, type BadgeTone } from '../ui';

interface Report {
  verdict: 'pass' | 'fail';
  summary: string;
  criteria: Array<{ criterion: string; result: 'met' | 'not_met' | 'not_checked'; evidence: string }>;
  issues: Array<{ severity: 'blocking' | 'minor'; where: string; description: string; evidence: string }>;
  notTested: string[];
}
export interface Verification {
  status: 'running' | 'passed' | 'failed' | 'error';
  service: { command: string; port: number; listen: 'loopback' | 'all' | 'unknown'; readyAfterMs: number } | null;
  startFailure?: { reason: string; detail: string; logTail: string; alsoWithoutTheChange: boolean | null };
  testers: Array<{ kind: 'api' | 'ui'; runId: string; report: Report | null; calls: number; passed: boolean }>;
  dataConnections: string[];
  unavailable: Array<{ name: string; why: string }>;
  refused: string[];
  evidence: string[];
  note?: string;
}

const STATUS: Record<Verification['status'], { label: string; tone: BadgeTone }> = {
  running: { label: 'In progress', tone: 'accent' },
  passed: { label: 'Passed', tone: 'ok' },
  failed: { label: 'Found a problem', tone: 'bad' },
  error: { label: 'Could not be carried out', tone: 'bad' },
};
const RESULT: Record<Report['criteria'][number]['result'], { mark: string; cls: string }> = {
  met: { mark: 'Met', cls: 'text-hud-green' },
  not_met: { mark: 'Not met', cls: 'text-hud-red' },
  not_checked: { mark: 'Not checked', cls: 'text-hud-dim' },
};
const NAME = { api: 'App tester', ui: 'Page tester' } as const;

export default function VerifyCard({ taskId, round, verify }: { taskId: string; round: number; verify: Verification }) {
  const [shown, setShown] = useState<string | null>(null);
  const status = STATUS[verify.status];
  const src = (name: string) => `/api/tasks/${taskId}/evidence/${round}/${encodeURIComponent(name)}`;

  return (
    <div className="mt-3 space-y-1 border-t border-hud-border pt-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-hud-bright">Tried out running</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        {verify.note && <span className="text-hud-bright">{verify.note}</span>}
      </div>

      {verify.service && (
        <div className="text-hud-dim">
          Started with <code className="font-mono text-xs text-hud-bright">{verify.service.command}</code> on port {verify.service.port}, up after {(verify.service.readyAfterMs / 1000).toFixed(1)}s
          {verify.service.listen === 'all' && <span className="text-hud-amber"> · it listened on every network interface of this computer while it ran, not only on this one</span>}
        </div>
      )}
      {verify.startFailure && (
        <details className="mt-1" open>
          <summary className="cursor-pointer rounded text-hud-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
            {verify.startFailure.detail}
            {verify.startFailure.alsoWithoutTheChange === true && ' It does not start without this change either.'}
            {verify.startFailure.alsoWithoutTheChange === false && ' It does start without this change.'}
          </summary>
          <pre className="mt-1 max-h-64 overflow-x-auto whitespace-pre-wrap rounded-lg border border-hud-border bg-hud-bg p-2 font-mono text-xs text-hud-dim">{verify.startFailure.logTail.trim() || '(the service printed nothing)'}</pre>
        </details>
      )}
      {verify.dataConnections.length > 0 && <div className="text-hud-dim">Data it could read: <span className="text-hud-bright">{verify.dataConnections.join(', ')}</span></div>}
      {verify.unavailable.map((u) => <div key={u.name} className="text-hud-amber">{u.name} was not given: {u.why}</div>)}

      {verify.testers.map((t) => (
        <details key={t.runId} className="mt-2" open={!t.passed}>
          <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60">
            <span className="text-hud-dim">{NAME[t.kind]}: </span>
            <span className={clsx('font-semibold', t.passed ? 'text-hud-green' : 'text-hud-red')}>{t.passed ? 'pass' : t.report ? 'fail' : 'no report'}</span>
            <span className="text-hud-dim"> · {t.calls} {t.kind === 'api' ? 'request' : 'browser step'}{t.calls === 1 ? '' : 's'}</span>
            {t.report && <span className="text-hud-bright"> · {t.report.summary}</span>}
          </summary>
          {t.report && (
            <div className="ml-3 mt-1 space-y-1">
              {t.report.criteria.map((c, i) => (
                <div key={i}>
                  <span className={clsx('text-xs font-semibold', RESULT[c.result].cls)}>{RESULT[c.result].mark}</span>{' '}
                  <span className="text-hud-bright">{c.criterion}</span>
                  <div className="whitespace-pre-wrap break-words text-xs text-hud-dim">{c.evidence}</div>
                </div>
              ))}
              {t.report.issues.map((issue, i) => (
                <div key={i} className={issue.severity === 'blocking' ? 'text-hud-red' : 'text-hud-amber'}>
                  [{issue.severity}] {issue.where && <span className="font-mono text-xs">{issue.where}: </span>}{issue.description}
                  <div className="whitespace-pre-wrap break-words text-xs text-hud-dim">{issue.evidence}</div>
                </div>
              ))}
              {t.report.notTested.length > 0 && (
                <div className="text-hud-dim">Not tested: {t.report.notTested.join(' · ')}</div>
              )}
            </div>
          )}
        </details>
      ))}

      {verify.refused.length > 0 && (
        <div className="mt-2 text-hud-amber">
          The pages tried to reach {verify.refused.length} other place{verify.refused.length === 1 ? '' : 's'} and were stopped:{' '}
          <span className="break-all font-mono text-xs">{verify.refused.slice(0, 12).join(', ')}{verify.refused.length > 12 ? ', …' : ''}</span>
        </div>
      )}

      {verify.evidence.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-xs font-semibold text-hud-dim">Screenshots ({verify.evidence.length})</div>
          <div className="flex flex-wrap gap-2">
            {verify.evidence.map((name) => (
              <button key={name} type="button" onClick={() => setShown(shown === name ? null : name)} title={name} aria-pressed={shown === name}
                className={clsx('overflow-hidden rounded-lg border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60', shown === name ? 'border-hud-cyan' : 'border-hud-border hover:border-hud-cyan/50')}>
                <img src={src(name)} alt={`Screenshot ${name}`} loading="lazy" className="h-20 w-32 object-cover object-top" />
              </button>
            ))}
          </div>
          {shown && <img src={src(shown)} alt={`Screenshot ${shown}`} className="mt-2 max-w-full rounded-lg border border-hud-border" />}
        </div>
      )}
    </div>
  );
}
