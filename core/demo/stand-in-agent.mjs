#!/usr/bin/env node
// Stand-in for the `claude` CLI, for tests and for `fryday-code demo`. Emits the same
// stream-json event shapes as the real CLI and never calls a model.
//
// Simple mode (supervisor tests): behaviour from FAKE_MODE, pacing from FAKE_DELAY_MS.
// Scripted mode (pipeline tests): FAKE_PLAN_FILE points at a JSON script
//   { planner: <plan>, coder: [{ write: {path: content}, delete: [path], budget: true }, ...], tester: [<verdict>, ...],
//     analyst: [<brief>, ...], triage: [<triage>, ...] }
// The Analyst is one role doing two jobs; which one is told from the JSON schema it was given.
// Without a script entry it answers with a clear brief (no questions, no branch) or an unsure triage.
// A coder step with `budget: true` does its writes and then stops at the CLI's own money cap
// (core's hidden safety backstop, --max-budget-usd).
// A coder or tester step with `tokens: N` (or FAKE_MODE=tokens, with FAKE_TOKENS_PER_TURN) keeps
// working turn after turn, each turn using about N tokens and streamed twice under one message id
// (the second time with more output, as Claude does), until core stops it at its token limit.
// The API tester and the UI tester take { report, calls, get } steps from `api_tester` / `ui_tester`:
// `calls` is how many times they "used" their tool (reported as tool calls, default 3), and
// `get` is a path really fetched from the service under test, so a test can see it was up, and
// `shot` is the name of a screenshot file to leave behind.
// `say` (optional) maps a role or job to what it writes as its message (a string, or a list taken
// like the steps); without it the message is what the run was given, for tests to read.
// `usage` (optional) maps a role or job to the tokens each call reports ({ input_tokens,
// output_tokens, cache_read_input_tokens, cache_creation_input_tokens }, or a list taken like
// the steps); FAKE_USAGE (the same object as JSON) sets it for every call. Without either a
// call reports a few tokens, which is what the tests expect.
// `overloaded` (optional) maps a role or job to how many of its first calls fail the way the
// real CLI does when the API is overloaded (a 529); the calls after that take the steps as if
// the failed ones had not happened. FAKE_MODE=overloaded fails every call that way.
// Each role takes the next entry on each invocation (the last one repeats), and every
// invocation is appended to <FAKE_PLAN_FILE>.calls.jsonl so tests can see what it was given.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const mode = process.env.FAKE_MODE ?? 'ok';
const delay = Number(process.env.FAKE_DELAY_MS ?? '0');
const role = process.env.FRYDAY_ROLE;
const planFile = process.env.FAKE_PLAN_FILE;
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const prompt = readFileSync(0, 'utf8');
const session = '11111111-2222-4333-8444-555555555555';
const SMALL_USAGE = { input_tokens: 7, output_tokens: 11, cache_read_input_tokens: 13, cache_creation_input_tokens: 17 };
/** What the call reports in its result (the total that counts) and, a little less, while it works. */
let usage = process.env.FAKE_USAGE ? { ...SMALL_USAGE, ...JSON.parse(process.env.FAKE_USAGE) } : SMALL_USAGE;
/** What the real CLI prints when the API stays overloaded: an error result with the API's answer. */
const OVERLOADED = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
function failOverloaded() {
  emit({
    type: 'result', subtype: 'success', is_error: true, result: OVERLOADED, session_id: session,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0, num_turns: 1,
  });
  process.exit(1);
}

