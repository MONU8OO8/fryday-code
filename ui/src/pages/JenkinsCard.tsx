/**
 * The Jenkins FryDay Code deploys staging with: its address, a user and an API token.
 * The token can be set and replaced, never read back.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Rocket } from 'lucide-react';
import { useCoreApi } from '../hooks/useSse';
import { Button, Card, Field } from '../ui';
import ConnectionHead from './ConnectionHead';

interface Status { configured: boolean; baseUrl: string | null; user: string | null }

function message(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  try { return (JSON.parse(text) as { error?: string }).error ?? text; } catch { return text; }
}

export default function JenkinsCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [user, setUser] = useState('');
  const [token, setToken] = useState('');
  const [job, setJob] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const api = useCoreApi();

  useEffect(() => {
    api.get('/deploy/jenkins').then((d) => { setStatus(d.jenkins); setBaseUrl(d.jenkins.baseUrl ?? ''); setUser(d.jenkins.user ?? ''); }).catch((e) => setError(message(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (work: () => Promise<string>) => {
    setBusy(true); setError(''); setInfo('');
    try { setInfo(await work()); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const d = await api.put('/deploy/jenkins', { baseUrl, user, token });
      setStatus(d.jenkins);
      setToken('');
      return 'Saved. Test it to check the address and token.';
    });
  };
  const test = () => void run(async () => {
    const d = await api.post('/deploy/jenkins/test', job.trim() ? { job: job.trim() } : {});
    const params = d.job?.parameters?.length ? `; its parameters: ${d.job.parameters.map((p: { name: string; defaultValue: string | null }) => `${p.name}${p.defaultValue ? ` (default ${p.defaultValue})` : ''}`).join(', ')}` : d.job ? '; it takes no parameters' : '';
    return `Jenkins answers and knows you as ${d.user}.${d.job ? ` Found ${d.job.fullName}${params}.` : ''} Nothing was started.`;
  });
  const remove = () => {
    if (!window.confirm('Forget the Jenkins address and token? Deploys stop being offered until it is set up again.')) return;
    void run(async () => { const d = await api.del('/deploy/jenkins'); setStatus(d.jenkins); return 'Removed.'; });
  };

  const on = status?.configured;
  return (
    <Card>
      <ConnectionHead icon={<Rocket className="h-4 w-4" />} title="Jenkins" optional tone={on ? 'ok' : 'neutral'}
        state={on ? `Set up: ${status!.user} @ ${status!.baseUrl}` : 'Not set up'} />
      <p className="mt-2 text-sm text-hud-bright">
        Deploys staging after a merge, for projects that name a Jenkins job (Projects page). Every deploy needs your yes, each staging prompt in the pipeline is asked of you, and a prompt about production is never answered.
      </p>
      <form onSubmit={save} className="mt-3 grid items-end gap-2 sm:grid-cols-[2fr_1fr_1.5fr_auto]">
        <Field label="Jenkins address" className="font-mono text-xs" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://jenkins.example.com" />
        <Field label="Jenkins user" className="font-mono text-xs" value={user} onChange={(e) => setUser(e.target.value)} placeholder="user" autoComplete="off" />
        <Field label="Jenkins API token" className="font-mono text-xs" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off"
          placeholder={on ? 'new API token to replace it' : 'API token (Jenkins → you → Security)'} />
        <Button type="submit" disabled={busy || !baseUrl.trim() || !user.trim() || !token.trim()}>Save</Button>
      </form>
      {on && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Job to look up" wrapperClassName="min-w-[16rem] flex-1" className="font-mono text-xs" value={job} onChange={(e) => setJob(e.target.value)} placeholder="e.g. team/service (optional)" />
          <Button variant="secondary" onClick={test} disabled={busy}>Test (read only)</Button>
          <Button variant="ghost" onClick={remove} disabled={busy}>Remove</Button>
        </div>
      )}
      <p className="mt-2 text-xs text-hud-dim">
        Use a Jenkins user that may build the staging jobs and nothing more if you can. The token is kept in a file only you can read, is not shown again, and no agent can read it.
      </p>
      {info && <p role="status" className="mt-1 text-xs text-hud-green">{info}</p>}
      {error && <p role="alert" className="mt-1 text-sm text-hud-red">{error}</p>}
    </Card>
  );
}
