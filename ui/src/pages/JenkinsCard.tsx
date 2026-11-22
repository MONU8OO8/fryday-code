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
  /** The name of Claude Code's MCP server for Jenkins, when it has one. */
  const [mcpServer, setMcpServer] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const api = useCoreApi();

  useEffect(() => {
    api.get('/deploy/jenkins').then((d) => { setStatus(d.jenkins); setBaseUrl(d.jenkins.baseUrl ?? ''); setUser(d.jenkins.user ?? ''); }).catch((e) => setError(message(e)));
    // Claude Code may already have an MCP server for Jenkins: then there is nothing to type.
    api.get('/deploy/jenkins/mcp').then((d) => setMcpServer(d.server)).catch(() => setMcpServer(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (work: () => Promise<string>) => {
    setBusy(true); setError(''); setInfo('');
    try { setInfo(await work()); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      // Core tries them against Jenkins first, so a refused token is never saved.
      const d = await api.put('/deploy/jenkins', { baseUrl, user, token });
      setStatus(d.jenkins);
      setToken('');
      if (d.warning) return d.warning;
      return `Saved and checked: Jenkins knows you as ${d.user}.`;
    });
  };
  const test = () => void run(async () => {
    const name = job.trim();
    if (!name) {
      const d = await api.post('/deploy/jenkins/test', {});
      return `Jenkins answers and knows you as ${d.user}. Nothing was started.`;
    }
    // The same check a project's deploy job gets, so a name that is not there says which are.
    const d = await api.post('/deploy/jenkins/job', { job: name });
    if (d.ok) return `${name} is there and takes a BRANCH parameter. Nothing was started.`;
    throw new Error(JSON.stringify({ error: d.didYouMean?.length ? `${d.problem} These are there: ${d.didYouMean.join(', ')}.` : d.problem }));
  });
  const fromMcp = () => void run(async () => {
    const d = await api.post('/deploy/jenkins/mcp', {});
    setStatus(d.jenkins); setBaseUrl(d.jenkins.baseUrl ?? ''); setUser(d.jenkins.user ?? ''); setToken('');
    return `Taken from the "${d.server}" MCP server and checked: Jenkins knows you as ${d.user}.`;
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
      {mcpServer && (
        <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-xl border border-hud-cyan/30 bg-hud-cyan/5 px-3 py-2.5">
          <span className="flex-1 min-w-0 text-sm">
            Claude Code already talks to Jenkins through its <b className="font-semibold">{mcpServer}</b> server.
            FryDay can use the same address and token, so you do not keep a second copy here.
          </span>
          <Button size="sm" disabled={busy} onClick={fromMcp}>{busy ? 'Reading…' : 'Use that one'}</Button>
        </div>
      )}
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
          <Button variant="secondary" onClick={test} disabled={busy}>Check a job (read only)</Button>
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
