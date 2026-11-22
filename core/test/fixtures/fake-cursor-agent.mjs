#!/usr/bin/env node
// Stand-in for the `cursor-agent` CLI in tests. Emits the stream-json shapes the real CLI
// emits (seen in a spike against cursor-agent 2026.11): system init, assistant text with a
// model_call_id, tool_call started/completed, and a result with camelCase usage.
//
// FAKE_CURSOR_MODE:
//   answer (default) — answers the job it was given with a JSON object in a fenced block:
//                      a triage, a brief, or a plan (FAKE_PLAN_FILE's `planner` entry when set)
//   nojson           — answers in prose only
//   error            — ends with an error result
//   hang             — never ends on its own
//   probe            — tries to get out of its sandbox and reports what happened
// First of all it writes one `fake_saw` line: its arguments, environment (names, and its
// HOME), working folder and prompt, so a test can see what it was given. Never a value of
// CURSOR_API_KEY: only whether one was set.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const mode = process.env.FAKE_CURSOR_MODE ?? 'answer';
const argv = process.argv.slice(2);
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const session = 'cccccccc-1111-4222-8333-444444444444';

const prompt = fs.readFileSync(0, 'utf8');
emit({
  type: 'fake_saw', argv, cwd: process.cwd(), home: process.env.HOME, prompt,
  envKeys: Object.keys(process.env).sort(), hasKey: Boolean(process.env.CURSOR_API_KEY),
});
emit({ type: 'system', subtype: 'init', apiKeySource: 'env', cwd: process.cwd(), session_id: session, model: 'Fake Composer', permissionMode: 'default' });
emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, session_id: session });

if (mode === 'hang') await sleep(600_000);

/** What one attempt to do something came to. */
function attempt(fn) {
  try {
    fn();
    return 'done';
  } catch (err) {
    return `refused: ${err.code ?? err.message}`;
  }
}
function connect(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 3000 });
    s.on('connect', () => { s.destroy(); resolve('done'); });
    s.on('timeout', () => { s.destroy(); resolve('refused: timeout'); });
    s.on('error', (err) => resolve(`refused: ${err.code ?? err.message}`));
  });
}
/** A CONNECT through the proxy the sandbox offers, to a host Cursor may not reach. */
function viaProxy(host) {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy) return Promise.resolve('refused: no proxy');
  const u = new URL(proxy);
  return new Promise((resolve) => {
    const auth = u.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}\r\n` : '';
    const s = net.connect({ host: u.hostname, port: Number(u.port), timeout: 3000 }, () => s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n${auth}\r\n`));
    s.once('data', (d) => { s.destroy(); const status = String(d).split(' ')[1]; resolve(status === '200' ? 'done' : `refused: ${status}`); });
    s.on('timeout', () => { s.destroy(); resolve('refused: timeout'); });
    s.on('error', (err) => resolve(`refused: ${err.code ?? err.message}`));
  });
}

if (mode === 'probe') {
  const realHome = process.env.FAKE_REAL_HOME ?? '';
  const probes = {
    readCanary: attempt(() => fs.readFileSync(process.env.FAKE_CANARY ?? '/nonexistent')),
    readOwnersCursor: attempt(() => fs.readdirSync(path.join(realHome, '.cursor'))),
    readOwnersSsh: attempt(() => fs.readdirSync(path.join(realHome, '.ssh'))),
    readCheckout: attempt(() => fs.readFileSync(path.join(process.cwd(), 'README.md'))),
    writeCheckout: attempt(() => fs.writeFileSync(path.join(process.cwd(), 'cursor-was-here.txt'), 'x')),
    writeOutside: attempt(() => fs.writeFileSync(path.join(process.env.FAKE_OUTSIDE ?? '/nonexistent', 'cursor-was-here.txt'), 'x')),
    writeOwnHome: attempt(() => fs.writeFileSync(path.join(process.env.HOME, 'note.txt'), 'x')),
    directNetwork: await connect('example.com', 80),
    directIp: await connect('1.1.1.1', 80),
    proxyToOtherHost: await viaProxy('example.com'),
  };
  emit({ type: 'fake_probe', probes });
}

const usage = { inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 0 };
if (mode === 'error') {
  emit({ type: 'result', subtype: 'error', is_error: true, result: 'fake-cursor: something went wrong', session_id: session, usage });
  process.exit(1);
}

const DEFAULT_BRIEF = { summary: 'A clear task, read by Cursor.', requirements: ['Do what the task says.'], areas: [], assumptions: [], risks: [], questions: [], continueOn: '', continueWhy: '' };
const DEFAULT_TRIAGE = { projectId: '', confidence: 'unsure', reason: 'Could not tell.' };
const DEFAULT_PLAN = {
  summary: 'Plan written by Cursor.', approach: 'Change the one file the task names.', flow: [{ step: 'change', detail: 'edit the file' }],
  files: [], criteria: ['The task is done as written.'], testPlan: ['Run the tests.'], risks: [], questions: [],
};
function scripted(role) {
  const file = process.env.FAKE_PLAN_FILE;
  if (!file || !fs.existsSync(file)) return undefined;
  const script = JSON.parse(fs.readFileSync(file, 'utf8'));
  return role === 'planner' ? script.planner : undefined;
}
const role = process.env.FRYDAY_ROLE;
const job = prompt.includes('"projectId"') ? 'triage' : role === 'planner' ? 'plan' : 'brief';
const answer = job === 'triage' ? DEFAULT_TRIAGE : job === 'plan' ? (scripted('planner') ?? DEFAULT_PLAN) : DEFAULT_BRIEF;

if (fs.existsSync('FRYDAY_TASK/README.md')) {
  const args = { path: path.join(process.cwd(), 'FRYDAY_TASK/README.md') };
  emit({ type: 'tool_call', subtype: 'started', call_id: 'call-1', tool_call: { readToolCall: { args } }, session_id: session });
  emit({ type: 'tool_call', subtype: 'completed', call_id: 'call-1', tool_call: { readToolCall: { args, result: { success: {} } } }, session_id: session });
}
const text = mode === 'nojson'
  ? 'I read the task and I think it is fine.'
  : `I read the task. Here is my answer.\n\n\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\`\n`;
emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: session, model_call_id: 'mc-1' });
emit({ type: 'result', subtype: 'success', duration_ms: 5, is_error: false, result: text, session_id: session, request_id: 'r-1', usage });
