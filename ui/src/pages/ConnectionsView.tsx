/**
 * Connections: what FryDay Code can use on this computer. Every visit runs the checks
 * for real; nothing here is remembered from last time.
 */

import { useEffect, useState, useCallback } from 'react';
import { CheckCircle, AlertTriangle, XCircle, MinusCircle, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { useCoreApi } from '../hooks/useSse';
import { Badge, Button, Card, PageHeader, Section, type BadgeTone } from '../ui';
import ChatSpaceCard from './ChatSpaceCard';
import JenkinsCard from './JenkinsCard';
import CursorCard from './CursorCard';
import DataConnections, { type DataConnection } from './DataConnections';

type CheckState = 'ok' | 'warn' | 'problem' | 'off';
interface Check {
  id: string;
  name: string;
  usedFor: string;
  required: boolean;
  state: CheckState;
  summary: string;
  fix?: string;
}
interface McpServer {
  name: string;
  transport: string;
  environment: 'production' | 'staging' | 'local' | 'unknown';
  looksLikeDatabase: boolean;
  notes: string[];
}
interface Report {
  checkedAt: number;
  checks: Check[];
  mcpServers: McpServer[];
  mcpNote: string | null;
  dataConnections: DataConnection[];
}

const STATE: Record<CheckState, { icon: typeof CheckCircle; color: string; border: string; label: string; tone: BadgeTone }> = {
  ok:      { icon: CheckCircle,   color: 'text-hud-green', border: 'border-hud-border',   label: 'Works',        tone: 'ok' },
  warn:    { icon: AlertTriangle, color: 'text-hud-amber', border: 'border-hud-amber/50', label: 'Needs a look', tone: 'warn' },
  problem: { icon: XCircle,       color: 'text-hud-red',   border: 'border-hud-red/50',   label: 'Not working',  tone: 'bad' },
  off:     { icon: MinusCircle,   color: 'text-hud-dim',   border: 'border-hud-border',   label: 'Not set up',   tone: 'neutral' },
};

export default function ConnectionsView() {
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const api = useCoreApi();

  const check = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      setReport(await api.get('/connections'));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { void check(); }, [check]);

  const blocking = report?.checks.filter((c) => c.state === 'problem') ?? [];

  const readable = report ? report.dataConnections.filter((c) => c.enabled && !c.changed).length : 0;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 md:p-6">
      <PageHeader title="Connections"
        subtitle={report
          ? `Checked ${new Date(report.checkedAt).toLocaleTimeString()}. FryDay Code has no sign-ins of its own: it uses the tools already set up on this computer, and checks each one by running it.`
          : 'FryDay Code has no sign-ins of its own: it uses the tools already set up on this computer, and checks each one by running it.'}
        actions={<Button variant="secondary" onClick={() => void check()} disabled={busy} icon={<RefreshCw className={clsx('h-4 w-4', busy && 'animate-spin')} aria-hidden />}>{busy ? 'Checking…' : 'Check again'}</Button>} />

      {error && <p role="alert" className="text-sm text-hud-red">{error}</p>}
      {!report && !error && <p role="status" className="text-sm text-hud-dim">Checking this computer…</p>}

      {report && (
        <>
          <div className="flex flex-wrap gap-2">
            {(['ok', 'warn', 'problem', 'off'] as const).map((k) => {
              const n = report.checks.filter((c) => c.state === k).length;
              if (n === 0) return null;
              const st = STATE[k];
              return <Badge key={k} tone={st.tone} dot>{n} {st.label.toLowerCase()}</Badge>;
            })}
            <Badge>{readable} of {report.dataConnections.length} MCP servers readable by the app tester</Badge>
          </div>
          {blocking.length > 0 && (
            <div role="alert" className="rounded-xl border border-hud-red/50 p-3 text-sm text-hud-red">
              Tasks cannot run until {blocking.map((c) => c.name).join(' and ')} {blocking.length === 1 ? 'works' : 'work'}.
            </div>
          )}

          <div className="space-y-3">
            {report.checks.map((c) => {
              const s = STATE[c.state];
              const Icon = s.icon;
              return (
                <Card key={c.id} padding="sm" className={clsx('p-4', s.border)}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Icon aria-hidden className={clsx('h-4 w-4 flex-shrink-0', s.color)} />
                    <h2 className="text-sm font-semibold text-hud-bright">{c.name}</h2>
                    <Badge tone={s.tone}>{s.label}</Badge>
                    <span className="ml-auto text-xs text-hud-dim">{c.required ? 'Needed' : 'Optional'}</span>
                  </div>
                  <p className="mt-1.5 text-sm text-hud-bright">{c.summary}</p>
                  <p className="text-xs text-hud-dim">{c.usedFor}</p>
                  {c.fix && c.state !== 'ok' && (
                    <p className="mt-2 text-xs text-hud-dim">
                      To fix, in a terminal: <code className="select-all rounded border border-hud-border bg-hud-bg px-1.5 py-0.5 font-mono text-hud-cyan">{c.fix}</code>
                    </p>
                  )}
                </Card>
              );
            })}
          </div>

          <Section title="Where FryDay Code reaches you"><ChatSpaceCard /></Section>
          <Section title="Where staging is deployed"><JenkinsCard /></Section>
          <Section title="Other agent engines"><CursorCard /></Section>

          <Section title={`Data the app tester may read (${readable} of ${report.dataConnections.length} MCP servers)`}>
            <p className="mb-3 text-sm text-hud-dim">
              These are the MCP servers Claude Code knows on this computer, listed by name only. <span className="font-medium text-hud-bright">No agent can use one until you turn it on here</span>,
              say what it points at, tick the tools, and choose the projects. Then the app tester of those projects can read through it while it checks a change.
              A production server is never offered, and a server whose definition changes afterwards is off again until you look.
            </p>
            {report.mcpNote && <p className="mb-2 text-sm text-hud-dim">{report.mcpNote}</p>}
            <DataConnections connections={report.dataConnections} notes={report.mcpServers}
              onChanged={(next) => setReport((r) => (r ? { ...r, dataConnections: r.dataConnections.map((c) => (c.name === next.name ? next : c)) } : r))} />
          </Section>
        </>
      )}
    </div>
  );
}
