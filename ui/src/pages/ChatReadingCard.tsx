/**
 * Reading the Chat space, so the owner can give tasks, answer and approve there.
 * Three steps: the owner's Google OAuth client, signing in, and linking the account by
 * posting a code in the space.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { MessagesSquare, CheckCircle, Circle, RefreshCw, ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { useCoreApi, useSse } from '../hooks/useSse';
import { Button, Card, Field } from '../ui';
import ConnectionHead from './ConnectionHead';

interface Status {
  google: { clientSet: boolean; clientId: string | null; signedIn: boolean; signedInAt: number | null };
  inbound: { enabled: boolean; owner: string | null; linking: { code: string; expiresAt: number } | null; lastPollAt: number | null; lastError: string | null; handled: number; skippedOthers: number; missing: string[] };
}

function message(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  try { return (JSON.parse(text) as { error?: string }).error ?? text; } catch { return text; }
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      {done ? <CheckCircle aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0 text-hud-green" /> : <Circle aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0 text-hud-dim" />}
      <div className="min-w-0 flex-1">
        <div className={clsx('text-sm font-medium', done ? 'text-hud-green' : 'text-hud-bright')}>{n}. {title}{done && <span className="sr-only"> (done)</span>}</div>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}

export default function ChatReadingCard({ webhookSet }: { webhookSet: boolean }) {
  const [s, setS] = useState<Status | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const api = useCoreApi();

  const refresh = () => api.get('/chat-inbound').then(setS).catch((e) => setError(message(e)));
  useEffect(() => { void refresh(); }, []);
  useSse('/api/events', (ev) => { if (ev['type'] === 'chat_inbound_updated') void refresh(); });
  // While a sign-in or a link is under way, look again now and then.
  useEffect(() => {
    if (!s || (s.google.signedIn && !s.inbound.linking)) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [s?.google.signedIn, s?.inbound.linking?.code]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { const r = await work(); if (r && typeof r === 'object' && 'google' in r) setS(r as Status); else await refresh(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const saveClient = (e: FormEvent) => { e.preventDefault(); void run(async () => { const r = await api.put('/chat-inbound/client', { clientId, clientSecret }); setClientSecret(''); return r; }); };
  const signIn = () => void run(async () => {
    const { url } = await api.post('/chat-inbound/signin', {});
    window.open(url, '_blank', 'noopener');
  });

  if (!s) return null;
  const linked = Boolean(s.inbound.owner);
  const code = 'font-mono text-xs text-hud-bright';
  const kbd = 'rounded border border-hud-border bg-hud-bg px-1.5 py-0.5 font-mono text-xs';
  return (
    <Card>
      <ConnectionHead icon={<MessagesSquare className="h-4 w-4" />} title="Reading the space" optional
        tone={s.inbound.enabled && linked ? 'ok' : 'neutral'}
        state={s.inbound.enabled && linked ? `On, listening to ${s.inbound.owner}` : linked ? 'Off' : 'Not set up'} />
      <p className="mt-2 text-sm text-hud-bright">
        Give FryDay tasks, answer its questions and approve in the Chat space. FryDay reads the space with your own Google sign-in (read-only); there is no bot and nothing listens on the internet. Only your messages are acted on, and approving needs the code from the decision's message.
      </p>

      <div className="mt-4 space-y-4">
        {!webhookSet && <p className="text-sm text-hud-amber">Set up the space's webhook above first: FryDay answers through it.</p>}

        <Step n={1} done={s.google.clientSet} title="Your Google OAuth client">
          <p className="mb-2 text-xs text-hud-dim">
            In your Google Cloud project: enable the Google Chat API; on the OAuth consent screen add yourself as a test user; then Credentials → Create OAuth client ID → <span className="text-hud-bright">Desktop app</span>. Paste its id and secret here.
            {s.google.clientId && <span className="mt-0.5 block">Saved: <span className={code}>{s.google.clientId}</span></span>}
          </p>
          <form onSubmit={saveClient} className="grid items-end gap-2 sm:grid-cols-[2fr_1.5fr_auto]">
            <Field label="OAuth client id" className="font-mono text-xs" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1234567890-abc.apps.googleusercontent.com" autoComplete="off" />
            <Field label="OAuth client secret" className="font-mono text-xs" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={s.google.clientSet ? 'new secret to replace it' : 'client secret'} autoComplete="off" />
            <Button type="submit" disabled={busy || !clientId.trim() || !clientSecret.trim()}>Save</Button>
          </form>
        </Step>

        <Step n={2} done={s.google.signedIn} title="Sign in with Google">
          {s.google.signedIn ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-hud-dim">
              Signed in{s.google.signedInAt ? ` ${new Date(s.google.signedInAt).toLocaleString()}` : ''}. FryDay can read the space's messages, nothing else.
              <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('Sign out of Google? FryDay stops reading the space.')) void run(() => api.post('/chat-inbound/signout', {})); }} disabled={busy}>Sign out</Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={signIn} disabled={busy || !s.google.clientSet} icon={<ExternalLink className="h-3 w-3" aria-hidden />}>Sign in with Google</Button>
              <span className="text-xs text-hud-dim">Opens Google in a new tab; it comes back to this computer.</span>
            </div>
          )}
        </Step>

        <Step n={3} done={linked} title="Link your Chat account">
          {linked ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-hud-dim">
              FryDay takes instructions from <span className="text-hud-bright">{s.inbound.owner}</span> only.
              <Button size="sm" variant="ghost" onClick={() => void run(() => api.post('/chat-inbound/unlink', {}))} disabled={busy}>Unlink</Button>
            </div>
          ) : s.inbound.linking ? (
            <div className="text-sm text-hud-bright">
              Post this in the space, as yourself:{' '}
              <code className={clsx(kbd, 'select-all text-hud-cyan')}>{s.inbound.linking.code}</code>
              <span className="mt-1 block text-xs text-hud-dim">Whoever posts it becomes the account FryDay listens to. It works until {new Date(s.inbound.linking.expiresAt).toLocaleTimeString()}.</span>
            </div>
          ) : (
            <Button size="sm" onClick={() => void run(() => api.post('/chat-inbound/link', {}))} disabled={busy || s.inbound.missing.length > 0}>Get a link code</Button>
          )}
        </Step>

        {linked && (
          <div className="flex flex-wrap items-center gap-3 border-t border-hud-border pt-3 text-sm">
            <label className="flex items-center gap-2 text-hud-bright">
              <input type="checkbox" className="h-4 w-4 rounded accent-hud-cyan" checked={s.inbound.enabled} onChange={(e) => void run(() => api.post('/chat-inbound/reading', { enabled: e.target.checked }))} disabled={busy} />
              Read the space
            </label>
            <span className="text-xs text-hud-dim">{s.inbound.lastPollAt ? `Last looked ${new Date(s.inbound.lastPollAt).toLocaleTimeString()}` : 'Not looked yet'}</span>
            <span className="text-xs text-hud-dim">{s.inbound.handled} message{s.inbound.handled === 1 ? '' : 's'} from you handled{s.inbound.skippedOthers ? `, ${s.inbound.skippedOthers} from others skipped` : ''}</span>
            <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void run(() => api.post('/chat-inbound/check', {}))} disabled={busy || !s.inbound.enabled} icon={<RefreshCw className="h-3 w-3" aria-hidden />}>
              Look now
            </Button>
          </div>
        )}
        {s.inbound.lastError && <p className="text-sm text-hud-amber">{s.inbound.lastError}</p>}
        {linked && (
          <p className="text-xs text-hud-dim">
            In the space: <code className={code}>task: …</code> gives a task (add a line <code className="font-mono">project: id</code> to name the project), <code className={code}>status</code>, <code className={code}>help</code>. In a task's thread: <code className={code}>approve 123456</code>, <code className={code}>decline 123456</code>, <code className={code}>go ahead</code>, <code className={code}>1: answer</code>, <code className={code}>note: …</code>.
          </p>
        )}
        {error && <p role="alert" className="text-sm text-hud-red">{error}</p>}
      </div>
    </Card>
  );
}
