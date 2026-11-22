/**
 * The team chat: what the agents said to each other and to you, oldest first. Questions and
 * approvals are cards with buttons. Only messages that arrive while the page is open slide in.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import type { StoryItem, StoryNow } from '../storyTypes';
import { ACTORS } from '../plain';
import { Avatar, Button, controlClass } from '../ui';

interface Props {
  taskId: string;
  items: StoryItem[];
  now: StoryNow | null;
  busy: boolean;
  /** The question the reply box under the chat answers: its card shows no box of its own. */
  answeredBelow?: string | null;
  onAnswer: (questionId: string, answer: string) => void;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => void;
}

export default function TeamChat({ taskId, items, now, busy, answeredBelow = null, onAnswer, onDecide }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const seen = useRef<Set<string> | null>(null);
  const stick = useRef(true);
  if (seen.current === null) seen.current = new Set(items.map((i) => i.id));
  const fresh = new Set(items.filter((i) => !seen.current!.has(i.id)).map((i) => i.id));

  useEffect(() => {
    for (const i of items) seen.current!.add(i.id);
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [items, now?.text]);

  return (
    <div ref={box} role="log" aria-live="polite" aria-label="Team chat" className="flex-1 min-h-0 overflow-y-auto space-y-2.5 pr-1"
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }}>
      {items.map((item) => (
        <ChatItem key={item.id} taskId={taskId} item={item} fresh={fresh.has(item.id)} busy={busy} answeredBelow={answeredBelow} onAnswer={onAnswer} onDecide={onDecide} />
      ))}
      {now && (
        <div className="flex gap-2 items-end chat-in">
          <Avatar actor={now.actor} />
          <div className="rounded-2xl rounded-bl-sm bg-hud-border/50 px-3 py-2 text-sm text-hud-dim">
            {ACTORS[now.actor].name} is working <span className="typing ml-1"><span /><span /><span /></span>
          </div>
        </div>
      )}
    </div>
  );
}

function ChatItem({ taskId, item, fresh, busy, answeredBelow, onAnswer, onDecide }: { taskId: string; item: StoryItem; fresh: boolean; busy: boolean } & Pick<Props, 'answeredBelow' | 'onAnswer' | 'onDecide'>) {
  const mine = item.from === 'you';
  const head = item.to && item.to !== 'you' ? `${ACTORS[item.from].name} → ${ACTORS[item.to].name}:` : `${ACTORS[item.from].name}:`;
  return (
    <div className={clsx('flex gap-2 items-end', mine && 'flex-row-reverse', fresh && 'chat-in')}>
      {/* Your own bubbles carry no name, so your avatar says it. */}
      <Avatar actor={item.from} decorative={!mine} />
      {item.action?.kind === 'approve' ? (
        <ApprovalCard item={item} action={item.action} busy={busy} onDecide={onDecide} />
      ) : item.action?.kind === 'answer' ? (
        <QuestionCard item={item} action={item.action} busy={busy} below={answeredBelow === item.action.questionId} onAnswer={onAnswer} />
      ) : (
        <div className={clsx('max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
          mine ? 'rounded-br-sm bg-hud-cyan text-hud-onaccent' : item.kind === 'sendback' ? 'rounded-bl-sm bg-hud-amber/10 border border-hud-amber/30' : item.kind === 'outcome' ? 'rounded-bl-sm bg-hud-green/10 border border-hud-green/30' : 'rounded-bl-sm bg-hud-border/50')}>
          {!mine && <span className="font-semibold mr-1">{head}</span>}
          <RichText text={item.text} />
          {item.details && (
            <Link to={`/home/${taskId}/details`} className={clsx('block mt-0.5 text-xs underline-offset-2 hover:underline', mine ? 'text-hud-onaccent/80' : 'text-hud-cyan')}>
              {item.details.label}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** Text with `code` spans shown as small code chips instead of raw backticks. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/`([^`\n]+)`/);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <code key={i} className="rounded bg-black/10 dark:bg-white/10 px-1 font-mono text-[0.85em]">{p}</code> : p))}</>;
}

function ApprovalCard({ item, action, busy, onDecide }: { item: StoryItem; action: Extract<StoryItem['action'], { kind: 'approve' }>; busy: boolean; onDecide: Props['onDecide'] }) {
  return (
    <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-hud-amber/40 bg-hud-amber/10 px-3.5 py-3 text-sm">
      <div className="font-semibold mb-1">{ACTORS[item.from].name} needs your OK</div>
      <p className="leading-relaxed">{action.plain}</p>
      <div className="flex flex-wrap items-center gap-2 mt-2.5">
        <Button variant="success" size="sm" disabled={busy} onClick={() => onDecide(action.approvalId, 'approved')}>Approve</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onDecide(action.approvalId, 'rejected')}>Not yet</Button>
      </div>
      {action.effects.length > 0 && (
        <details className="mt-2 text-xs text-hud-dim">
          <summary className="cursor-pointer text-hud-cyan">Technical details</summary>
          <ul className="mt-1 list-disc pl-4 font-mono space-y-0.5">{action.effects.map((e) => <li key={e}>{e}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function QuestionCard({ item, action, busy, below, onAnswer }: { item: StoryItem; action: Extract<StoryItem['action'], { kind: 'answer' }>; busy: boolean; below: boolean; onAnswer: Props['onAnswer'] }) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => { e.preventDefault(); if (text.trim()) onAnswer(action.questionId, text.trim()); };
  return (
    <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-hud-cyan/30 bg-hud-cyan/5 px-3.5 py-3 text-sm">
      <div className="font-semibold mb-1">{ACTORS[item.from].name} asks:</div>
      <p className="leading-relaxed"><RichText text={item.text} /></p>
      {action.options.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2.5">
          {action.options.map((o) => (
            <Button key={o.value} size="sm" disabled={busy} onClick={() => onAnswer(action.questionId, o.value)}>{o.label}</Button>
          ))}
        </div>
      )}
      {action.options.length === 0 && !action.freeText && (
        <p className="mt-2 text-hud-dim">Add and confirm a project in <Link to="/setup/projects" className="text-hud-cyan underline">Setup</Link> first.</p>
      )}
      {action.freeText && below && <p className="mt-2 text-xs text-hud-dim">{action.options.length > 0 ? 'Tap an answer, or type your own in the box at the bottom.' : 'Type your answer in the box at the bottom.'}</p>}
      {action.freeText && !below && (
        <form onSubmit={submit} className="flex gap-2 mt-2">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={action.options.length > 0 ? 'Or write your answer…' : 'Write your answer…'} aria-label="Your answer"
            className={clsx(controlClass(), 'flex-1 min-w-0')} />
          <Button type="submit" variant="secondary" size="sm" disabled={busy || !text.trim()}>Answer</Button>
        </form>
      )}
    </div>
  );
}
