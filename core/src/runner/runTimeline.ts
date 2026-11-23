/**
 * An agent run's steps, read from its log for the Agents page: what it read, edited and ran,
 * the MCP tools it used and what it said. Paged by byte offset so a long log is never read
 * whole. Tool output is never returned: a command's step carries its exit code only, and
 * everything shown of the agent's own words is cleaned of secret-looking text.
 */

import fs from 'fs';
import { parseLine } from './streamParser.js';
import { shortenPaths, toolHint } from './runEvents.js';
import { BROWSER_SERVER, SERVICE_SERVER } from '../verify/tools.js';
import { redactSecrets } from '../secretPatterns.js';

export type StepKind = 'read' | 'search' | 'edit' | 'command' | 'mcp' | 'web' | 'message' | 'other' | 'finished';

export interface TimelineStep {
  /** Stable across pages: the byte offset of the log line, and the block's place in it. */
  id: string;
  at: number | null;
  kind: StepKind;
  /** The tool, as the technical view names it ("Bash", "service · request"). Null for a message. */
  tool: string | null;
  /** What it was about: a path, command or query, shortened. */
  hint: string;
  /** For a message: what the agent said. */
  text?: string;
  /** Set once the tool's result is in the log. */
  ok?: boolean;
  /** For a command: its exit code, when it can be told. */
  exitCode?: number | null;
}

export interface TimelinePage {
  steps: TimelineStep[];
  /** Where the next page starts. While the run is live this may repeat steps still waiting for their result. */
  cursor: number;
  /** Whether the log already holds more than this page. */
  more: boolean;
}

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Glob', 'Grep', 'LS']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const TEXT_CHARS = 1200;
const READ_WINDOW = 2_000_000;
const LOOKAHEAD = 256 * 1024;

export function kindOfTool(name: string): StepKind {
  if (name === 'Bash') return 'command';
  if (READ_TOOLS.has(name)) return 'read';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (WEB_TOOLS.has(name)) return 'web';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/** `mcp__server__tool` → `server · tool`; other names as they are. */
export function toolLabel(name: string): string {
  const m = name.match(/^mcp__([^_]+(?:[-_][^_]+)*?)__(.+)$/);
  if (!m) return name;
  const [, server, tool] = m;
  if (server === BROWSER_SERVER) return tool!.replace(/^browser_/, '').replace(/_/g, ' ');
  if (server === SERVICE_SERVER) return tool === 'request' ? 'request' : 'service log';
  return `${server} · ${tool}`;
}

const clean = (text: string) => redactSecrets(shortenPaths(text));

/** The text of a tool result, only to read an exit code from it; never returned. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n');
  return '';
}

function exitCodeOf(isError: boolean, content: unknown): number | null {
  if (!isError) return 0;
  const m = resultText(content).match(/\bexit(?:ed with)? code:? (\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * The steps in `text`, which starts at byte `base` of the log. Stops adding steps after
 * `limit`, then reads a little further only to fill in results of the steps it has.
 */
export function stepsFromLog(text: string, base: number, limit: number, atEof: boolean, live: boolean): TimelinePage {
  const steps: TimelineStep[] = [];
  const pending = new Map<string, { step: TimelineStep; line: number }>();
  let offset = base;
  let consumed = base;
  let full: number | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineStart = offset;
    const isLast = i === lines.length - 1;
    // The last piece has no newline after it: unless the file ends there, it may be cut.
    if (isLast && !atEof) break;
    offset += Buffer.byteLength(line, 'utf8') + (isLast ? 0 : 1);
    if (full !== null && (pending.size === 0 || offset - full > LOOKAHEAD)) break;
    const event = parseLine(line) as Record<string, any> | null;
    if (!event) { if (full === null) consumed = offset; continue; }
    const at = typeof event['timestamp'] === 'string' ? Date.parse(event['timestamp']) || null : null;

    if (event['type'] === 'user' && Array.isArray(event['message']?.content)) {
      for (const c of event['message'].content) {
        if (c?.type !== 'tool_result' || !pending.has(c.tool_use_id)) continue;
        const { step } = pending.get(c.tool_use_id)!;
        pending.delete(c.tool_use_id);
        step.ok = !c.is_error;
        if (step.kind === 'command') step.exitCode = exitCodeOf(Boolean(c.is_error), c.content);
      }
    } else if (full === null && event['type'] === 'assistant' && Array.isArray(event['message']?.content)) {
      event['message'].content.forEach((c: any, n: number) => {
        const id = `${lineStart}.${n}`;
        if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
          const said = clean(c.text.trim());
          steps.push({ id, at, kind: 'message', tool: null, hint: '', text: said.length > TEXT_CHARS ? `${said.slice(0, TEXT_CHARS)}…` : said });
        } else if (c?.type === 'tool_use' && typeof c.name === 'string') {
          const step: TimelineStep = { id, at, kind: kindOfTool(c.name), tool: toolLabel(c.name), hint: redactSecrets(toolHint(c.input)) };
          steps.push(step);
          if (typeof c.id === 'string') pending.set(c.id, { step, line: lineStart });
        }
      });
    } else if (full === null && event['type'] === 'result') {
      steps.push({ id: `${lineStart}.0`, at, kind: 'finished', tool: null, hint: '', ok: !event['is_error'] });
    }
    if (full === null) {
      consumed = offset;
      if (steps.length >= limit) full = offset;
    }
  }
  let cursor = full ?? consumed;
  // At the live end of the log, come back for steps whose result has not arrived yet.
  if (full === null && atEof && live && pending.size > 0) cursor = Math.min(...[...pending.values()].map((p) => p.line));
  return { steps, cursor, more: full !== null || !atEof };
}

/** One page of a run's steps from byte `cursor` of its log. */
export function runTimeline(logPath: string, cursor = 0, limit = 100, live = false): TimelinePage {
  let size: number;
  try { size = fs.statSync(logPath).size; } catch { return { steps: [], cursor: 0, more: false }; }
  const start = Math.max(0, Math.min(cursor, size));
  const length = Math.min(size - start, READ_WINDOW);
  if (length <= 0) return { steps: [], cursor: start, more: false };
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(logPath, 'r');
  try { fs.readSync(fd, buf, 0, length, start); } finally { fs.closeSync(fd); }
  return stepsFromLog(buf.toString('utf8'), start, Math.max(1, limit), start + length >= size, live);
}

export interface RunLogSummary {
  filesEdited: string[];
  filesRead: number;
  commands: Array<{ hint: string; exitCode: number | null | undefined }>;
  mcpCalls: number;
  steps: number;
}

/** What a whole run did, from its log, in at most a few windows. */
export function summarizeRunLog(logPath: string, maxCommands = 100): RunLogSummary {
  const edited = new Set<string>();
  const read = new Set<string>();
  const commands: RunLogSummary['commands'] = [];
  let mcpCalls = 0;
  let steps = 0;
  let cursor = 0;
  for (let pages = 0; pages < 50; pages++) {
    const page = runTimeline(logPath, cursor, 500);
    for (const s of page.steps) {
      steps += 1;
      if (s.kind === 'edit' && s.hint) edited.add(s.hint);
      else if (s.kind === 'read' && s.hint) read.add(s.hint);
      else if (s.kind === 'command') commands.push({ hint: s.hint, exitCode: s.exitCode });
      else if (s.kind === 'mcp') mcpCalls += 1;
    }
    if (!page.more || page.cursor <= cursor) break;
    cursor = page.cursor;
  }
  return { filesEdited: [...edited].sort(), filesRead: read.size, commands: commands.slice(-maxCommands), mcpCalls, steps };
}
