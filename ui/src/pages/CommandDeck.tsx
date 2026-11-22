/**
 * Console: where the owner talks to FryDay.
 * - "Ask" sends a message to Fryday (one agent run per message; the reply streams in over SSE)
 * - "New task" queues a pipeline task
 * - Pending approvals with inline approve/reject
 * - Today's token meter
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, CheckCircle, XCircle, AlertTriangle, MessageSquarePlus, Paperclip, X } from 'lucide-react';
import clsx from 'clsx';
import { transport } from '@transport';
import { useSse, useCoreApi } from '../hooks/useSse';
import { Button, Card, PageHeader, controlClass } from '../ui';
import { countedTokens, fmtTokens } from '../agents';

type FeedKind = 'you' | 'fryday' | 'task' | 'approval' | 'info' | 'error';
type Mode = 'ask' | 'task';

interface FeedItem {
  id: string;
  time: string;
  kind: FeedKind;
  text: string;
}

interface Approval {
  id: string;
  task_id: string;
  action: string;
  payload_json: string;
  state: string;
}

interface DayUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface Repo {
  id: string;
  name: string;
  verified: boolean;
}

const NO_USAGE: DayUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

// Kept outside the component so the conversation survives moving between pages.
const session: { feed: FeedItem[]; sessionId: string | null; myRuns: Set<string> } = {
  feed: [],
  sessionId: null,
  myRuns: new Set(),
};

const clock = () => new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Today's tokens: the counted ones (input + output + cache writes), and apart from them what was reused. */
function TokenMeter({ usage }: { usage: DayUsage }) {
  return (
    <Card padding="sm" className="p-4">
      <h2 className="mb-1 text-xs font-medium text-hud-dim">Tokens today</h2>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-xl font-semibold tabular-nums text-hud-cyan">{fmtTokens(countedTokens(usage))}</span>
        <span className="text-xs tabular-nums text-hud-dim">
          in {fmtTokens(usage.inputTokens)} · out {fmtTokens(usage.outputTokens)} · cache write {fmtTokens(usage.cacheWriteTokens)}
        </span>
        <span className="ml-auto text-xs tabular-nums text-hud-dim" title="Context reused from earlier turns; not counted toward a limit">{fmtTokens(usage.cacheReadTokens)} reused</span>
      </div>
    </Card>
  );
}

function ApprovalCard({ approval, onResolve }: { approval: Approval; onResolve: (id: string, decision: 'approved' | 'rejected') => void }) {
  const payload = (() => { try { return JSON.parse(approval.payload_json); } catch { return {}; } })();
  return (
    <Card padding="sm" className="mb-2 border-hud-amber/50 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 flex-shrink-0 text-hud-amber" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-xs font-medium text-hud-amber"><span className="font-mono">{approval.task_id}</span> · {approval.action === 'release_stg' ? 'Release' : approval.action === 'push_branch' ? 'Push' : approval.action === 'continue_budget' ? 'Token limit' : approval.action}</div>
          <div className="text-sm text-hud-bright">{payload.summary ?? JSON.stringify(payload).slice(0, 80)}</div>
          {Array.isArray(payload.pushes) && payload.pushes.length > 0 && (
            <ul className="mt-1 space-y-0.5 font-mono text-xs text-hud-dim">
              {(payload.pushes as string[]).map((p) => <li key={p}>pushes {p}</li>)}
            </ul>
          )}
        </div>
        <div className="flex flex-shrink-0 gap-2">
          <Button size="sm" variant="success" icon={<CheckCircle className="h-3.5 w-3.5" aria-hidden />} onClick={() => onResolve(approval.id, 'approved')}>Yes</Button>
          <Button size="sm" variant="secondary" icon={<XCircle className="h-3.5 w-3.5" aria-hidden />} onClick={() => onResolve(approval.id, 'rejected')}>No</Button>
        </div>
      </div>
    </Card>
  );
}

const KIND_LABEL: Record<FeedKind, string> = { you: 'You', fryday: 'FryDay', task: 'Task', approval: 'Approval', info: 'Info', error: 'Error' };
const KIND_COLOR: Record<FeedKind, string> = {
  you: 'text-hud-dim',
  fryday: 'text-hud-bright',
  task: 'text-hud-cyan',
  approval: 'text-hud-amber',
  info: 'text-hud-dim',
  error: 'text-hud-red',
};

