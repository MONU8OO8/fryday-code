/** One task: the team strip, the journey line, what is happening now, the team chat, and a reply box. */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { useCoreApi, useSse } from '../hooks/useSse';
import { useThrottle } from '../hooks/useThrottle';
import type { TaskStory } from '../storyTypes';
import { ACTORS, ago, readError } from '../plain';
import { fmtTokens } from '../agents';
import JourneyLine from '../components/JourneyLine';
import TeamChat from '../components/TeamChat';
import TeamStrip from '../components/TeamStrip';
import { Avatar, Button, EmptyState, PageHeader, buttonClass, cardClass, controlClass } from '../ui';

export default function TaskView({ id }: { id: string }) {
  const api = useCoreApi();
  const [story, setStory] = useState<TaskStory | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');

  const load = useCallback(() => api.get(`/tasks/${encodeURIComponent(id)}/story`).then((s: TaskStory) => { setStory(s); setError(''); }).catch((e) => setError(readError(e))), [id]);
  useEffect(() => { setStory(null); void load(); }, [load]);
  const refresh = useThrottle(() => void load(), 1200);
  useSse('/api/events', (ev) => { if (ev['taskId'] === id) refresh(); }, [id]);

  const act = async (work: () => Promise<unknown>, failure?: string) => {
    setBusy(true); setError('');
    try { await work(); await load(); } catch (e) { setError(failure ?? readError(e)); } finally { setBusy(false); }
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    const body = reply.trim();
    if (!body) return;
    void act(async () => { await api.post(`/tasks/${encodeURIComponent(id)}/messages`, { body }); setReply(''); });
  };

  if (!story) {
    return (
      <div className={clsx(cardClass('md'), 'h-full')}>
        <Link to="/home" className="md:hidden text-sm text-hud-cyan">← All tasks</Link>
        {error ? (
          <EmptyState title="Could not open this task" text={error}
            action={<Button variant="secondary" onClick={() => void load()}>Try again</Button>} />
        ) : (
          <div aria-busy="true" className="space-y-3 animate-pulse">
            <div className="h-5 w-1/2 rounded-lg bg-hud-border/60" />
            <div className="h-3 w-1/3 rounded-lg bg-hud-border/40" />
            <span className="sr-only">Loading the task…</span>
          </div>
        )}
      </div>
    );
  }
  const { task, journey, now, askAgain } = story;
  const finished = journey.finished !== null || task.state === 'deployed' || task.state === 'failed';
  return (
    <div className={clsx(cardClass('none'), 'flex flex-col h-full min-h-0 px-4 py-4 sm:px-6 sm:py-5')}>
      <Link to="/home" className="md:hidden text-sm text-hud-cyan mb-2">← All tasks</Link>
      <PageHeader title={task.title}
        subtitle={<>{task.projectName ?? 'Project not chosen yet'} · started {ago(task.createdAt)} · {fmtTokens(task.budget.usedTokens)} of {fmtTokens(task.budget.limitTokens)} tokens</>}
        actions={<Link to={`/home/${id}/details`} className={buttonClass('ghost', 'sm')}>Technical details</Link>} />
      <TeamStrip story={story} />
      <JourneyLine key={id} journey={journey} />
      {now && (
        <div className="flex items-center gap-2.5 rounded-xl bg-hud-cyan/[0.07] border border-hud-cyan/15 px-3 py-2 text-sm mb-3">
          <Avatar actor={now.actor} size="sm" />
          <span className="min-w-0"><b className="font-semibold">Right now:</b> {ACTORS[now.actor].name} — {now.text}.</span>
        </div>
      )}
      <TeamChat key={id} taskId={id} items={story.items} now={now} busy={busy}
        onAnswer={(qid, answer) => void act(() => api.post(`/tasks/${encodeURIComponent(id)}/questions/${encodeURIComponent(qid)}/answer`, { answer }))}
        onDecide={(aid, decision) => void act(() => api.post(`/approvals/${encodeURIComponent(aid)}/resolve`, { decision }))} />
      {error && <p role="alert" className="text-sm text-hud-red mt-2">{error}</p>}
      {askAgain && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-hud-amber/40 bg-hud-amber/10 px-3.5 py-2.5 mt-3 text-sm">
          <span className="flex-1 min-w-0">{askAgain === 'release' ? 'The change is ready. Ask me again when you want it put on staging.' : 'Staging was not updated. Try the deploy again?'}</span>
          <Button size="sm" disabled={busy} onClick={() => void act(() => api.post(`/tasks/${encodeURIComponent(id)}/${askAgain === 'release' ? 'approval' : 'deploy'}`, {}), 'Could not ask again. Open Technical details to see why.')}>
            {askAgain === 'release' ? 'Ask me again' : 'Try again'}
          </Button>
        </div>
      )}
      {finished ? <p className="mt-4 pt-3 border-t border-hud-border text-sm text-hud-dim">This task is finished.</p> : (
      <form onSubmit={send} className="flex gap-2 mt-4 pt-4 border-t border-hud-border">
        <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Say something to the team…" aria-label="Message to the team"
          className={clsx(controlClass(), 'flex-1 min-w-0')} />
        <Button type="submit" disabled={busy || !reply.trim()}>Send</Button>
      </form>
      )}
    </div>
  );
}
