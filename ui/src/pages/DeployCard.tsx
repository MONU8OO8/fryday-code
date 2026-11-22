/**
 * A task's staging deploy: the Jenkins build, its stages as they run, and how it ended —
 * including whether the build was shown to contain the merge FryDay pushed.
 */

import clsx from 'clsx';
import { Rocket, ExternalLink, Pause, CheckCircle, XCircle, Loader2, MinusCircle, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Badge, Button, Card, type BadgeTone } from '../ui';
import { fmtDuration } from '../agents';
import { useNow } from '../components/Meters';

export interface Deploy {
  id: string;
  job: string;
  params_json: string;
  stage: string | null;
  expected_sha: string;
  state: 'queued' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'stopped';
  build_number: number | null;
  build_url: string | null;
  built_sha: string | null;
  stages_json: string | null;
  outcome: string | null;
  detail: string | null;
  started_at: number;
  ended_at: number | null;
}

const STATE: Record<Deploy['state'], { label: string; tone: BadgeTone }> = {
  queued: { label: 'Queued in Jenkins', tone: 'accent' },
  running: { label: 'Running', tone: 'accent' },
  waiting_input: { label: 'Jenkins asks you', tone: 'warn' },
  succeeded: { label: 'Deployed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  stopped: { label: 'Stopped', tone: 'warn' },
};

function StageIcon({ status }: { status: string }) {
  if (status === 'SUCCESS') return <CheckCircle aria-hidden className="h-3.5 w-3.5 text-hud-green" />;
  if (status === 'FAILED' || status === 'ABORTED' || status === 'UNSTABLE') return <XCircle aria-hidden className="h-3.5 w-3.5 text-hud-red" />;
  if (status === 'IN_PROGRESS') return <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-hud-cyan motion-reduce:animate-none" />;
  if (status === 'PAUSED_PENDING_INPUT') return <Pause aria-hidden className="h-3.5 w-3.5 animate-pulse text-hud-amber motion-reduce:animate-none" />;
  return <MinusCircle aria-hidden className="h-3.5 w-3.5 text-hud-dim" />;
}

/** Only links to the build on the configured Jenkins are shown as links. */
const safeLink = (url: string | null) => (url && /^https?:\/\//.test(url) ? url : null);

export default function DeployCard({ deploy, canAskAgain, busy, onAskAgain }: { deploy: Deploy; canAskAgain: boolean; busy: boolean; onAskAgain: () => void }) {
  const live = ['queued', 'running', 'waiting_input'].includes(deploy.state);
  const now = useNow(live);
  const stages = (() => { try { return deploy.stages_json ? (JSON.parse(deploy.stages_json) as Array<{ name: string; status: string; durationMs: number }>) : []; } catch { return []; } })();
  const params = (() => { try { return JSON.parse(deploy.params_json) as Record<string, string>; } catch { return {}; } })();
  const st = STATE[deploy.state];
  const link = safeLink(deploy.build_url);
  const confirmed = deploy.outcome === 'deployed';
  const commitProblem = deploy.outcome === 'wrong_commit' || deploy.outcome === 'unconfirmed';

  return (
    <Card padding="sm" className={clsx('mb-3 p-4', live ? 'border-hud-cyan/40' : deploy.state === 'succeeded' ? 'border-hud-green/40' : undefined)}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <h2 className="flex items-center gap-1.5 font-semibold text-hud-bright"><Rocket aria-hidden className="h-4 w-4 text-hud-cyan" /> Deploy</h2>
        <Badge tone={st.tone} dot>{st.label}</Badge>
        <span className="font-mono text-xs text-hud-bright">{deploy.job}{deploy.build_number ? ` #${deploy.build_number}` : ''}</span>
        {link && <a href={link} target="_blank" rel="noreferrer noopener" className="flex items-center gap-0.5 text-hud-cyan hover:underline">Jenkins <ExternalLink aria-hidden className="h-3 w-3" /></a>}
        <span className="ml-auto text-xs tabular-nums text-hud-dim">{fmtDuration((deploy.ended_at ?? now) - deploy.started_at)}</span>
      </div>

      {Object.keys(params).length > 0 && (
        <div className="mb-2 font-mono text-xs text-hud-dim">{Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' · ')}</div>
      )}

      {stages.length > 0 && (
        <ol aria-label="Jenkins stages" className="mb-2 flex items-center gap-1 overflow-x-auto pb-1">
          {stages.map((s, i) => {
            const isTarget = deploy.stage && s.name.toLowerCase() === deploy.stage.toLowerCase();
            return (
              <li key={`${s.name}-${i}`} className="flex flex-shrink-0 items-center gap-1">
                <div className={clsx('flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors duration-500',
                  s.status === 'SUCCESS' ? 'border-hud-green/40 bg-hud-green/5 text-hud-green'
                  : s.status === 'IN_PROGRESS' ? 'border-hud-cyan/50 bg-hud-cyan/10 text-hud-cyan'
                  : s.status === 'PAUSED_PENDING_INPUT' ? 'border-hud-amber/50 bg-hud-amber/10 text-hud-amber'
                  : ['FAILED', 'ABORTED', 'UNSTABLE'].includes(s.status) ? 'border-hud-red/40 text-hud-red'
                  : 'border-hud-border text-hud-dim',
                  isTarget && 'ring-2 ring-hud-cyan/30')} title={isTarget ? 'The stage that counts as the staging deploy' : undefined}>
                  <StageIcon status={s.status} />{s.name}
                </div>
                {i < stages.length - 1 && <span aria-hidden className="text-hud-dim">›</span>}
              </li>
            );
          })}
        </ol>
      )}

      {deploy.detail && <div className={clsx('text-sm', deploy.state === 'succeeded' ? 'text-hud-green' : ['failed'].includes(deploy.state) ? 'text-hud-red' : deploy.state === 'stopped' ? 'text-hud-amber' : 'text-hud-bright')}>{deploy.detail}</div>}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className={clsx('flex items-center gap-1', confirmed ? 'text-hud-green' : commitProblem ? 'text-hud-red' : 'text-hud-dim')}>
          {confirmed ? <ShieldCheck aria-hidden className="h-3.5 w-3.5" /> : <ShieldAlert aria-hidden className="h-3.5 w-3.5" />}
          Must contain <code className="font-mono">{deploy.expected_sha.slice(0, 8)}</code>
          {deploy.built_sha && <> · built <code className="font-mono">{deploy.built_sha.slice(0, 8)}</code></>}
        </span>
        <span className="text-hud-dim">A prompt about production is never answered by FryDay.</span>
        {canAskAgain && (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={onAskAgain} disabled={busy} icon={<Rocket className="h-3 w-3" aria-hidden />}>Ask me again to deploy</Button>
        )}
      </div>
    </Card>
  );
}
