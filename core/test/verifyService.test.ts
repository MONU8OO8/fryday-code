// The service under test: the run profile, starting and stopping it in the sandbox, and
// the one tool a tester reaches it with.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { parseRunProfile, validateRunProfile, parseEnvFile, profileEnv, ProfileError } from '../src/verify/profile';
import { startService, stopLeftoverServices, freePort, portInUse } from '../src/verify/service';
import { McpClient } from '../src/connections/mcpClient';
// Plain JS on purpose: the agent's claude process starts this file as it is.
import { resolveTarget, cleanHeaders } from '../src/verify/serviceTool.mjs';

// The service under test is started and reached here. On Linux the sandbox gives it a network of
// its own that core cannot reach, so FryDay Code does not start it there (by design, see
// serviceUnreachableReason in src/verify/service.ts): these run on macOS only.
const skip = process.platform !== 'darwin';
// Under the home folder, like real checkouts, so the sandbox's home rule is in play.
const tmp = path.join(os.homedir(), '.fryday-code', `service-test-${randomBytes(4).toString('hex')}`);
const checkout = path.join(tmp, 'checkout');
const scratch = path.join(tmp, 'scratch');
const TOOL = path.join(__dirname, '..', 'src', 'verify', 'serviceTool.mjs');

// A service that reports what it was started with and what it can reach.
const SERVER = `
const http = require('http');
const net = require('net');
const fs = require('fs');
const reach = (port, host) => new Promise((resolve) => {
  const s = net.connect(port, host);
  s.setTimeout(2500, () => { s.destroy(); resolve('timeout'); });
  s.on('connect', () => { s.destroy(); resolve('connected'); });
  s.on('error', (e) => resolve(e.code));
});
http.createServer(async (req, res) => {
  if (req.url === '/env') return res.end(JSON.stringify({ port: process.env.PORT, host: process.env.HOST, greeting: process.env.GREETING, fromFile: process.env.FROM_FILE, home: process.env.HOME }));
  if (req.url === '/reach') {
    let home = 'read';
    try { fs.readdirSync(process.env.REAL_HOME); } catch (e) { home = e.code; }
    let wrote = 'written';
    try { fs.writeFileSync(process.env.REAL_HOME + '/fryday-service-test-must-not-exist', 'x'); } catch (e) { wrote = e.code; }
    return res.end(JSON.stringify({ internet: await reach(443, '1.1.1.1'), home, wrote }));
  }
  if (req.url === '/away') { res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' }); return res.end(); }
  if (req.url === '/login') { res.setHeader('set-cookie', 'sid=abc123; Path=/; HttpOnly'); return res.end('in'); }
  if (req.url === '/me') return res.end(req.headers.cookie || 'no cookie');
  if (req.url === '/echo') { let body = ''; req.on('data', (c) => body += c); req.on('end', () => res.end(JSON.stringify({ method: req.method, type: req.headers['content-type'], body }))); return; }
  if (req.url === '/big') return res.end('x'.repeat(200000));
  res.end('ok');
}).listen(Number(process.env.PORT), process.env.HOST, () => console.log('service listening on ' + process.env.PORT));
`;

