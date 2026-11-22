/**
 * The parts of a task's page that come from intake: the Understander's brief, the questions
 * waiting for the owner, the documents attached, and the thread.
 */

import { useState, type FormEvent } from 'react';
import { HelpCircle, Paperclip, Send } from 'lucide-react';
import clsx from 'clsx';
import { Button, Card, Field, Section, controlClass } from '../ui';

export interface Brief {
  summary: string;
  requirements: string[];
  areas: string[];
  assumptions: string[];
  risks: string[];
}
export interface Question {
  id: string;
  kind: 'clarify' | 'project' | 'branch';
  question: string;
  why: string | null;
  options: Array<{ value: string; label: string }>;
  answer: string | null;
  askedBy: string;
}
export interface Attachment {
  id: string;
  name: string;
  media: string;
  bytes: number;
}
export interface Message {
  id: number;
  author: string;
  kind: 'note' | 'question' | 'answer' | 'event';
  body: string;
  created_at: number;
}

const SUB = 'mb-0.5 text-xs font-semibold text-hud-dim';

function List({ title, items, tone = 'text-hud-bright' }: { title: string; items: string[]; tone?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <h3 className={SUB}>{title}</h3>
      <ul className={clsx('list-disc space-y-0.5 pl-5 text-sm', tone)}>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

export function BriefCard({ brief, attachments }: { brief: Brief | null; attachments: Attachment[] }) {
  if (!brief && attachments.length === 0) return null;
  return (
    <Section title="What is being asked" card className="mb-3">
      {brief && (
        <>
          <p className="text-sm text-hud-bright">{brief.summary}</p>
          {brief.requirements.length > 0 && (
            <div className="mt-3">
              <h3 className={SUB}>Requirements</h3>
              <ol className="list-decimal space-y-0.5 pl-5 text-sm text-hud-bright">
                {brief.requirements.map((r) => <li key={r}>{r}</li>)}
              </ol>
            </div>
          )}
          <List title="Assumptions the Understander made (say so if one is wrong)" items={brief.assumptions} tone="text-hud-amber" />
          <List title="Risks" items={brief.risks} tone="text-hud-amber" />
          {brief.areas.length > 0 && <div className="mt-3 break-all font-mono text-xs text-hud-dim">touches {brief.areas.join(' · ')}</div>}
        </>
      )}
      {attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 text-xs">
          {attachments.map((a) => (
            <span key={a.id} className="flex items-center gap-1 rounded-full border border-hud-border px-2 py-0.5 text-hud-dim">
              <Paperclip className="h-3 w-3" aria-hidden /> <span className="font-mono">{a.name}</span> <span>{Math.max(1, Math.round(a.bytes / 1024))} KB</span>
            </span>
          ))}
        </div>
      )}
    </Section>
  );
}

function OneQuestion({ q, busy, onAnswer }: { q: Question; busy: boolean; onAnswer: (id: string, answer: string) => void }) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) onAnswer(q.id, text.trim());
  };
  return (
    <div className="mt-3 border-t border-hud-border pt-3 first:mt-0 first:border-t-0 first:pt-0">
      <div className="text-sm font-medium text-hud-bright">{q.question}</div>
      {q.why && <div className="mt-0.5 text-xs text-hud-dim">{q.why}</div>}
      {q.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {q.options.map((o) => (
            <Button key={o.value} size="sm" variant="secondary" disabled={busy} onClick={() => onAnswer(q.id, o.value)}>{o.label}</Button>
          ))}
        </div>
      )}
      {q.kind === 'clarify' && (
        <form onSubmit={submit} className="mt-2 flex items-end gap-2">
          <Field label={`Answer: ${q.question}`} hideLabel wrapperClassName="flex-1" value={text} onChange={(e) => setText(e.target.value)}
            placeholder={q.options.length > 0 ? 'Or answer in your own words' : 'Your answer'} />
          <Button type="submit" disabled={busy || !text.trim()}>Answer</Button>
        </form>
      )}
    </div>
  );
}

/** Questions the task is waiting on. Work goes on when the last one is answered. */
export function QuestionsCard({ questions, busy, onAnswer, onSkip }: {
  questions: Question[];
  busy: boolean;
  onAnswer: (id: string, answer: string) => void;
  onSkip: () => void;
}) {
  const open = questions.filter((q) => q.answer === null);
  if (open.length === 0) return null;
  const canSkip = open.every((q) => q.kind === 'clarify');
  return (
    <Card padding="sm" className="mb-3 border-hud-amber/60 p-4">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-hud-amber">
        <HelpCircle className="h-4 w-4" aria-hidden /> {open.length === 1 ? 'A question for you' : `${open.length} questions for you`}
        <span className="font-normal text-hud-dim">· nothing is built until you answer</span>
      </h2>
      {open.map((q) => <OneQuestion key={q.id} q={q} busy={busy} onAnswer={onAnswer} />)}
      {canSkip && (
        <Button variant="ghost" size="sm" className="mt-3" disabled={busy} onClick={onSkip}>
          Go ahead without answers (the agents state what they assumed)
        </Button>
      )}
    </Card>
  );
}

const AUTHOR: Record<string, { name: string; color: string }> = {
  owner: { name: 'You', color: 'text-hud-bright' },
  fryday: { name: 'FryDay', color: 'text-hud-dim' },
  analyst: { name: 'Understander', color: 'text-hud-cyan' },
  planner: { name: 'Planner', color: 'text-hud-cyan' },
  coder: { name: 'Builder', color: 'text-hud-cyan' },
  tester: { name: 'Checker', color: 'text-hud-cyan' },
  api_tester: { name: 'App tester', color: 'text-hud-cyan' },
  ui_tester: { name: 'Page tester', color: 'text-hud-cyan' },
};

/** Everything said and done on the task, oldest first, and a box to tell the agents something. */
export function ThreadCard({ messages, busy, onSay }: { messages: Message[]; busy: boolean; onSay: (body: string) => void }) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSay(text.trim());
    setText('');
  };
  return (
    <Section title="Thread" card className="mb-3">
      <div className="max-h-72 space-y-1.5 overflow-y-auto text-sm" role="log" aria-label="Everything said and done on this task">
        {messages.length === 0 && <p className="text-hud-dim">Nothing yet.</p>}
        {messages.map((m) => {
          const who = AUTHOR[m.author] ?? { name: m.author, color: 'text-hud-cyan' };
          return (
            <div key={m.id} className="flex items-start gap-2">
              <span className="flex-shrink-0 text-xs leading-5 tabular-nums text-hud-dim">{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span className={clsx('w-24 flex-shrink-0 text-xs font-semibold leading-5', who.color)}>{who.name}</span>
              <span className={clsx('flex-1 whitespace-pre-wrap break-words',
                m.kind === 'question' ? 'text-hud-amber' : m.kind === 'event' ? 'text-hud-dim' : 'text-hud-bright')}>{m.body}</span>
            </div>
          );
        })}
      </div>
      <form onSubmit={submit} className="mt-3 flex gap-2">
        <input className={controlClass()} value={text} onChange={(e) => setText(e.target.value)} aria-label="Tell the agents something"
          placeholder="Tell the agents something. The next one to start reads it." />
        <Button type="submit" disabled={busy || !text.trim()} aria-label="Send" icon={<Send className="h-4 w-4" aria-hidden />} />
      </form>
    </Section>
  );
}
