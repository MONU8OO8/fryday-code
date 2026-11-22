/**
 * What an owner's message in the Chat space asks for. Pure: text in, command out.
 *
 * In the space itself (not in a task's thread):
 *   task: <title>              a new task; lines after the first are its description,
 *   <more lines>               and a line "project: <id>" names the project
 *   status                     what each open task is doing
 *   help                       what can be said here
 *
 * In a task's thread:
 *   approve 123456             approve the decision that is waiting, with its one-time code
 *   decline 123456             decline it, with its code
 *   go ahead                   go on without answering the open questions
 *   2: <answer>                answer question 2 (a plain message answers the only open question)
 *   note: <text>               tell the agents something (so does any other message)
 *   status · help
 */

export type Command =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'new_task'; title: string; description: string; project: string | null }
  | { kind: 'approve'; code: string }
  | { kind: 'decline'; code: string }
  | { kind: 'missing_code'; decision: 'approve' | 'decline' }
  | { kind: 'go_ahead' }
  | { kind: 'answer'; index: number | null; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'unknown' };

const MAX_TITLE = 120;
export const MAX_MESSAGE_CHARS = 10_000;

const clean = (s: string) => s.replace(/\r/g, '').trim();

export function parseCommand(raw: string, inTaskThread: boolean): Command {
  const text = clean(raw).slice(0, MAX_MESSAGE_CHARS);
  if (!text) return { kind: 'unknown' };
  const lower = text.toLowerCase();
  if (/^(help|\?)$/.test(lower)) return { kind: 'help' };
  if (/^status\??$/.test(lower)) return { kind: 'status' };

  if (!inTaskThread) {
    const m = text.match(/^(?:new\s+)?task\s*:\s*([\s\S]*)$/i);
    if (!m) return { kind: 'unknown' };
    const lines = m[1]!.split('\n');
    let project: string | null = null;
    const kept: string[] = [];
    for (const line of lines) {
      const p = line.match(/^\s*project\s*:\s*([a-z0-9][a-z0-9._-]{0,63})\s*$/i);
      if (p && project === null) project = p[1]!.toLowerCase();
      else kept.push(line);
    }
    const body = kept.join('\n').trim();
    if (!body) return { kind: 'unknown' };
    const [first, ...rest] = body.split('\n');
    const titleLine = first!.trim();
    const title = titleLine.length > MAX_TITLE ? `${titleLine.slice(0, MAX_TITLE - 1)}…` : titleLine;
    // The description is everything that was said; a long first line is kept whole there.
    const description = (titleLine.length > MAX_TITLE ? body : rest.join('\n').trim()) || titleLine;
    return { kind: 'new_task', title, description, project };
  }

  const decision = text.match(/^(approve|approved|yes|decline|declined|reject|no)\b[\s:,-]*(\d{6})?\s*$/i);
  if (decision) {
    const approve = /^(approve|approved|yes)$/i.test(decision[1]!);
    const code = decision[2];
    if (!code) return { kind: 'missing_code', decision: approve ? 'approve' : 'decline' };
    return approve ? { kind: 'approve', code } : { kind: 'decline', code };
  }
  if (/^(go ahead|go on|skip( the)? questions?|proceed without answers?)[.!]?$/i.test(text)) return { kind: 'go_ahead' };
  const numbered = text.match(/^(?:answer\s*)?(\d{1,2})\s*[:.)]\s*([\s\S]+)$/i);
  if (numbered) return { kind: 'answer', index: Number(numbered[1]), text: numbered[2]!.trim() };
  const answer = text.match(/^answer\s*:\s*([\s\S]+)$/i);
  if (answer) return { kind: 'answer', index: null, text: answer[1]!.trim() };
  const note = text.match(/^note\s*:\s*([\s\S]+)$/i);
  if (note) return { kind: 'note', text: note[1]!.trim() };
  // Anything else: an answer when exactly one question is open, else a note (decided by the caller).
  return { kind: 'answer', index: null, text };
}

export const HELP_TEXT = [
  'What you can say here:',
  '• `task: <what to do>` — a new task. More lines are its description; add a line `project: <id>` to name the project.',
  '• `status` — what the open tasks are doing.',
  'In a task\'s thread:',
  '• `approve 123456` / `decline 123456` — the decision that is waiting, with the code from its message.',
  '• `go ahead` — go on without answering the open questions.',
  '• `2: <answer>` — answer question 2; a plain message answers the only open question.',
  '• `note: <text>` — tell the agents something; any other message does too.',
].join('\n');