before(() => {
  fs.mkdirSync(checkout, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(checkout, 'server.js'), SERVER);
  fs.writeFileSync(path.join(checkout, 'never.js'), 'setInterval(() => {}, 1000); console.log("started but not listening");');
  fs.writeFileSync(path.join(checkout, 'dies.js'), 'console.error("cannot find module ./missing"); process.exit(3);');
  fs.writeFileSync(path.join(tmp, 'local.env'), '# local values\nFROM_FILE=from the file\nexport GREETING="overridden below"\nPORT=1\nnot a line\n');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const profile = (change: Record<string, unknown> = {}) => validateRunProfile({ command: 'node server.js', readyTimeoutSec: 20, ...change });
const start = (p = profile(), key = 'T-1') =>
  startService({ key, profile: p, checkoutPath: checkout, ownerRepoPath: tmp, scratchRoot: scratch, logPath: path.join(tmp, `${key}.log`) });

test('a run profile is checked when it is entered, and gets its defaults', () => {
  const p = validateRunProfile({ command: ' npm start ' });
  assert.deepEqual(p, { command: 'npm start', port: null, readyPath: '/', readyTimeoutSec: 60, env: {}, envFile: null, api: true, ui: false, uiPath: '/' });
  for (const bad of [
    {}, { command: '' }, { command: 'x', port: 80 }, { command: 'x', port: 70000 }, { command: 'x', readyPath: 'health' }, { command: 'x', readyPath: '//evil.example/x' },
    { command: 'x', readyPath: 'http://evil.example/' }, { command: 'x', uiPath: '/a b' }, { command: 'x', env: { 'NOT-A-NAME': '1' } }, { command: 'x', env: { PORT: '1' } },
    { command: 'x', env: { NODE_OPTIONS: '--require ./x' } }, { command: 'x', api: false, ui: false }, { command: 'x', surprise: true }, { command: 'x', readyTimeoutSec: 1 },
  ]) {
    assert.throws(() => validateRunProfile(bad), ProfileError, JSON.stringify(bad));
  }
  assert.equal(parseRunProfile(null), null);
  assert.equal(parseRunProfile({ command: 'x', port: 'abc' }), null, 'a stored profile that no longer fits is not used');
  assert.equal(parseRunProfile({ command: 'npm run dev', port: 3000, ui: true })?.ui, true);
});

test('an env file is read as NAME=value lines, and the plain values win over it', () => {
  assert.deepEqual(parseEnvFile('A=1\n# c\n\nexport B="two words"\nC=\'x\' \nD=val # note\nPORT=9\nHOME=/x\nbad line\n=novalue'), { A: '1', B: 'two words', C: 'x', D: 'val' });
  const env = profileEnv(profile({ env: { GREETING: 'hello' }, envFile: 'local.env' }), tmp);
  assert.deepEqual(env, { FROM_FILE: 'from the file', GREETING: 'hello' });
  assert.throws(() => profileEnv(profile({ envFile: 'missing.env' }), tmp), /was not found/);
});

test('the service starts in the sandbox, gets its port, and is gone after stop', { skip }, async () => {
  const s = await start(profile({ env: { GREETING: 'hello' }, envFile: path.join(tmp, 'local.env') }));
  assert.equal(s.ok, true, JSON.stringify(s));
  if (!s.ok) return;
  const { service } = s;
  try {
    assert.equal(service.origin, `http://127.0.0.1:${service.port}`);
    const env = await (await fetch(`${service.origin}/env`)).json() as Record<string, string>;
    assert.equal(env['port'], String(service.port), 'the port core picked is passed as PORT');
    assert.equal(env['host'], '127.0.0.1');
    assert.equal(env['greeting'], 'hello');
    assert.equal(env['fromFile'], 'from the file');
    assert.notEqual(env['home'], os.homedir(), 'it gets a throwaway home');
    assert.equal(service.listen, 'loopback', 'this one honours HOST');
    assert.match(fs.readFileSync(service.logPath, 'utf8'), /service listening on/);
    assert.equal(await portInUse(service.port), true);
  } finally {
    await service.stop();
  }
  assert.equal(await portInUse(service.port), false, 'nothing is left on the port');
  assert.equal(fs.readdirSync(scratch).filter((n) => n.startsWith('svc-')).length, 0, 'its temp folder is removed');
  assert.deepEqual(fs.readdirSync(path.join(scratch, 'services')), [], 'no marker is left');
});

test('the service cannot reach the internet or the home folder', { skip }, async () => {
  const s = await start(profile({ env: { REAL_HOME: os.homedir() } }));
  assert.equal(s.ok, true, JSON.stringify(s));
  if (!s.ok) return;
  try {
    const reach = await (await fetch(`${s.service.origin}/reach`)).json() as Record<string, string>;
    assert.equal(reach['internet'], 'EPERM');
    assert.equal(reach['home'], 'EPERM');
    assert.equal(reach['wrote'], 'EPERM');
    assert.equal(fs.existsSync(path.join(os.homedir(), 'fryday-service-test-must-not-exist')), false);
  } finally {
    await s.service.stop();
  }
});

test('a service that never answers, or stops, is reported with what it printed', { skip }, async () => {
  const never = await start(profile({ command: 'node never.js', readyTimeoutSec: 5 }), 'T-never');
  assert.equal(never.ok, false);
  if (!never.ok) {
    assert.equal(never.reason, 'not_ready');
    assert.match(never.detail, /nothing answered on port \d+ within 5 seconds/);
    assert.match(never.detail, /fixed port/, 'it says what to do when the service ignores PORT');
    assert.match(never.logTail, /started but not listening/);
  }
  const dies = await start(profile({ command: 'node dies.js' }), 'T-dies');
  assert.equal(dies.ok, false);
  if (!dies.ok) {
    assert.equal(dies.reason, 'exited');
    assert.match(dies.detail, /exit code 3/);
    assert.match(dies.logTail, /cannot find module/);
  }
  assert.deepEqual(fs.readdirSync(path.join(scratch, 'services')), [], 'a failed start leaves no marker');
  const noFile = await start(profile({ envFile: 'missing.env' }), 'T-env');
  assert.equal(!noFile.ok && noFile.reason, 'profile');
});

test('a fixed port that something else already uses is said, and nothing is started', { skip }, async () => {
  const busy = http.createServer((_q, r) => r.end('the owner\'s own copy')).listen(0, '127.0.0.1');
  await new Promise((r) => busy.once('listening', r));
  const port = (busy.address() as AddressInfo).port;
  try {
    const s = await start(profile({ port }), 'T-busy');
    assert.equal(s.ok, false);
    if (!s.ok) {
      assert.equal(s.reason, 'port_in_use');
      assert.match(s.detail, new RegExp(`Port ${port} is already in use`));
    }
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "the owner's own copy", 'what was there is untouched');
  } finally {
    busy.close();
  }
});

test('a service left running by a core that stopped is found and stopped at the next start', { skip }, async () => {
  const s = await start(profile(), 'T-left');
  assert.equal(s.ok, true);
  if (!s.ok) return;
  // Core "dies" here: the handle is lost, only the marker file remains.
  assert.equal(fs.readdirSync(path.join(scratch, 'services')).length, 1);
  assert.equal(stopLeftoverServices(scratch), 1);
  for (let i = 0; i < 30 && (await portInUse(s.service.port)); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await portInUse(s.service.port), false);
  assert.deepEqual(fs.readdirSync(path.join(scratch, 'services')), []);
  // A marker whose pid now belongs to something else is not acted on.
  fs.writeFileSync(path.join(scratch, 'services', 'stale.json'), JSON.stringify({ pid: process.pid }));
  assert.equal(stopLeftoverServices(scratch), 0);
  await s.service.stop();
});

test('the service tool accepts only a path on the service', () => {
  const origin = 'http://127.0.0.1:4310';
  assert.deepEqual(resolveTarget(origin, '/api/items?limit=5'), { url: `${origin}/api/items?limit=5` });
  assert.deepEqual(resolveTarget(origin, '/a/../b'), { url: `${origin}/b` });
  for (const p of ['http://127.0.0.1:4311/x', 'https://example.com/', '//example.com/x', '/\\example.com/x', 'api/items', '', '/a\nb', '\\\\host\\x', undefined, 5, 'file:///etc/hosts', '@example.com/']) {
    assert.ok('error' in resolveTarget(origin, p), `must be refused: ${String(p)}`);
  }
  assert.deepEqual(cleanHeaders({ Accept: 'application/json', 'X-Test': '1' }), { headers: { Accept: 'application/json', 'X-Test': '1' } });
  for (const h of [{ Host: 'evil.example' }, { 'Transfer-Encoding': 'chunked' }, { 'X-A': 'a\r\nX-B: b' }, { 'bad name': '1' }, { 'X-N': 5 }, ['a'], 'x']) {
    assert.ok('error' in cleanHeaders(h), `must be refused: ${JSON.stringify(h)}`);
  }
});

test('through the tool: requests reach the service, a redirect is not followed, cookies carry over', { skip }, async () => {
  const s = await start();
  assert.equal(s.ok, true);
  if (!s.ok) return;
  const cfg = path.join(tmp, 'tool.json');
  fs.writeFileSync(cfg, JSON.stringify({ baseUrl: s.service.origin, logPath: s.service.logPath, maxBodyChars: 1000 }));
  const client = new McpClient({ command: process.execPath, args: [TOOL, cfg] }, { timeoutMs: 15_000 });
  try {
    await client.start();
    assert.deepEqual((await client.listTools()).map((t) => t.name).sort(), ['log', 'request']);
    const call = (args: Record<string, unknown>) => client.callTool('request', args);

    const ok = await call({ path: '/' });
    assert.equal(ok.isError, false);
    assert.match(ok.text, /^HTTP 200 OK/);
    assert.match(ok.text, /\n\nok$/);

    const posted = await call({ method: 'POST', path: '/echo', json: { qty: 2 } });
    assert.match(posted.text, /"method":"POST","type":"application\/json","body":"\{\\"qty\\":2\}"/);

    const away = await call({ path: '/away' });
    assert.match(away.text, /^HTTP 302/);
    assert.match(away.text, /was not followed/);
    assert.doesNotMatch(away.text, /elsewhere\n\n.*ok/s);

    assert.match((await call({ path: '/me' })).text, /no cookie$/);
    assert.match((await call({ path: '/login' })).text, /set-cookie: sid=\[kept for your next requests\]/);
    assert.match((await call({ path: '/me' })).text, /sid=abc123$/, 'the cookie from the login is sent on the next request');

    assert.match((await call({ path: '/big' })).text, /\[body cut: 200000 characters in all\]$/);

    for (const args of [{ path: 'http://127.0.0.1:1/x' }, { path: '//example.com/' }, { path: '/', method: 'CONNECT' }, { path: '/', headers: { Host: 'example.com' } }, { path: '/', body: 'x' }, {}]) {
      assert.equal((await call(args)).isError, true, JSON.stringify(args));
    }
    assert.match((await client.callTool('log')).text, /service listening on/);
  } finally {
    client.stop();
    await s.service.stop();
  }
});

test('a run that is only given the log is not shown, and cannot call, the request tool', async () => {
  const cfg = path.join(tmp, 'log-only.json');
  fs.writeFileSync(path.join(tmp, 'some.log'), 'a line the service printed\n');
  fs.writeFileSync(cfg, JSON.stringify({ baseUrl: 'http://127.0.0.1:4310', logPath: path.join(tmp, 'some.log'), tools: ['log'] }));
  const client = new McpClient({ command: process.execPath, args: [TOOL, cfg] }, { timeoutMs: 15_000 });
  try {
    await client.start();
    assert.deepEqual((await client.listTools()).map((t) => t.name), ['log']);
    await assert.rejects(() => client.callTool('request', { path: '/' }), /unknown tool/);
    assert.match((await client.callTool('log')).text, /a line the service printed/);
  } finally {
    client.stop();
  }
});

test('the tool refuses to start for anything but a port on this machine', () => {
  for (const baseUrl of ['https://example.com', 'http://example.com:80', 'http://127.0.0.1', 'ftp://127.0.0.1:21']) {
    const cfg = path.join(tmp, 'bad-tool.json');
    fs.writeFileSync(cfg, JSON.stringify({ baseUrl }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const r = require('node:child_process').spawnSync(process.execPath, [TOOL, cfg], { input: '', encoding: 'utf8' });
    assert.equal(r.status, 1, baseUrl);
    assert.match(r.stderr, /must be http on this machine/);
  }
});

test('a free port is free', async () => {
  const port = await freePort();
  assert.ok(port > 1024);
  assert.equal(await portInUse(port), false);
});
