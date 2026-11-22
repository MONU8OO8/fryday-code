/**
 * Plain words for the simple UI: who the agents are and what they are doing, said to
 * someone who is not a developer. No paths, no tool names.
 */

export type Actor = 'understander' | 'planner' | 'builder' | 'checks' | 'checker' | 'app_tester' | 'page_tester' | 'releaser' | 'fryday' | 'you';

export const ACTOR_NAME: Record<Actor, string> = {
  understander: 'Understander', planner: 'Planner', builder: 'Builder', checks: 'Automatic checks', checker: 'Checker',
  app_tester: 'App tester', page_tester: 'Page tester', releaser: 'Releaser', fryday: 'FryDay', you: 'You',
};

const OF_ROLE: Record<string, Actor> = {
  analyst: 'understander', planner: 'planner', coder: 'builder', tester: 'checker', reviewer: 'checker',
  api_tester: 'app_tester', ui_tester: 'page_tester', fryday: 'fryday', system: 'fryday', owner: 'you',
};

export function actorOfRole(role: string): Actor {
  return OF_ROLE[role] ?? 'fryday';
}

/** One line, at most `max` characters. */
export function clip(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const LINK_WORDS = 'the link on the Who did what page';

/** Sentence punctuation after a URL stays outside it; a closing ")" stays only if the URL opens one. */
function urlCore(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    const opens = (url.slice(0, end).match(/\(/g) ?? []).length;
    const closes = (url.slice(0, end).match(/\)/g) ?? []).length;
    if (/[.,;:!?]/.test(ch) || (ch === ')' && closes > opens)) end -= 1;
    else break;
  }
  return url.slice(0, end);
}

/** Paths become their last part: "src/cart/total.js" → "total.js". A test-data tool name becomes "the app". A web address becomes a pointer, never its path. */
export function plainText(text: string): string {
  return text
    .replace(/\bmcp__[\w-]+/g, 'the app')
    .replace(/\bhttps?:\/\/\S+/g, (url) => LINK_WORDS + url.slice(urlCore(url).length))
    .replace(/(?:[\w.@~-]+\/)+([\w.@-]+)/g, '$1');
}

const CHECK_WORDS: Record<string, string> = { test: 'the tests', lint: 'the style check', typecheck: 'the type check' };
export function checkName(name: string): string {
  return CHECK_WORDS[name] ?? 'a check';
}

/** "src/cart/total.js" → "total". Never a path. */
function placeName(hint: string): string {
  const token = hint.trim().split(/\s+/)[0] ?? '';
  const last = token.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 40);
}

/** What an agent is doing now, from its latest tool calls. */
export function doingText(tools: string[], toolInputs: string[], text: string): string {
  const i = tools.length - 1;
  if (i < 0) return text.trim() ? 'Thinking it through' : 'Getting started';
  const tool = tools[i]!;
  const hint = toolInputs[i] ?? '';
  const place = placeName(hint);
  const code = place ? `the ${place} code` : 'the code';
  if (tool.startsWith('mcp__fryday_service__')) return 'Trying the app';
  if (tool.startsWith('mcp__fryday_browser__')) return 'Using the pages in a browser';
  if (tool.startsWith('mcp__')) return 'Looking at the test data';
  switch (tool) {
    case 'Read':
    case 'LS':
      return `Reading ${code}`;
    case 'Grep':
    case 'Glob':
      return 'Searching the code';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Changing ${code}`;
    case 'Bash': {
      const cmd = hint.toLowerCase();
      if (/\b(test|jest|vitest|mocha|pytest)\b/.test(cmd)) return 'Running the tests';
      if (/\b(lint|eslint)\b/.test(cmd)) return 'Running the style check';
      if (/\b(tsc|typecheck)\b/.test(cmd)) return 'Running the type check';
      if (/\b(install|ci)\b/.test(cmd)) return 'Installing what the project needs';
      return 'Running a command';
    }
    case 'StructuredOutput':
      return 'Writing up the result';
    default:
      return 'Working on it';
  }
}

export function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export const capital = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

export const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** A token count in a few characters: 950, 12.3k, 1.2M. The one way core writes tokens. */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  const short = (x: number, unit: string) => `${x >= 100 ? Math.round(x) : Number(x.toFixed(1))}${unit}`;
  if (v < 1000) return String(v);
  if (v < 999_500) return short(v / 1000, 'k');
  return short(v / 1_000_000, 'M');
}
