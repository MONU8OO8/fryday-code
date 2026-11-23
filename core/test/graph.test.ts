// The service graph: matching env keys to projects by name, and the owner's edits winning
// over every rescan (confirmations, renames, added links, and deletions kept as tombstones).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const tmp = path.join(os.tmpdir(), `fryday-graph-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';

import { initDb, getDb } from '../src/db/db';
import { removeProject, saveProject } from '../src/registry/registry';
import {
  addEdge, addService, applyScan, confirmEdge, datastoreOf, deleteEdge, envNode, extNode, forgetProject, graphView,
  GraphEditError, liveEdges, matchKey, projectNode, projectPanel, refreshProject, renameNode, serviceLinks,
} from '../src/knowledge/graph';
import type { ScanFacts } from '../src/knowledge/scan';

before(() => initDb(process.env.FRYDAY_DB!));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const facts = (over: Partial<ScanFacts>): ScanFacts => ({
  sha: 'a'.repeat(40), packageName: null, packages: [], scripts: [], dependencies: [], frameworks: [], topDirs: [], modules: [], entryPoints: [],
  envKeys: [], outbound: [], hosts: [], routes: [], composeServices: [], truncated: false, ...over,
});

const PROJECTS = [
  { id: 'acme-credit-service', name: 'Acme credit service' },
  { id: 'acme-loan-service', name: 'Acme loan service' },
  { id: 'acme-web', name: 'Acme website' },
  { id: 'acme-bff', name: 'Acme common layer' },
];

test('an env key is matched to the project it names; a vague or tied key is not', () => {
  assert.equal(matchKey('CREDIT_SERVICE_URL', PROJECTS)?.projectId, 'acme-credit-service');
  assert.equal(matchKey('LOAN_SERVICE_BASE_URL', PROJECTS)?.projectId, 'acme-loan-service');
  assert.equal(matchKey('NEXT_PUBLIC_BFF_URL', PROJECTS)?.projectId, 'acme-bff');
  assert.equal(matchKey('NEXT_PUBLIC_COMMON_LAYER_URL', PROJECTS)?.projectId, 'acme-bff', 'two generic words together still name a project');
  assert.equal(matchKey('SERVICE_URL', PROJECTS), null, 'a generic word alone is not a match');
  assert.equal(matchKey('ACME_URL', PROJECTS), null, 'the shared company prefix tells projects apart no better');
  assert.equal(matchKey('PAYMENTS_HOST', PROJECTS), null);
  const guess = matchKey('CREDIT_SERVICE_URL', PROJECTS)!;
  assert.ok(guess.confidence > 0 && guess.confidence < 1, 'a name match is a guess until the owner confirms it');
  assert.equal(matchKey('CORE_URL', [{ id: 'core-a', name: 'Core A' }, { id: 'core-b', name: 'Core B' }]), null, 'equally good matches are not picked between');
  assert.equal(datastoreOf('REDIS_HOST'), 'Redis');
  assert.equal(datastoreOf('DATABASE_URL'), 'Database');
  assert.equal(datastoreOf('CREDIT_SERVICE_URL'), null);
});

test('a scan links a project to the projects and services it calls', () => {
  for (const p of PROJECTS) saveProject({ id: p.id, name: p.name, localPath: `/repos/${p.id}`, prodBranch: 'main' });
  applyScan(PROJECTS[0]!, facts({ routes: [{ method: 'GET', path: '/score', file: 'src/score.controller.ts' }] }));
  applyScan(PROJECTS[3]!, facts({
    outbound: [{ key: 'CREDIT_SERVICE_URL', files: ['src/credit/client.ts'] }, { key: 'REDIS_HOST', files: ['src/cache.ts'] }, { key: 'PAYMENTS_HOST', files: [] }],
    hosts: [{ host: 'api.partner-bank.test', files: ['src/bank.ts'] }],
  }));
  const links = serviceLinks();
  const bff = projectNode('acme-bff');
  const toCredit = links.find((l) => l.from === bff && l.to === projectNode('acme-credit-service'))!;
  assert.ok(toCredit, 'the BFF calls the credit service through CREDIT_SERVICE_URL');
  assert.equal(toCredit.confirmed, false);
  assert.ok(toCredit.confidence < 1);
  assert.equal(toCredit.via[0]!.label, 'CREDIT_SERVICE_URL');
  assert.ok(links.some((l) => l.from === bff && l.to === extNode('Redis')));
  assert.ok(links.some((l) => l.from === bff && l.to === extNode('api.partner-bank.test') && l.confidence === 1), 'a literal host is seen, not guessed');
  const panel = projectPanel('acme-bff');
  assert.equal(panel.keys.find((k) => k.key === 'PAYMENTS_HOST')!.servedBy, null, 'an unmatched key is shown as not linked');
  assert.deepEqual(projectPanel('acme-credit-service').exposes, ['GET /score']);
  assert.equal(projectPanel('acme-credit-service').calledBy.length, 1);
});

