// The project map agents get: within its character budget, cached per project and production
// commit, labelled as generated material, with the project's neighbours from the graph.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const tmp = path.join(os.tmpdir(), `fryday-digest-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';

import { initDb, getDb } from '../src/db/db';
import { saveProject } from '../src/registry/registry';
import { refreshProject } from '../src/knowledge/graph';
import { DIGEST_CHARS, MAP_LABEL, dependencyOrder, projectDigest, projectMap, projectOverview, projectsForLead, renderDigest } from '../src/knowledge/digest';
import type { ScanFacts } from '../src/knowledge/scan';

before(() => initDb(process.env.FRYDAY_DB!));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const g = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });

function repoWith(name: string, files: Record<string, string>): string {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-q', '-b', 'main');
  commit(repo, files);
  return repo;
}

function commit(repo: string, files: Record<string, string>): void {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  }
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'change');
}

const base: ScanFacts = {
  sha: 'abcdef0123456789abcdef0123456789abcdef01', packageName: 'svc', packages: [], scripts: ['build', 'test'], dependencies: [], frameworks: ['NestJS'],
  topDirs: [{ dir: 'src', files: 40 }], modules: [{ dir: 'src/cards', files: 12 }], entryPoints: ['src/main.ts'], envKeys: ['PORT', 'CREDIT_SERVICE_URL'],
  outbound: [{ key: 'CREDIT_SERVICE_URL', files: [] }], hosts: [], routes: [{ method: 'GET', path: '/cards', file: 'x' }], composeServices: [], truncated: false,
};
const project = { id: 'svc', name: 'Card service', testCmd: 'npm test', lintCmd: null, typecheckCmd: 'npx tsc --noEmit' };

test('the digest says what is in the project and stays within its budget however big the project is', () => {
  const small = renderDigest(project, base);
  assert.match(small, /^### Card service \(svc\) at abcdef0/);
  assert.match(small, /Built with: NestJS/);
  assert.match(small, /Checks: test `npm test` · typecheck `npx tsc --noEmit`/);
  assert.match(small, /Exposes 1 route: GET \/cards/);
  assert.match(small, /Calls out through: CREDIT_SERVICE_URL/);

  const huge: ScanFacts = {
    ...base,
    routes: Array.from({ length: 400 }, (_, i) => ({ method: 'GET', path: `/a/very/long/route/number/${i}/with/segments`, file: 'x' })),
    envKeys: Array.from({ length: 200 }, (_, i) => `SOME_LONG_ENVIRONMENT_KEY_${i}`),
    outbound: Array.from({ length: 200 }, (_, i) => ({ key: `UPSTREAM_SERVICE_${i}_URL`, files: [] })),
  };
  const big = renderDigest(project, huge);
  assert.ok(big.length <= DIGEST_CHARS, `${big.length} > ${DIGEST_CHARS}`);
  assert.match(big, /Exposes 400 routes: .*\(\+\d+ more\)/, 'lists shrink and say how many were left out');
  assert.ok(renderDigest(project, huge, 300).length <= 300, 'even a tiny budget is kept');
});

test('the digest is cached per production commit and rebuilt when production moves', async () => {
  const repo = repoWith('svc', { 'package.json': JSON.stringify({ name: 'svc', scripts: { test: 'node --test' } }), 'src/a.ts': "router.get('/one', h);" });
  saveProject({ id: 'svc', name: 'Card service', localPath: repo, prodBranch: 'main', testCmd: 'npm test' });
  assert.equal(projectDigest('svc'), null, 'never scanned: no digest');
  await refreshProject('svc');
  const first = projectDigest('svc')!;
  assert.match(first, /GET \/one/);
  const sha = (getDb().prepare(`SELECT sha FROM graph_scans WHERE project_id = 'svc'`).get() as { sha: string }).sha;

  getDb().prepare(`UPDATE graph_scans SET digest = 'from the cache' WHERE project_id = 'svc' AND sha = ?`).run(sha);
  assert.equal(projectDigest('svc'), 'from the cache', 'the same commit reads the cache');

  commit(repo, { 'src/b.ts': "router.post('/two', h);" });
  await refreshProject('svc');
  const second = projectDigest('svc')!;
  assert.notEqual(second, 'from the cache', 'a new commit is a new cache key');
  assert.match(second, /POST \/two/);
});

test('the map is labelled as generated material and carries the neighbours; an unscanned project gets none', async () => {
  const web = repoWith('web', { 'package.json': JSON.stringify({ name: 'web', dependencies: { next: '14', react: '18' } }), 'lib/api.ts': 'const u = process.env.NEXT_PUBLIC_CARD_SERVICE_URL;' });
  saveProject({ id: 'web', name: 'Shop website', localPath: web, prodBranch: 'main', verified: true });
  saveProject({ id: 'svc', name: 'Card service', localPath: path.join(tmp, 'svc'), prodBranch: 'main', testCmd: 'npm test', verified: true });
  await refreshProject('web');
  await refreshProject('svc');

  const map = projectMap('T-none', 'web');
  assert.ok(map.startsWith(`## ${MAP_LABEL}`));
  assert.match(map, /Built with: Next\.js, React/);
  assert.match(map, /calls Card service \[project svc\] via NEXT_PUBLIC_CARD_SERVICE_URL \(guess from names\)/);
  assert.match(projectMap('T-none', 'svc'), /is called by Shop website \[project web\]/);
  assert.equal(projectMap('T-none', 'nope'), '');
  assert.equal(projectMap('T-none', null), '');
  assert.ok(!map.includes(tmp), 'no machine paths');

  assert.match(projectOverview('web'), /Calls: svc \(guess from names\)/);
  assert.deepEqual(dependencyOrder(['web', 'svc']), ['svc', 'web'], 'the backend comes before the app that calls it');
  assert.ok(projectsForLead('web').some((l) => /^- svc: Card service \(.*called by web/.test(l)));
});
