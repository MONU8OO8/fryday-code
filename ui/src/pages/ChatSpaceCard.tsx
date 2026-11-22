/**
 * The Chat space FryDay Code posts to: questions, approvals that are waiting, results.
 * The webhook address can be set and removed here; it is never shown again once saved.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { MessageCircle } from 'lucide-react';
import { useCoreApi } from '../hooks/useSse';
import { Button, Card, Field } from '../ui';
import ConnectionHead from './ConnectionHead';
import ChatReadingCard from './ChatReadingCard';

interface ChatStatus {
  configured: boolean;
  space: string | null;
  lastSentAt: number | null;
  lastError: string | null;
}

function message(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text;
  }
}

export default function ChatSpaceCard() {
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const api = useCoreApi();

  useEffect(() => { api.get('/notifications').then((d) => setStatus(d.chat)).catch((err) => setError(message(err))); }, []);

  const run = async (work: () => Promise<{ chat: ChatStatus; delivered?: boolean }>, done: (r: { delivered?: boolean }) => string) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      const result = await work();
      setStatus(result.chat);
      setInfo(done(result));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    void run(() => api.put('/notifications/chat', { webhookUrl: url.trim() }), () => 'Saved. Send a test message to check it.').then(() => setUrl(''));
  };

  const state = !status?.configured ? 'off' : status.lastError ? 'warn' : 'ok';

  return (
    <div className="space-y-3">
    <Card className={state === 'warn' ? 'border-hud-amber/50' : undefined}>
      <ConnectionHead icon={<MessageCircle className="h-4 w-4" />} title="Chat space" optional
        tone={state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : 'neutral'}
        state={state === 'ok' ? 'Set up' : state === 'warn' ? 'Last message failed' : 'Not set up'} />
      <p className="mt-2 text-sm text-hud-bright">
        {status?.configured
          ? `Posting to ${status.space}.${status.lastSentAt ? ` Last message delivered ${new Date(status.lastSentAt).toLocaleTimeString()}.` : ''}`
          : 'Questions, approvals that are waiting and results can be posted to a Google Chat space, one thread per task.'}
      </p>
      {status?.lastError && <p className="text-sm text-hud-amber">{status.lastError}</p>}
      <p className="mt-1 text-xs text-hud-dim">
        Messages carry the task title, the question or the decision, and the project name. To answer and approve there too, set up reading the space below.
      </p>

      <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-2">
        <Field type="password" autoComplete="off" label="Incoming webhook address of the Chat space" wrapperClassName="min-w-[16rem] flex-1" className="font-mono text-xs"
          value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder={status?.configured ? 'Paste a new webhook address to replace the current one' : 'Paste it here (space → Apps & integrations → Webhooks)'} />
        <Button type="submit" disabled={busy || !url.trim()}>Save</Button>
        {status?.configured && (
          <>
            <Button variant="secondary" disabled={busy}
              onClick={() => void run(() => api.post('/notifications/chat/test', {}), (r) => (r.delivered ? 'Test message delivered. Look in the space.' : 'The test message was not delivered.'))}>
              Send a test
            </Button>
            <Button variant="ghost" disabled={busy}
              onClick={() => { if (window.confirm('Stop posting to this Chat space?')) void run(() => api.del('/notifications/chat'), () => 'Removed.'); }}>
              Remove
            </Button>
          </>
        )}
      </form>
      <p className="mt-2 text-xs text-hud-dim">
        The address is a secret: it is kept in a file only you can read, is not shown again, and no agent can read it.
      </p>
      {info && <p role="status" className="mt-1 text-xs text-hud-green">{info}</p>}
      {error && <p role="alert" className="mt-1 text-sm text-hud-red">{error}</p>}
    </Card>
    <ChatReadingCard webhookSet={Boolean(status?.configured)} />
    </div>
  );
}