emit({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' });
emit({ type: 'system', subtype: 'init', session_id: session, model: 'fake-model', tools: [], mcp_servers: [] });
await sleep(delay);

if (mode === 'hang') {
  await sleep(600_000); // never finishes on its own
}

if (mode === 'overloaded') failOverloaded();

if (mode === 'crash') {
  process.stderr.write('fake-claude: boom\n');
  process.exit(3);
}

const schemaArg = argv.includes('--json-schema') ? argv[argv.indexOf('--json-schema') + 1] : '';
const job = role === 'analyst' && schemaArg.includes('"projectId"') ? 'triage' : role;
const DEFAULT_BRIEF = { summary: 'A clear task.', requirements: ['Do what the task says.'], areas: [], assumptions: [], risks: [], questions: [], continueOn: '', continueWhy: '' };
const DEFAULT_TRIAGE = { projectId: '', confidence: 'unsure', reason: 'Could not tell.' };
const taskFolder = existsSync('FRYDAY_TASK/README.md') ? readFileSync('FRYDAY_TASK/README.md', 'utf8') : undefined;

/** What the run writes as its message, from the script's `say`; undefined: what it was given. */
let said;
let structured = job === 'analyst' ? DEFAULT_BRIEF : job === 'triage' ? DEFAULT_TRIAGE : undefined;
let stopAtBudget = mode === 'budget';
/** Tokens per turn of a run that keeps going until core stops it. 0: an ordinary run. */
let turnTokens = mode === 'tokens' ? Number(process.env.FAKE_TOKENS_PER_TURN ?? '10000') : 0;
/** Tool calls to report, as the real CLI reports them. */
let toolCalls = [];
const isTester = role === 'api_tester' || role === 'ui_tester';
const verifyBrief = existsSync('FRYDAY_VERIFY/README.md') ? readFileSync('FRYDAY_VERIFY/README.md', 'utf8') : undefined;
const mcpConfig = argv.includes('--mcp-config') ? JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')) : undefined;
/** The address of the service under test, from the config core wrote for this run. */
function serviceBase() {
  const args = mcpConfig?.mcpServers?.fryday_service?.args;
  return Array.isArray(args) ? JSON.parse(readFileSync(args[1], 'utf8')).baseUrl : undefined;
}
if (planFile && existsSync(planFile)) {
  const script = JSON.parse(readFileSync(planFile, 'utf8'));
  const countFile = `${planFile}.count.json`;
  const counts = existsSync(countFile) ? JSON.parse(readFileSync(countFile, 'utf8')) : {};
  const calls = counts[job] ?? 0;
  counts[job] = calls + 1;
  writeFileSync(countFile, JSON.stringify(counts));
  // The first calls the script marks as overloaded fail; the steps start after them.
  const failing = Number(script.overloaded?.[job] ?? script.overloaded?.[role] ?? 0);
  const n = Math.max(0, calls - failing);
  const pickStep = (list) => (Array.isArray(list) && list.length ? list[Math.min(n, list.length - 1)] : undefined);
  let fetched;
  if (isTester && calls >= failing) {
    const step = pickStep(script[role]) ?? {};
    if (step.budget) stopAtBudget = true;
    if (step.tokens) turnTokens = step.tokens;
    structured = step.report;
    const tool = role === 'api_tester' ? 'mcp__fryday_service__request' : 'mcp__fryday_browser__browser_navigate';
    toolCalls = Array.from({ length: step.calls ?? 3 }, (_, i) => ({ type: 'tool_use', id: `toolu_fake_${i}`, name: tool, input: {} }));
    if (step.shot) {
      // What the browser server does when the UI tester takes a screenshot: a PNG in the brief's browser folder.
      mkdirSync('FRYDAY_VERIFY/browser', { recursive: true });
      writeFileSync(`FRYDAY_VERIFY/browser/${step.shot}`, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    }
    if (step.get) {
      try {
        const res = await fetch(`${serviceBase()}${step.get}`);
        fetched = { status: res.status, body: await res.text() };
      } catch (err) {
        fetched = { error: String(err?.cause?.code ?? err?.message ?? err) };
      }
    }
  }
  appendFileSync(`${planFile}.calls.jsonl`, JSON.stringify({ role, job, call: calls + 1, overloaded: calls < failing || undefined, prompt, argv, cwd: process.cwd(), taskFolder, verifyBrief, fetched, mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers ?? {}) : undefined, files: role === 'tester' && existsSync('FRYDAY_REVIEW/README.md') ? { brief: readFileSync('FRYDAY_REVIEW/README.md', 'utf8'), patch: readFileSync('FRYDAY_REVIEW/diff.patch', 'utf8') } : undefined }) + '\n');

  if (calls < failing) failOverloaded();

  const pick = (list) => (Array.isArray(list) && list.length ? list[Math.min(n, list.length - 1)] : undefined);
  const counted = script.usage?.[job] ?? script.usage?.[role];
  const perCall = Array.isArray(counted) ? pick(counted) : counted;
  if (perCall) usage = { ...SMALL_USAGE, ...perCall };
  const line = script.say?.[job] ?? script.say?.[role];
  said = Array.isArray(line) ? pick(line) : line;
  if (role === 'coder') {
    const step = pick(script.coder) ?? {};
    for (const [file, content] of Object.entries(step.write ?? {})) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    for (const file of step.delete ?? []) rmSync(file, { force: true });
    if (step.budget) stopAtBudget = true;
    if (step.tokens) turnTokens = step.tokens;
  } else if (job === 'analyst' || job === 'triage') {
    const step = pick(script[job]);
    if (step?.budget) stopAtBudget = true;
    else if (step !== undefined) structured = step;
  } else if (role === 'planner') {
    structured = script.planner;
  } else if (role === 'tester') {
    structured = pick(script.tester);
  }
} else if (role === 'coder') {
  // Unscripted: a coder "implements" its task by adding one file to its working directory.
  writeFileSync('fake-change.txt', `changed for ${process.env.FRYDAY_TASK_ID}\n`);
}

// What the agent was actually given, so tests can check it.
const seen = { prompt, argv, hasCoreSecret: 'FRYDAY_CORE_SECRET' in process.env, role, envKeys: Object.keys(process.env).sort() };
emit({
  type: 'assistant',
  message: {
    id: `msg_fake_${process.pid}`, role: 'assistant', model: 'fake-model', stop_reason: 'end_turn',
    content: [{ type: 'text', text: typeof said === 'string' ? said : JSON.stringify(seen) }, ...toolCalls],
    // While it works a run shows a little less than its result; the result is the total that counts.
    usage: usage === SMALL_USAGE
      ? { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 13, cache_creation_input_tokens: 17 }
      : { ...usage, output_tokens: Math.floor(usage.output_tokens / 2) },
  },
  session_id: session,
});
await sleep(delay);

if (turnTokens > 0) {
  for (let i = 0; i < 2000; i++) {
    const id = `msg_fake_${process.pid}_turn_${i}`;
    const partial = { input_tokens: 1, output_tokens: Math.floor(turnTokens / 2), cache_read_input_tokens: 5, cache_creation_input_tokens: 0 };
    const message = { id, role: 'assistant', model: 'fake-model', content: [{ type: 'text', text: `turn ${i}` }] };
    emit({ type: 'assistant', message: { ...message, usage: partial }, session_id: session });
    emit({ type: 'assistant', message: { ...message, usage: { ...partial, output_tokens: turnTokens } }, session_id: session });
    await sleep(Math.max(delay, 20));
  }
}

if (stopAtBudget) {
  // What the real CLI prints when --max-budget-usd is reached: an error result with no tokens, only the cost.
  emit({
    type: 'result', subtype: 'error_max_budget_usd', is_error: true, terminal_reason: 'budget_exhausted', session_id: session,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.75, num_turns: 1,
  });
  process.exit(0);
}

emit({
  type: 'result',
  subtype: 'success',
  is_error: mode === 'error',
  result: mode === 'error' ? 'Not logged in' : 'done',
  ...(structured !== undefined && argv.includes('--json-schema') ? { structured_output: structured } : {}),
  session_id: session,
  usage,
  total_cost_usd: 0.25,
  num_turns: 1,
});
