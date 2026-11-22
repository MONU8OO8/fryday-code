import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ensureDeps, depsUsable, installKey, removeTaskDeps, type EnsureDepsOptions } from '../src/pipeline/deps';

// The sandbox runs on macOS and on Linux (bubblewrap); elsewhere there is none to test.
const skip = !['darwin', 'linux'].includes(process.platform);
const base = path.join(os.homedir(), '.fryday-code', `deps-test-${randomBytes(4).toString('hex')}`);
const scratch = path.join(base, 'scratch');
const keepDir = path.join(base, 'kept');
after(() => fs.rmSync(base, { recursive: true, force: true }));

const PKG = '{"name":"x","dependencies":{"dep":"1.0.0"}}\n';
/** Stands in for a package manager: creates node_modules without the network, and counts its runs. */
const FAKE_INSTALL = 'mkdir -p node_modules/dep && echo "module.exports = 1;" > node_modules/dep/index.js && echo run >> install-runs.log';

function repo(name: string, files: Record<string, string> = {}): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  const all = { '.gitignore': 'node_modules\ninstall-runs.log\n', 'package.json': PKG, 'package-lock.json': '{"lockfileVersion":3}\n', ...files };
  for (const [file, content] of Object.entries(all)) fs.writeFileSync(path.join(dir, file), content);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init']);
  return dir;
}

function options(checkoutPath: string, change: Partial<EnsureDepsOptions> = {}): EnsureDepsOptions {
  fs.mkdirSync(scratch, { recursive: true });
  return {
    ownerRepoPath: path.join(base, 'owner-without-modules'),
    checkoutPath,
    installCmd: FAKE_INSTALL,
    keepDir,
    scratchRoot: scratch,
    allowedDomains: [],
    timeoutMs: 60_000,
    ...change,
  };
}
const runs = (dir: string) => (fs.existsSync(path.join(dir, 'install-runs.log')) ? fs.readFileSync(path.join(dir, 'install-runs.log'), 'utf8').trim().split('\n').length : 0);

test('nothing is installed when nothing is needed, and a missing way to install is said plainly', async () => {
  repo('owner-without-modules');
  const noDeps = repo('no-deps', { 'package.json': '{"name":"x"}\n' });
  const none = await ensureDeps(options(noDeps));
  assert.equal(none.status, 'none');
  assert.equal(depsUsable(none), true);

  const noCommand = await ensureDeps(options(repo('no-command'), { installCmd: null }));
  assert.equal(noCommand.status, 'missing');
  assert.match(noCommand.detail, /no install command/);
  assert.equal(depsUsable(noCommand), false);

  const tracked = await ensureDeps(options(repo('tracked', { '.gitignore': '' })));
  assert.equal(tracked.status, 'missing');
  assert.match(tracked.detail, /not git-ignored/);
});

test('the install command runs in the sandbox once, and the result is kept for the same package files', { skip }, async () => {
  const first = repo('first');
  const installed = await ensureDeps(options(first));
  assert.equal(installed.status, 'installed', installed.detail);
  assert.equal(fs.existsSync(path.join(first, 'node_modules', 'dep', 'index.js')), true);
  assert.equal(runs(first), 1);

  // Same package files in another checkout: copied, the command does not run again.
  const second = repo('second');
  const kept = await ensureDeps(options(second));
  assert.equal(kept.status, 'kept', kept.detail);
  assert.equal(fs.existsSync(path.join(second, 'node_modules', 'dep', 'index.js')), true);
  assert.equal(runs(second), 0);
  // Changing the copy does not change what is kept.
  fs.writeFileSync(path.join(second, 'node_modules', 'dep', 'index.js'), 'tampered');
  const third = repo('third');
  await ensureDeps(options(third));
  assert.equal(fs.readFileSync(path.join(third, 'node_modules', 'dep', 'index.js'), 'utf8'), 'module.exports = 1;\n');

  assert.equal((await ensureDeps(options(first))).status, 'present');

  // Different package files: a different install.
  const other = repo('other', { 'package-lock.json': '{"lockfileVersion":3,"changed":true}\n' });
  assert.notEqual(installKey(other, FAKE_INSTALL), installKey(first, FAKE_INSTALL));
  assert.equal((await ensureDeps(options(other))).status, 'installed');
  assert.equal(runs(other), 1);
});

