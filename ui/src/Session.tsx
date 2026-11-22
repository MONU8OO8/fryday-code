/**
 * The owner's session. The page itself grants nothing: a browser becomes the owner by
 * presenting a one-time launch code that core prints in its terminal (or that
 * `npx fryday-code open` / `npm run open` fetches). The code normally arrives in the link's #fragment, which is
 * never sent to a server; it can also be pasted.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Field, Logo, cardClass } from './ui';

type State = 'checking' | 'ready' | 'locked';

async function hasSession(): Promise<boolean> {
  try {
    return (await fetch('/api/session', { credentials: 'same-origin' })).ok;
  } catch {
    return false;
  }
}

async function redeem(code: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? 'That launch code was not accepted.' };
  } catch {
    return { ok: false, error: 'FryDay Code is not reachable. Is it still running?' };
  }
}

/** Take a launch code out of the address bar so it is not left in history. */
function takeCodeFromLocation(): string | null {
  const match = window.location.hash.match(/^#launch=([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return match[1] ?? null;
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>('checking');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Try a code found in the address bar. Runs on load, and again when only the
    // #fragment changes (the link opened in a tab that is already showing this screen).
    const fromAddressBar = async (): Promise<boolean> => {
      const fromLink = takeCodeFromLocation();
      if (!fromLink) return false;
      const result = await redeem(fromLink);
      // A used or expired link is fine if this browser already has a session.
      if (result.ok || (await hasSession())) { setState('ready'); return true; }
      setError(result.error ?? '');
      setState('locked');
      return true;
    };
    void (async () => {
      if (!(await fromAddressBar())) setState((await hasSession()) ? 'ready' : 'locked');
    })();
    const onHashChange = () => { void fromAddressBar(); };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = code.trim().replace(/^.*#launch=/, '');
    if (!value || busy) return;
    setBusy(true);
    const result = await redeem(value);
    setBusy(false);
    if (result.ok) setState('ready');
    else setError(result.error ?? '');
  };

  if (state === 'ready') return <>{children}</>;
  if (state === 'checking') return <div className="h-screen bg-hud-bg" />;

  return (
    <main className="min-h-screen bg-hud-bg text-hud-bright flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6"><Logo size={36} /></div>
        <form onSubmit={submit} className={cardClass('lg')}>
          <h1 className="mb-5 text-base font-semibold">Hi there. Paste your launch link to get started.</h1>
          <Field
            label="Launch link or code"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => { setCode(e.target.value); setError(''); }}
            placeholder="Launch link or code"
            className="font-mono"
            hint={<>For a new link, run <code className="text-hud-bright">npx fryday-code open</code>, or <code className="text-hud-bright">npm run open</code> in your FryDay Code folder.</>}
            error={error || undefined}
          />
          <Button type="submit" size="lg" block className="mt-5" disabled={!code.trim() || busy}
            icon={<KeyRound aria-hidden className="w-4 h-4" />}>
            {busy ? 'Checking…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </main>
  );
}
