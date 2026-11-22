import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initDb } from '../src/db/db';
import { saveProject } from '../src/registry/registry';
import { detectProject, detectCommands, withoutCredentials, isGitUrl, cloneRepository, DetectError } from '../src/registry/detect';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-detect-')));
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();

/** A clone of a bare remote, with the given files committed on `mainBranch` and extra remote branches. */
function repo(name: string, files: Record<string, string>, mainBranch = 'main', extraBranches: string[] = []): string {
  const origin = path.join(tmp, `${name}.git`);
  const seed = path.join(tmp, `${name}-seed`);
  execFileSync('git', ['init', '--bare', '-q', '-b', mainBranch, origin]);
  execFileSync('git', ['init', '-q', '-b', mainBranch, seed]);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), content);
  }
  sh(seed, 'add', '-A');
  sh(seed, 'commit', '-q', '-m', 'init');
  sh(seed, 'remote', 'add', 'origin', origin);
  sh(seed, 'push', '-q', 'origin', mainBranch, ...extraBranches.map((b) => `${mainBranch}:${b}`));
  const clone = path.join(tmp, name);
  execFileSync('git', ['clone', '-q', origin, clone]);
  return clone;
}

before(() => { initDb(path.join(tmp, 'test.db')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a Node repository is recognised: branches, remote and check commands', () => {
  const clone = repo('shop-api', {
    'package.json': JSON.stringify({ name: '@acme/shop-api', scripts: { test: 'jest', lint: 'eslint "src/**/*.ts" --fix', build: 'tsc' }, devDependencies: { typescript: '^5.0.0', jest: '^29.0.0' } }),
    'package-lock.json': '{}',
    'tsconfig.json': '{}',
    'src/index.ts': 'export {};\n',
  }, 'release', ['stg']);

  const d = detectProject(path.join(clone, 'src')); // a folder inside the clone is fine
  assert.deepEqual(d.problems, []);
  assert.equal(d.facts.localPath, clone);
  assert.equal(d.facts.id, 'shop-api');
  assert.equal(d.facts.name, '@acme/shop-api');
  assert.equal(d.facts.remoteUrl, path.join(tmp, 'shop-api.git'));
  assert.equal(d.facts.prodBranch, 'release', "the remote's default branch");
  assert.equal(d.facts.stgBranch, 'stg');
  assert.equal(d.facts.verified, false, 'a detected project is never verified for you');
  assert.equal(d.facts.testCmd, 'npx --no-install jest --ci --maxWorkers=2', 'jest gets a worker cap');
  assert.equal(d.facts.typecheckCmd, 'npx --no-install tsc --noEmit');
  assert.equal(d.facts.installCmd, 'npm ci');
  assert.equal(d.facts.lintCmd, null, 'a lint script that fixes files is not used as a check');
  assert.ok(d.notes.some((n) => /fixes files/.test(n)));
  assert.ok(d.notes.some((n) => /Using the repository root/.test(n)));
});

test('what cannot be worked out is said, not guessed', () => {
  const plain = repo('notes', { 'README.md': 'hello\n' });
  const d = detectProject(plain);
  assert.equal(d.facts.prodBranch, 'main');
  assert.equal(d.facts.stgBranch, null);
  assert.deepEqual([d.facts.testCmd, d.facts.lintCmd, d.facts.typecheckCmd, d.facts.installCmd], [null, null, null, null]);
  assert.ok(d.notes.some((n) => /No staging branch found/.test(n)));
  assert.ok(d.notes.some((n) => /No known test setup/.test(n)));

  // No remote: a problem the developer has to fix, stated plainly.
  const local = path.join(tmp, 'local-only');
  execFileSync('git', ['init', '-q', '-b', 'main', local]);
  const noRemote = detectProject(local);
  assert.ok(noRemote.problems.some((p) => /no "origin" remote/.test(p)));
  assert.ok(noRemote.problems.some((p) => /which branch is production/.test(p)));
  assert.ok(noRemote.problems.some((p) => /no commits yet/.test(p)));

  const refused = (p: string, pattern: RegExp) => assert.throws(() => detectProject(p), (e: unknown) => e instanceof DetectError && pattern.test(e.message));
  refused('relative/path', /full path/);
  refused(path.join(tmp, 'does-not-exist'), /is not a folder/);
  refused(os.tmpdir(), /not inside a git repository/);
});

test('check commands follow the package manager and the scripts that exist', () => {
  const dir = (name: string, files: Record<string, string>) => {
    const d = path.join(tmp, `cmds-${name}`);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
    return d;
  };
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });
  assert.deepEqual(detectCommands(dir('yarn', { 'package.json': pkg({ test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' }), 'yarn.lock': '' }), []), {
    testCmd: 'yarn test', lintCmd: 'yarn lint', typecheckCmd: 'yarn typecheck', installCmd: 'yarn install --frozen-lockfile',
  });
  assert.deepEqual(detectCommands(dir('pnpm', { 'package.json': pkg({ test: 'node --test' }), 'pnpm-lock.yaml': '' }), []), {
    testCmd: 'pnpm test', lintCmd: null, typecheckCmd: null, installCmd: 'pnpm install --frozen-lockfile',
  });
  const placeholder: string[] = [];
  assert.equal(detectCommands(dir('none', { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) }), placeholder).testCmd, null);
  assert.ok(placeholder.some((n) => /No test script/.test(n)));
  assert.equal(detectCommands(dir('go', { 'go.mod': 'module x\n' }), []).testCmd, 'go test ./...');
  assert.equal(detectCommands(dir('make', { Makefile: 'build:\n\ttrue\ntest:\n\ttrue\n' }), []).testCmd, 'make test');
  fs.mkdirSync(path.join(tmp, 'cmds-py', 'tests'), { recursive: true });
  assert.equal(detectCommands(dir('py', { 'pyproject.toml': '' }), []).testCmd, 'python3 -m pytest -q');
});

test('a second project from a folder of the same name gets its own id', () => {
  const clone = repo('billing', { 'README.md': 'x\n' });
  assert.equal(detectProject(clone).facts.id, 'billing');
  saveProject({ id: 'billing', name: 'Billing', localPath: clone, prodBranch: 'main' });
  assert.equal(detectProject(clone).facts.id, 'billing-2');
});

test('credentials never leave a remote URL, and only real git URLs are cloned', async () => {
  assert.equal(withoutCredentials('https://someone:token123@github.com/acme/api.git'), 'https://github.com/acme/api.git');
  assert.equal(withoutCredentials('https://token123@github.com/acme/api.git'), 'https://github.com/acme/api.git');
  assert.equal(withoutCredentials('git@github.com:acme/api.git'), 'git@github.com:acme/api.git');

  for (const ok of ['https://github.com/acme/api.git', 'https://gitlab.example.com:8443/team/sub/api', 'git@github.com:acme/api.git', 'ssh://git@github.com/acme/api.git']) {
    assert.equal(isGitUrl(ok), true, ok);
  }
  for (const bad of ['--upload-pack=touch /tmp/x', '-oProxyCommand=x', 'file:///etc', '/local/path', 'ext::sh -c x', 'http://insecure.example/x.git', 'https://github.com/a b', '']) {
    assert.equal(isGitUrl(bad), false, bad);
    await assert.rejects(cloneRepository(bad, path.join(tmp, 'repos')), DetectError);
  }
  assert.equal(fs.existsSync(path.join(tmp, 'repos')), false, 'nothing was created for a refused URL');
});