test("an install made on an agent's commit is kept for that task only", { skip }, async () => {
  const lock = '{"lockfileVersion":3,"agent":"changed this"}\n';
  const taskA = repo('task-a', { 'package-lock.json': lock });
  assert.equal((await ensureDeps(options(taskA, { taskId: 'T-A' }))).status, 'installed');

  // The same task sees it again; another task and the shared (base commit) side do not.
  assert.equal((await ensureDeps(options(repo('task-a-again', { 'package-lock.json': lock }), { taskId: 'T-A' }))).status, 'kept');
  const taskB = repo('task-b', { 'package-lock.json': lock });
  assert.equal((await ensureDeps(options(taskB, { taskId: 'T-B' }))).status, 'installed');
  assert.equal(runs(taskB), 1);
  const baseSide = repo('base-side', { 'package-lock.json': lock });
  assert.equal((await ensureDeps(options(baseSide))).status, 'installed');

  // A shared install is used by tasks too.
  assert.equal((await ensureDeps(options(repo('task-c', { 'package-lock.json': lock }), { taskId: 'T-C' }))).status, 'kept');

  removeTaskDeps(keepDir, 'T-A');
  assert.equal(fs.existsSync(path.join(keepDir, 'task-T-A')), false);
  assert.equal(fs.existsSync(path.join(keepDir, 'task-T-B')), true);
});

test('a failing install is reported, leaves no half-made node_modules, and is not kept', { skip }, async () => {
  const lock = '{"lockfileVersion":3,"case":"failing"}\n';
  const broken = repo('broken', { 'package-lock.json': lock });
  const failed = await ensureDeps(options(broken, { installCmd: 'mkdir -p node_modules/half && echo "registry said no" && exit 7' }));
  assert.equal(failed.status, 'failed');
  assert.match(failed.detail, /exit 7/);
  assert.match(failed.detail, /registry said no/);
  assert.equal(fs.existsSync(path.join(broken, 'node_modules')), false);
  assert.equal(depsUsable(failed), false);

  const nothingMade = await ensureDeps(options(repo('nothing-made', { 'package-lock.json': lock }), { installCmd: 'true' }));
  assert.equal(nothingMade.status, 'failed');
  assert.match(nothingMade.detail, /without creating node_modules/);

  const slow = await ensureDeps(options(repo('slow', { 'package-lock.json': lock }), { installCmd: 'sleep 30', timeoutMs: 1500 }));
  assert.equal(slow.status, 'failed');
  assert.match(slow.detail, /did not finish/);
});

test('tracked files rewritten by the install are put back', { skip }, async () => {
  const dir = repo('rewrites', { 'package-lock.json': '{"lockfileVersion":3,"case":"rewrite"}\n' });
  const result = await ensureDeps(options(dir, { installCmd: `${FAKE_INSTALL} && echo '{"rewritten":true}' > package-lock.json` }));
  assert.equal(result.status, 'installed', result.detail);
  assert.match(result.detail, /1 tracked file it rewrote was put back/);
  assert.equal(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), '{"lockfileVersion":3,"case":"rewrite"}\n');
  assert.equal(execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('the install cannot reach the network beyond the hosts it is given, or read the home folder', { skip }, async () => {
  const canary = path.join(base, 'home-canary.txt');
  fs.writeFileSync(canary, 'private');
  const dir = repo('confined', { 'package-lock.json': '{"lockfileVersion":3,"case":"confined"}\n' });
  const probe = `${FAKE_INSTALL}; (cat ${canary} >/dev/null 2>&1 && echo READ_HOME=yes || echo READ_HOME=no) > node_modules/probe.txt; (curl -sS -m 5 -o /dev/null https://example.com >/dev/null 2>&1 && echo NET=yes || echo NET=no) >> node_modules/probe.txt`;
  const result = await ensureDeps(options(dir, { installCmd: probe, allowedDomains: ['registry.npmjs.org'] }));
  assert.equal(result.status, 'installed', result.detail);
  const seen = fs.readFileSync(path.join(dir, 'node_modules', 'probe.txt'), 'utf8');
  assert.match(seen, /READ_HOME=no/);
  assert.match(seen, /NET=no/);
});

// Needs the internet, so it only runs when asked: FRYDAY_NETWORK_TESTS=1 npm test
test('a real npm ci works through the sandbox with only the registry reachable', { skip: skip || !process.env.FRYDAY_NETWORK_TESTS }, async () => {
  const lockfile = JSON.stringify({
    name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'x', version: '1.0.0', dependencies: { 'is-odd': '3.0.1' } },
      'node_modules/is-number': { version: '6.0.0', resolved: 'https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz', integrity: 'sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==' },
      'node_modules/is-odd': { version: '3.0.1', resolved: 'https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz', integrity: 'sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==', dependencies: { 'is-number': '^6.0.0' } },
    },
  });
  const dir = repo('real-npm', { 'package.json': '{"name":"x","version":"1.0.0","dependencies":{"is-odd":"3.0.1"}}\n', 'package-lock.json': lockfile });
  const result = await ensureDeps(options(dir, { installCmd: 'npm ci', allowedDomains: ['registry.npmjs.org'], timeoutMs: 120_000 }));
  assert.equal(result.status, 'installed', result.detail);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules', 'is-odd', 'package.json')), true);
});
