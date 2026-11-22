// The owner's session, tested against a real server process on a throwaway state folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { LaunchCodes, uiSessionToken, uiCookieName } from '../src/api/auth';
import { loadOrCreateSecret, findOnPath } from '../src/config';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-session-'));
let server: ChildProcess;
let port = 0;
let base = '';
let origin = '';
let firstLink = '';

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const codeOf = (link: string) => link.split('#launch=')[1]!;
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!;

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  origin = base;
  const env = { ...process.env, FRYDAY_HOME: home, FRYDAY_PORT: String(port) };
  for (const k of ['FRYDAY_CORE_SECRET', 'FRYDAY_DB', 'FRYDAY_RUNS', 'FRYDAY_WORKTREES', 'FRYDAY_SCRATCH']) delete env[k];
  server = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, '..', 'src', 'server.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 30_000);
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      const link = out.match(/Open \(one-time link[^)]*\): (\S+)/);
      if (link) { firstLink = link[1]!; clearTimeout(timer); resolve(); }
    };
    server.stdout!.on('data', onData);
    server.stderr!.on('data', onData);
  });
});
after(() => { server?.kill(); fs.rmSync(home, { recursive: true, force: true }); });

test('a fresh install creates its own secret, readable only by the developer', () => {
  const secretFile = path.join(home, 'secret');
  assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(secretFile, 'utf8').trim(), /^[0-9a-f]{64}$/);
  assert.equal(fs.existsSync(path.join(home, 'fryday.db')), true, 'the database is created in the state folder');
  // The same secret is returned on the next start; an environment override wins; a damaged file is refused.
  assert.equal(loadOrCreateSecret(secretFile, undefined), fs.readFileSync(secretFile, 'utf8').trim());
  assert.equal(loadOrCreateSecret(secretFile, 'from-the-environment'), 'from-the-environment');
  const damaged = path.join(home, 'damaged');
  fs.writeFileSync(damaged, 'short\n');
  assert.throws(() => loadOrCreateSecret(damaged, undefined), /does not hold a usable secret/);
  assert.equal(findOnPath('definitely-not-a-real-binary-name'), null);
  assert.equal(findOnPath('sh', '/nope:/bin'), '/bin/sh');
});

test('asking for the page grants nothing', async () => {
  for (const p of ['/ui/', '/ui/tasks/T-1', '/']) {
    const res = await fetch(`${base}${p}`, { redirect: 'manual' });
    assert.equal(res.headers.get('set-cookie'), null, `${p} must not set a session cookie`);
  }
  assert.equal((await fetch(`${base}/api/session`)).status, 401);
  assert.equal((await fetch(`${base}/api/tasks`)).status, 401);
  assert.equal((await fetch(`${base}/api/approvals/x/resolve`, json({ decision: 'approved' }))).status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 200, 'health stays public');
});

test('a guessed cookie or a guessed code does not work', async () => {
  const guessed = `${uiCookieName(port)}=${uiSessionToken('not-the-secret')}`;
  assert.equal((await fetch(`${base}/api/tasks`, { headers: { Cookie: guessed } })).status, 401);
  const wrong = await fetch(`${base}/api/session`, json({ code: 'not-the-code' }));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.equal((await fetch(`${base}/api/session`, json({}))).status, 401);
});

test('the launch link signs a browser in exactly once', async () => {
  assert.match(firstLink, new RegExp(`^${base}/ui/#launch=[A-Za-z0-9_-]{20,}$`), 'the code travels in the fragment, not the query');

  // A browser always sends Origin on a POST. Without it, even the right code is refused — and not consumed.
  const noOrigin = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: codeOf(firstLink) }) });
  assert.equal(noOrigin.status, 403);
  const foreign = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' }, body: JSON.stringify({ code: codeOf(firstLink) }) });
  assert.equal(foreign.status, 403);

  const ok = await fetch(`${base}/api/session`, json({ code: codeOf(firstLink) }));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
  const cookie = cookieOf(ok);

  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/tasks`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/system`, { headers: { Cookie: cookie } })).status, 200);

  // The same link a second time is dead.
  assert.equal((await fetch(`${base}/api/session`, json({ code: codeOf(firstLink) }))).status, 401);
});

test('a new launch link needs the secret file; a session cookie is not enough to mint one', async () => {
  const secret = fs.readFileSync(path.join(home, 'secret'), 'utf8').trim();
  const mint = (headers: Record<string, string>) => fetch(`${base}/api/session/launch-code`, { method: 'POST', headers });
  assert.equal((await mint({})).status, 401);
  assert.equal((await mint({ 'x-fryday-core-token': 'wrong' })).status, 401);
  assert.equal((await mint({ Cookie: `${uiCookieName(port)}=${uiSessionToken(secret)}`, Origin: origin })).status, 401);

  const minted = await mint({ 'x-fryday-core-token': secret });
  assert.equal(minted.status, 200);
  const { code, url } = (await minted.json()) as { code: string; url: string };
  assert.equal(url, `${base}/ui/#launch=${code}`);
  assert.equal((await fetch(`${base}/api/session`, json({ code }))).status, 200);
});

test('launch codes expire, work once, and a run of wrong guesses voids them all', () => {
  let now = 1_000_000;
  const codes = new LaunchCodes(() => now);
  const a = codes.issue();
  const b = codes.issue();
  assert.notEqual(a, b);
  assert.equal(codes.redeem(a), true);
  assert.equal(codes.redeem(a), false, 'a code works once');

  now += 16 * 60_000;
  assert.equal(codes.redeem(b), false, 'a code expires');
  assert.equal(codes.outstanding(), 0);

  const c = codes.issue();
  for (const guess of ['x', '', 123, null, 'y'.repeat(500)]) assert.equal(codes.redeem(guess), false);
  assert.equal(codes.redeem(c), false, 'five wrong guesses void every outstanding code');
  const d = codes.issue();
  assert.equal(codes.redeem(d), true, 'a newly issued code still works');
});