test('owner edits survive a rescan: confirmed, deleted, renamed and added', () => {
  const bff = PROJECTS[3]!;
  const scan = facts({
    outbound: [{ key: 'CREDIT_SERVICE_URL', files: ['src/credit/client.ts'] }, { key: 'LOAN_SERVICE_URL', files: ['src/loan.ts'] }, { key: 'REDIS_HOST', files: [] }],
  });
  applyScan(bff, scan);
  const creditKey = envNode('acme-bff', 'CREDIT_SERVICE_URL');
  const loanKey = envNode('acme-bff', 'LOAN_SERVICE_URL');

  confirmEdge(creditKey, projectNode('acme-credit-service'), 'served_by');
  deleteEdge(loanKey, projectNode('acme-loan-service'), 'served_by');
  renameNode(extNode('Redis'), 'Session cache');
  const web = projectNode('acme-web');
  applyScan(PROJECTS[2]!, facts({}));
  addEdge(web, projectNode('acme-bff'), 'calls');

  applyScan(bff, scan);
  applyScan(PROJECTS[2]!, facts({}));

  const edges = liveEdges();
  const credit = edges.find((e) => e.from === creditKey && e.kind === 'served_by')!;
  assert.equal(credit.confirmed, true);
  assert.equal(credit.source, 'owner');
  assert.equal(credit.confidence, 1);
  assert.ok(!edges.some((e) => e.from === loanKey && e.to === projectNode('acme-loan-service')), 'a deleted guess does not come back');
  const tomb = getDb().prepare(`SELECT deleted FROM graph_edges WHERE from_id = ? AND to_id = ?`).get(loanKey, projectNode('acme-loan-service')) as { deleted: number };
  assert.equal(tomb.deleted, 1);
  assert.ok(edges.some((e) => e.from === web && e.to === projectNode('acme-bff') && e.source === 'owner'), 'an added link stays');
  assert.equal(graphView().services.find((n) => n.id === extNode('Redis'))!.label, 'Session cache');

  // Adding back a link the owner deleted restores it.
  addEdge(loanKey, projectNode('acme-loan-service'), 'served_by');
  assert.ok(liveEdges().some((e) => e.from === loanKey && e.to === projectNode('acme-loan-service') && e.confirmed));
});

test('the owner says where a key goes: the guesses for it are dropped and a rescan does not add them back', () => {
  const key = envNode('acme-bff', 'REDIS_HOST');
  const svc = addService('Shared Redis cluster');
  addEdge(key, svc.id, 'served_by');
  applyScan(PROJECTS[3]!, facts({ outbound: [{ key: 'REDIS_HOST', files: [] }] }));
  const targets = liveEdges().filter((e) => e.from === key && e.kind === 'served_by').map((e) => e.to);
  assert.deepEqual(targets, [svc.id]);
  assert.ok(graphView().services.some((n) => n.id === extNode('Redis') && n.label === 'Session cache'), 'a service the owner named stays even with nothing pointing at it');
  applyScan(PROJECTS[0]!, facts({ hosts: [{ host: 'old.partner.test', files: [] }] }));
  applyScan(PROJECTS[0]!, facts({}));
  assert.ok(!graphView().services.some((n) => n.id === extNode('old.partner.test')), 'a scanned outside service nothing points at any more is removed');
  assert.ok(graphView().services.some((n) => n.id === projectNode('acme-loan-service')), 'a project that was never scanned is still on the graph');
});

test('owner edits are checked', () => {
  assert.throws(() => addEdge(projectNode('acme-web'), projectNode('nope'), 'calls'), GraphEditError);
  assert.throws(() => addEdge(projectNode('acme-web'), projectNode('acme-web'), 'calls'), GraphEditError);
  assert.throws(() => addEdge(extNode('api.partner-bank.test'), projectNode('acme-web'), 'calls'), GraphEditError, 'an outside service does not call a project');
  assert.throws(() => confirmEdge(projectNode('acme-web'), projectNode('acme-loan-service'), 'calls'), GraphEditError);
  assert.throws(() => renameNode(projectNode('acme-web'), '\u0000 '), GraphEditError);
  assert.equal(renameNode(projectNode('acme-web'), 'x'.repeat(300)).label.length, 120);
});

test('refreshing a project scans its production commit once per commit and records a scan that cannot run', async () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const g = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'src/a.ts'), "const u = process.env.CREDIT_SERVICE_URL;\nrouter.get('/ping', h);\n");
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  saveProject({ id: 'scratch-app', name: 'Scratch app', localPath: repo, prodBranch: 'main' });

  const first = await refreshProject('scratch-app');
  assert.equal(first?.error, null);
  assert.match(first!.sha!, /^[0-9a-f]{40}$/);
  assert.ok(serviceLinks().some((l) => l.from === projectNode('scratch-app') && l.to === projectNode('acme-credit-service')));
  assert.deepEqual(projectPanel('scratch-app').exposes, ['GET /ping']);

  const again = await refreshProject('scratch-app');
  assert.equal(again!.scannedAt, first!.scannedAt, 'the same commit is not scanned twice');
  const forced = await refreshProject('scratch-app', { force: true });
  assert.ok(forced!.scannedAt >= first!.scannedAt);

  saveProject({ id: 'scratch-app', name: 'Scratch app', localPath: repo, prodBranch: 'release' });
  const failed = await refreshProject('scratch-app');
  assert.match(failed!.error!, /no commit for release/);
  assert.ok(!failed!.error!.includes(tmp), 'the clone path is not shown');

  removeProject('scratch-app');
  forgetProject('scratch-app');
  assert.ok(!liveEdges().some((e) => e.projectId === 'scratch-app'));
  assert.ok(!graphView().services.some((n) => n.id === projectNode('scratch-app')));
});
