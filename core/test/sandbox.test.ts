import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { runSandboxed } from '../src/pipeline/sandbox';

// The sandbox is an OS feature; these tests run for real on macOS (the platform Fryday runs on).
// The sandbox runs on macOS and on Linux (bubblewrap); elsewhere there is none to test.
const skip = !['darwin', 'linux'].includes(process.platform);

// Under the home folder on purpose: that is where the owner's files are.
const base = path.join(os.homedir(), '.fryday-code', `sandbox-test-${randomBytes(4).toString('hex')}`);
const workspace = path.join(base, 'workspace');
const scratch = path.join(base, 'scratch');
const outside = path.join(base, 'outside');
const canary = `CANARY-${randomBytes(8).toString('hex')}`;
let server: http.Server;
let port = 0;
let hits = 0;

const run = (command: string, timeoutMs = 30_000) => runSandboxed(command, { workspacePath: workspace, scratchRoot: scratch, timeoutMs });

before(async () => {
  for (const dir of [workspace, scratch, outside]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(outside, 'creds.sh'), `export TOKEN=${canary}\n`);
  fs.writeFileSync(path.join(workspace, 'inside.txt'), 'inside-content\n');
  server = http.createServer((_req, res) => { hits++; res.end('reached'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
after(() => {
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('a command runs in the workspace and its exit code and output come back', { skip }, async () => {
  const ok = await run('cat inside.txt && echo to-stderr >&2 && pwd');
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /inside-content/);
  assert.match(ok.output, /to-stderr/);
  assert.match(ok.output, new RegExp(`${workspace}$`, 'm'));
  assert.equal((await run('exit 7')).exitCode, 7);
});

test('writes work inside the workspace and the temp folder, and nowhere else', { skip }, async () => {
  const r = await run([
    'echo a > made-inside.txt && echo "inside: ok"',
    'echo b > "$TMPDIR/t.txt" && echo "tmp: ok"',
    `(echo c > ${outside}/pwned.txt) 2>/dev/null && echo "outside: WROTE" || echo "outside: blocked"`,
    `(echo d > ${os.homedir()}/fryday-sandbox-test-pwned.txt) 2>/dev/null && echo "home: WROTE" || echo "home: blocked"`,
    '(echo e > /private/tmp/fryday-sandbox-test-pwned.txt) 2>/dev/null && echo "slash-tmp: WROTE" || echo "slash-tmp: blocked"',
    `(echo f > ${scratch}/pwned.json) 2>/dev/null && echo "scratch: WROTE" || echo "scratch: blocked"`,
  ].join('; '));
  assert.match(r.output, /inside: ok/);
  assert.match(r.output, /tmp: ok/);
  for (const where of ['outside', 'home', 'slash-tmp', 'scratch']) assert.match(r.output, new RegExp(`${where}: blocked`), where);
  assert.equal(fs.existsSync(path.join(workspace, 'made-inside.txt')), true);
  assert.equal(fs.existsSync(path.join(outside, 'pwned.txt')), false);
  assert.equal(fs.existsSync(path.join(os.homedir(), 'fryday-sandbox-test-pwned.txt')), false);
  assert.equal(fs.existsSync('/private/tmp/fryday-sandbox-test-pwned.txt'), false);
});

test('the home folder cannot be read, and HOME points at a throwaway folder', { skip }, async () => {
  const r = await run([
    `cat ${outside}/creds.sh 2>/dev/null && echo "creds: READ" || echo "creds: blocked"`,
    `ls ${os.homedir()}/.ssh >/dev/null 2>&1 && echo "ssh: READ" || echo "ssh: blocked"`,
    `ls ${os.homedir()}/Documents >/dev/null 2>&1 && echo "documents: READ" || echo "documents: blocked"`,
    'echo "home=$HOME"',
    'node -e "console.log(\'node: ok\')"',
  ].join('; '));
  assert.equal(r.output.includes(canary), false, 'the canary secret was read');
  for (const what of ['creds', 'ssh', 'documents']) assert.match(r.output, new RegExp(`${what}: blocked`), what);
  assert.match(r.output, new RegExp(`home=${scratch}/sbx-[0-9a-f-]+/home`));
  assert.match(r.output, /node: ok/, 'node must still be usable');
});

test('there is no network, not even to localhost', { skip }, async () => {
  const r = await run([
    `curl -s -m 5 http://127.0.0.1:${port}/ && echo " local: REACHED" || echo "local: blocked"`,
    'curl -s -m 5 https://example.com >/dev/null && echo "internet: REACHED" || echo "internet: blocked"',
    `node -e "fetch('http://127.0.0.1:${port}/').then(()=>console.log('fetch: REACHED'),()=>console.log('fetch: blocked'))"`,
  ].join('; '));
  for (const what of ['local', 'internet', 'fetch']) assert.match(r.output, new RegExp(`${what}: blocked`), what);
  assert.equal(hits, 0, 'the local server was reached');
});

test("core's environment does not reach the command", { skip }, async () => {
  process.env.GITHUB_TOKEN = canary;
  process.env.FRYDAY_CORE_SECRET = canary;
  try {
    const r = await run('env');
    assert.equal(r.output.includes(canary), false);
    assert.match(r.output, /^CI=1$/m);
  } finally {
    delete process.env.GITHUB_TOKEN;
    delete process.env.FRYDAY_CORE_SECRET;
  }
});

test('a command that runs too long is stopped and reported as timed out', { skip }, async () => {
  const r = await run('echo started; sleep 30; echo finished', 1500);
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.match(r.output, /started/);
  assert.doesNotMatch(r.output, /finished/);
  assert.ok(r.durationMs < 10_000);
});

test('a timeout stops everything the command started, even in another process group', { skip }, async () => {
  // Like a test runner's workers: started detached, still holding the output pipe.
  const marker = `31.${Date.now() % 100000}`;
  const command = `node -e "require('child_process').spawn('sleep', ['${marker}'], { detached: true, stdio: 'inherit' }); setTimeout(() => {}, 60000)"`;
  const survivors = () => {
    try { return execFileSync('pgrep', ['-f', `sleep ${marker}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch { return 0; }
  };
  const pending = run(command, 2000);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(survivors(), 1, 'the detached worker should be running before the timeout');

  const r = await pending;
  assert.equal(r.timedOut, true);
  assert.ok(r.durationMs < 9000, `returned after ${r.durationMs} ms instead of waiting for the worker`);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(survivors(), 0, 'the detached worker must not outlive the timeout');
});

test('a deep scratch folder still works, and a command that could not start is reported as such', { skip }, async () => {
  // Deep enough that a socket created under it would exceed the operating system's limit.
  const deep = path.join(scratch, 'a-rather-long-folder-name-for-testing-socket-path-limits', 'and-one-more-level-of-nesting');
  fs.mkdirSync(deep, { recursive: true });
  const ok = await runSandboxed('echo ran', { workspacePath: workspace, scratchRoot: deep, timeoutMs: 30_000 });
  assert.equal(ok.started, true);
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.output.trim(), 'ran', 'the start marker is not part of the output');
  fs.rmSync(path.join(scratch, 'a-rather-long-folder-name-for-testing-socket-path-limits'), { recursive: true });

  const failed = await run('exit 3');
  assert.deepEqual([failed.started, failed.exitCode], [true, 3], 'a command that ran and failed did start');

  // A workspace that does not exist: nothing can run there.
  const never = await runSandboxed('echo ran', { workspacePath: path.join(base, 'no-such-workspace'), scratchRoot: scratch, timeoutMs: 30_000 });
  assert.equal(never.started, false);
  assert.doesNotMatch(never.output, /^ran$/m);
});

test('nothing is left behind in the scratch folder', { skip }, () => {
  assert.deepEqual(fs.readdirSync(scratch), []);
});