export default function CommandDeck() {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>('ask');
  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState(0);
  const [feed, setFeed] = useState<FeedItem[]>(session.feed);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [usage, setUsage] = useState<DayUsage>(NO_USAGE);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoId, setRepoId] = useState('');
  const [branch, setBranch] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const filePicker = useRef<HTMLInputElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const api = useCoreApi();

  const add = useCallback((kind: FeedKind, text: string) => {
    session.feed = [...session.feed.slice(-199), { id: `${Date.now()}-${Math.random()}`, time: clock(), kind, text }];
    setFeed(session.feed);
  }, []);

  const refreshUsage = useCallback(() => {
    api.get('/usage/today').then((d) => setUsage(d.usage ?? NO_USAGE)).catch(() => {});
  }, [api]);

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [feed, thinking]);

  useEffect(() => {
    api.get('/approvals').then((d) => setApprovals(d.approvals ?? [])).catch(() => {});
    api.get('/projects').then((d) => setRepos(((d.repos ?? []) as Repo[]).filter((r) => r.verified))).catch(() => {});
    refreshUsage();
  }, []);

  useSse('/api/events', (ev) => {
    const type = ev['type'] as string;
    const task = ev['task'] as Record<string, unknown> | undefined;
    const runId = ev['runId'] as string | undefined;
    const mine = runId !== undefined && session.myRuns.has(runId);

    if (type === 'task_created') add('task', `${task?.['id']} queued: ${task?.['title']}`);
    if (type === 'task_updated') {
      let note = '';
      try { note = JSON.parse((task?.['metadata_json'] as string) ?? '{}').note ?? ''; } catch { /* no note */ }
      add('task', `${task?.['id']} → ${String(task?.['state']).replace('_', ' ')}${note ? ` — ${note}` : ''}`);
    }
    if (type === 'approval_requested') {
      const a = ev['approval'] as Approval;
      if (a?.id) setApprovals((prev) => [a, ...prev.filter((x) => x.id !== a.id)]);
    }
    if (type === 'release_updated') api.get('/approvals').then((d) => setApprovals(d.approvals ?? [])).catch(() => {});
    if (type === 'approval_resolved') {
      const a = ev['approval'] as Approval;
      setApprovals((prev) => prev.filter((x) => x.id !== a?.id));
      add('approval', `Approval ${a?.id} ${a?.state}`);
    }
    if (type === 'run_event' && ev['role'] === 'fryday') {
      if (ev['kind'] === 'assistant' && ev['text']) add('fryday', ev['text'] as string);
      if (ev['kind'] === 'result') {
        if (mine && !ev['isError']) session.sessionId = ev['sessionId'] as string;
        if (ev['isError']) add('error', `FryDay could not answer: ${ev['text'] || 'unknown error'}`);
      }
    }
    if (type === 'run_exit') {
      if (mine) {
        session.myRuns.delete(runId!);
        setThinking(session.myRuns.size);
      }
      if (ev['state'] === 'killed') add('info', 'Run stopped.');
      else if (ev['state'] === 'failed' && ev['role'] !== 'fryday') add('error', `${ev['role']} run failed: ${ev['error'] ?? 'unknown error'}`);
      refreshUsage();
    }
  });

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      if (mode === 'ask') {
        add('you', text);
        const res = await api.post('/chat', { message: text, ...(session.sessionId ? { sessionId: session.sessionId } : {}) });
        session.myRuns.add(res.runId);
        setThinking(session.myRuns.size);
      } else {
        // Created first, so its documents are attached before the Understander reads the task.
        const res = await api.post('/tasks', { title: text.slice(0, 200), description: text, start: false });
        for (const file of files) {
          const up = await transport.rawFetch(`/api/tasks/${res.id}/attachments`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
            body: file,
          });
          if (!up.ok) throw new Error(`${res.id} was created but not started: ${file.name} — ${(await up.json().catch(() => ({}))).error ?? up.statusText}`);
        }
        await api.post(`/tasks/${res.id}/start`, { ...(repoId ? { repoId } : {}), ...(repoId && branch.trim() ? { branch: branch.trim() } : {}) });
        setFiles([]);
        setBranch('');
      }
      setInput('');
    } catch (err) {
      let message = String(err instanceof Error ? err.message : err);
      try { message = JSON.parse(message).error ?? message; } catch { /* not JSON */ }
      add('error', message);
    } finally {
      setSending(false);
    }
  };

  const newConversation = () => {
    session.sessionId = null;
    add('info', 'New conversation started.');
  };

  const handleApproval = useCallback(async (id: string, decision: 'approved' | 'rejected') => {
    try {
      const ticket = approvals.find((a) => a.id === id);
      if (decision === 'approved' && ticket?.action === 'release_stg'
        && !window.confirm('Approve this? It pushes to the shared remote. It can be reverted afterwards, not undone.')) return;
      await api.post(`/approvals/${id}/resolve`, { decision });
    } catch (err) {
      add('error', `Approval failed: ${err instanceof Error ? err.message : err}`);
    }
  }, [api, add, approvals]);

  const modeButton = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={clsx(
        'min-h-9 border px-3.5 text-sm font-medium transition-colors first:rounded-l-lg last:rounded-r-lg last:border-l-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/60',
        mode === m ? 'border-hud-cyan bg-hud-cyan/10 font-semibold text-hud-cyan' : 'border-hud-border bg-hud-surface text-hud-dim hover:text-hud-bright'
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-3 p-4 md:p-6">
      <PageHeader title="Console" subtitle="Talk to FryDay, or queue a task."
        actions={<Button variant="ghost" size="sm" onClick={newConversation} icon={<MessageSquarePlus className="h-4 w-4" aria-hidden />}>New conversation</Button>} />

      <TokenMeter usage={usage} />

      {approvals.length > 0 && (
        <div>
          <h2 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-hud-amber">
            <AlertTriangle aria-hidden className="h-4 w-4" /> {approvals.length} pending approval{approvals.length > 1 ? 's' : ''}
          </h2>
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} onResolve={handleApproval} />
          ))}
        </div>
      )}

      <div
        ref={feedRef}
        role="log"
        aria-label="Conversation and task log"
        className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-2xl border border-hud-border bg-hud-surface p-4 text-sm shadow-card"
      >
        {feed.length === 0 && (
          <p className="text-hud-dim">Nothing yet. Ask FryDay something, or queue a task.</p>
        )}
        {feed.map((item) => (
          <div key={item.id} className="flex items-start gap-2">
            <span className="flex-shrink-0 font-mono text-xs leading-5 text-hud-dim">{item.time}</span>
            <span className={clsx('w-16 flex-shrink-0 text-xs font-semibold leading-5', item.kind === 'fryday' ? 'text-hud-cyan' : KIND_COLOR[item.kind])}>
              {KIND_LABEL[item.kind]}
            </span>
            <span className={clsx('flex-1 whitespace-pre-wrap break-words', KIND_COLOR[item.kind] === 'text-hud-dim' ? 'text-hud-bright' : KIND_COLOR[item.kind])}>{item.text}</span>
          </div>
        ))}
        {thinking > 0 && <div role="status" className="animate-pulse text-hud-cyan motion-reduce:animate-none">FryDay is working…</div>}
        <div className="cursor-blink" />
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="flex flex-shrink-0" role="group" aria-label="What to send">
          {modeButton('ask', 'Ask')}
          {modeButton('task', 'New task')}
        </div>
        {mode === 'task' && (
          <select
            value={repoId}
            onChange={(e) => setRepoId(e.target.value)}
            aria-label="Project to code in"
            className={clsx(controlClass(), '!w-auto max-w-[12rem] flex-shrink-0')}
          >
            <option value="">FryDay works out the project</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        )}
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
          aria-label={mode === 'ask' ? 'Message to FryDay' : 'Task description'}
          placeholder={mode === 'ask' ? 'Ask FryDay…' : 'Describe the task…'}
          className={clsx(controlClass(), 'min-w-0 flex-1')}
        />
        <Button onClick={handleSend} disabled={!input.trim() || sending} icon={<Send className="h-4 w-4" aria-hidden />}>
          {sending ? 'Sending…' : 'Send'}
        </Button>
      </div>

      {mode === 'task' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input ref={filePicker} type="file" multiple accept=".md,.markdown,.txt,.pdf" className="hidden" aria-label="Attach files"
            onChange={(e) => { setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])].slice(0, 5)); e.target.value = ''; }} />
          <Button size="sm" variant="secondary" onClick={() => filePicker.current?.click()} icon={<Paperclip className="h-3.5 w-3.5" aria-hidden />}>
            Attach a PRD or notes (.md, .txt, .pdf)
          </Button>
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-full border border-hud-cyan/40 px-2.5 py-1 text-xs text-hud-cyan">
              <span className="font-mono">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((prev) => prev.filter((_, n) => n !== i))}><X className="h-3 w-3" aria-hidden /></button>
            </span>
          ))}
          {repoId && (
            <input value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Existing branch to continue"
              placeholder="Continue an existing branch (optional)"
              className={clsx(controlClass(), '!w-72 ml-auto font-mono text-xs')} />
          )}
        </div>
      )}
    </div>
  );
}
