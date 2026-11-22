/**
 * Turns raw claude stream events into the small messages the UI needs.
 * Raw events stay in the run's JSONL log; only these summaries go over SSE.
 */

import fs from 'fs';
import os from 'os';
import { parseLine, type ClaudeAssistantEvent, type ClaudeEvent, type ClaudeInitEvent, type ClaudeResultEvent } from './streamParser.js';

export type RunEventSummary =
  | { kind: 'init'; sessionId: string; model: string }
  | { kind: 'assistant'; text: string; tools: string[]; toolInputs: string[]; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } }
  | {
      kind: 'result';
      isError: boolean;
      text: string;
      sessionId: string;
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number };
    };

/** Returns null for events the UI does not show (hooks, rate-limit notices, tool results). */
export function summarizeEvent(event: ClaudeEvent): RunEventSummary | null {
  const e = event as Record<string, unknown>;

  if (e['type'] === 'system' && e['subtype'] === 'init') {
    const init = event as ClaudeInitEvent;
    return { kind: 'init', sessionId: init.session_id, model: init.model };
  }

  if (e['type'] === 'assistant') {
    const content = (event as ClaudeAssistantEvent).message?.content ?? [];
    const text = content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n').trim();
    const tools = content.flatMap((c) => (c.type === 'tool_use' ? [c.name] : []));
    if (!text && tools.length === 0) return null;
    const u = (event as ClaudeAssistantEvent).message?.usage;
    return {
      kind: 'assistant',
      text: text.slice(0, 600),
      tools,
      // What each tool call was about, in a few words, for the live view.
      toolInputs: content.flatMap((c) => (c.type === 'tool_use' ? [toolHint(c.input)] : [])),
      usage: {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cacheReadTokens: u?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
      },
    };
  }

  if (e['type'] === 'result') {
    const r = event as ClaudeResultEvent;
    return {
      kind: 'result',
      isError: Boolean(r.is_error),
      text: typeof r.result === 'string' ? r.result : '',
      sessionId: r.session_id,
      usage: {
        inputTokens: r.usage?.input_tokens ?? 0,
        outputTokens: r.usage?.output_tokens ?? 0,
        cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: r.usage?.cache_creation_input_tokens ?? 0,
        costUsd: r.total_cost_usd ?? 0,
      },
    };
  }

  return null;
}

/**
 * Paths as the agent sees its own folder: the task's workspace prefix (and any other
 * path under the home folder) shortened, so the useful end of the path shows.
 */
export function shortenPaths(text: string, home = os.homedir()): string {
  return text
    // <state>/worktrees/T-1/<repo>[.review|.verify|...]/x → x
    // (the folder itself, with nothing after it, becomes ".")
    .replace(/\/[^\s'"]*?\/worktrees\/T-\d+\/[^/\s'"]+(\/|(?=[\s'"]|$))/g, (_m, slash: string) => (slash === '/' ? '' : '.'))
    .split(home).join('~');
}

const HINT_KEYS = ['path', 'file_path', 'pattern', 'url', 'command', 'query', 'sql', 'element', 'text', 'description', 'function'];
const HINT_CHARS = 90;

/**
 * A few words about what a tool call was for: the path, address, command or query. The
 * live view shows it next to the tool name. Never a file's content.
 */
export function toolHint(input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== 'object') return '';
  for (const key of HINT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      const flat = shortenPaths(value.replace(/\s+/g, ' ').trim());
      return flat.length > HINT_CHARS ? `${flat.slice(0, HINT_CHARS)}…` : flat;
    }
  }
  return '';
}

/** The summaries of a run's log, newest last, at most `max` of them. Reads only the end of a long log. */
export function recentActivity(logPath: string, max = 40, readBytes = 1_000_000): RunEventSummary[] {
  let text = '';
  try {
    const size = fs.statSync(logPath).size;
    const fd = fs.openSync(logPath, 'r');
    try {
      const length = Math.min(size, readBytes);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      text = buf.toString('utf8');
      if (length < size) text = text.slice(text.indexOf('\n') + 1); // the first line may be cut
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: RunEventSummary[] = [];
  for (const line of text.split('\n')) {
    const event = parseLine(line);
    const summary = event ? summarizeEvent(event) : null;
    if (summary && summary.kind === 'assistant') out.push(summary);
  }
  return out.slice(-max);
}
