/**
 * One task: the team strip, the journey line, what is happening now (or what is waiting for
 * you), the team chat, and a reply box. While a question is open the reply box answers it; when
 * the task stopped at the round limit it becomes the decision: try again, or accept it as it is.
 */

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
  // The question the reply box answers while one is open and takes a written answer.
  const asked = (story?.items ?? []).map((i) => i.action).filter((a): a is Extract<NonNullable<typeof a>, { kind: 'answer' }> => a?.kind === 'answer');
  const openQuestion = asked[asked.length - 1] ?? null;
  const send = (e: FormEvent) => {
    e.preventDefault();
    const body = reply.trim();
    if (!body) return;
    void act(async () => {
      if (openQuestion?.freeText) await api.post(`/tasks/${encodeURIComponent(id)}/questions/${encodeURIComponent(openQuestion.questionId)}/answer`, { answer: body });
      else await api.post(`/tasks/${encodeURIComponent(id)}/messages`, { body });
      setReply('');
    });
  };
  const tryAgain = () => void act(async () => { await api.post(`/tasks/${encodeURIComponent(id)}/try-again`, { note: reply.trim() }); setReply(''); });
  const accept = () => void act(() => api.post(`/tasks/${encodeURIComponent(id)}/accept`, {}));
  const stop = () => {
    if (!window.confirm('Stop this task? Agents stop and open questions are withdrawn. Nothing already done is undone, and a build already running in Jenkins keeps running there.')) return;
    void act(() => api.post(`/tasks/${encodeURIComponent(id)}/stop`, {}));
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
  const choices = story.choices?.tryAgain ? story.choices : null;
  // Work that can still go back to the Builder is not finished, wherever its journey has got to.
  const finished = !choices && !story.canSendBack && (journey.finished !== null || task.state === 'deployed' || task.state === 'failed' || story.discarded === true);
  const pendingApproval = story.items.some((i) => i.action?.kind === 'approve');
  const yourTurn = now ? null
    : openQuestion ? 'answer the question below. You can tap an answer or type your own in the box at the bottom.'
    : pendingApproval ? 'press Approve or Not yet on the card below. Nothing is pushed until you approve.'
    : choices ? 'the team could not finish on its own. Decide how to go on at the bottom.'
    : null;
  return (
    <div className={clsx(cardClass('none'), 'flex flex-col h-full min-h-0 px-4 py-4 sm:px-6 sm:py-5')}>
      <Link to="/home" className="md:hidden text-sm text-hud-cyan mb-2">← All tasks</Link>
      <PageHeader title={<span title={task.title} className="line-clamp-2 break-words">{task.title}</span>}
        subtitle={<>{task.projectName ?? 'Project not chosen yet'} · started {ago(task.createdAt)} · {fmtTokens(task.budget.usedTokens)} of {fmtTokens(task.budget.limitTokens)} tokens</>}
        actions={<>
          {story.canStop && <Button variant="danger" size="sm" disabled={busy} onClick={stop}>Stop</Button>}
          <Link to={`/home/${id}/details`} className={buttonClass('ghost', 'sm')}>Technical details</Link>
        </>} />
      <TeamStrip story={story} />
      <JourneyLine key={id} journey={journey} />
      {now && (
        <div className="flex items-center gap-2.5 rounded-xl bg-hud-cyan/[0.07] border border-hud-cyan/15 px-3 py-2 text-sm mb-3">
          <Avatar actor={now.actor} size="sm" />
          <span className="min-w-0"><b className="font-semibold">Right now:</b> {ACTORS[now.actor].name} — {now.text}.</span>
        </div>
      )}
      {yourTurn && (
        <div role="status" className="flex items-center gap-2.5 rounded-xl bg-hud-amber/10 border border-hud-amber/40 px-3 py-2 text-sm mb-3">
          <Avatar actor="you" size="sm" />
          <span className="min-w-0"><b className="font-semibold">Your turn:</b> {yourTurn}</span>
        </div>
      )}
      <TeamChat key={id} taskId={id} items={story.items} now={now} busy={busy} answeredBelow={openQuestion?.freeText ? openQuestion.questionId : null}
        onAnswer={(qid, answer) => void act(() => api.post(`/tasks/${encodeURIComponent(id)}/questions/${encodeURIComponent(qid)}/answer`, { answer }))}
        onDecide={(aid, decision) => void act(() => api.post(`/approvals/${encodeURIComponent(aid)}/resolve`, { decision }))}
        onStartTask={(mid) => void act(() => api.post(`/tasks/${encodeURIComponent(id)}/proposals/${mid}/start`, {}))} />
      {error && <p role="alert" className="text-sm text-hud-red mt-2">{error}</p>}
      {askAgain && !now && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-hud-amber/40 bg-hud-amber/10 px-3.5 py-2.5 mt-3 text-sm">
          <span className="flex-1 min-w-0">{askAgain === 'release' ? 'The change is ready. Ask me again when you want it put on staging.' : 'The staging server was not updated. Try the deploy again?'}</span>
          <Button size="sm" disabled={busy} onClick={() => void act(() => api.post(`/tasks/${encodeURIComponent(id)}/${askAgain === 'release' ? 'approval' : 'deploy'}`, {}))}>
            {askAgain === 'release' ? 'Ask me again' : 'Deploy again'}
          </Button>
        </div>
      )}
      {choices ? (
        <form onSubmit={(e) => { e.preventDefault(); tryAgain(); }} className="mt-3 rounded-xl border border-hud-amber/40 bg-hud-amber/10 px-3 py-2.5 text-sm shrink-0">
          <div className="flex gap-2">
            <input value={reply} onChange={(e) => setReply(e.target.value)} aria-label="What the team should do differently"
              placeholder="Optional: what to do differently, e.g. “skip the lint check”"
              className={clsx(controlClass(), 'flex-1 min-w-0')} />
            <Button type="submit" disabled={busy}>Try again</Button>
          </div>
          {choices.accept && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2">
              <Button variant="success" size="sm" disabled={busy} onClick={accept}>Accept it as it is</Button>
              <span className="text-xs text-hud-dim">You still approve before anything is pushed.</span>
            </div>
          )}
        </form>
      ) : finished ? (
        <p className="mt-4 pt-3 border-t border-hud-border text-sm text-hud-dim">
          {story.discarded ? <>This task's work was discarded. <Link to="/home" className="text-hud-cyan underline">Start a new task</Link> to try again.</> : 'This task is finished.'}
        </p>
      ) : (
      <form onSubmit={send} className="mt-4 pt-4 border-t border-hud-border">
        <div className="flex gap-2">
          <input value={reply} onChange={(e) => setReply(e.target.value)}
            placeholder={openQuestion?.freeText ? 'Type your answer to the question above…' : 'Ask the team anything, or tell them what to change…'}
            aria-label={openQuestion?.freeText ? 'Your answer' : 'Message to the team'}
            className={clsx(controlClass(), 'flex-1 min-w-0')} />
          <Button type="submit" disabled={busy || !reply.trim()}>{openQuestion?.freeText ? 'Answer' : 'Send'}</Button>
        </div>
        {!openQuestion && <p className="mt-1.5 text-xs text-hud-dim">FryDay reads it and answers here. If you ask for a change, it sends the work back to the Builder{story.canSendBack ? '' : ' once nothing else is running'}.</p>}
      </form>
      )}
    </div>
  );
}
