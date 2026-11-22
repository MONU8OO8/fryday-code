import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb } from '../src/db/db';
import {
  saveProject, getRepo, listRepos, overrideRepo, setVerified, removeProject, importSeedIfEmpty, ProjectError,
} from '../src/registry/registry';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-projects-'));
before(() => { initDb(path.join(tmp, 'test.db')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a fresh install has no projects, and a seed file fills it once', () => {
  assert.deepEqual(listRepos(), []);
  const seed = path.join(tmp, 'projects.seed.json');
  assert.equal(importSeedIfEmpty(seed), 0, 'no seed file is not an error');

  fs.writeFileSync(seed, JSON.stringify([
    { id: 'api', name: 'API', localPath: '/repos/api', prodBranch: 'main', stgBranch: 'stg', verified: true,
      deployer: 'jenkins', deployerConfig: { job: 'team/api', branchParam: 'BRANCH' } },
    { id: 'Bad Id', name: 'x', localPath: '/repos/x', prodBranch: 'main' },
    { id: 'web', name: 'Web', localPath: '/repos/web', prodBranch: 'main' },
  ]));
  assert.equal(importSeedIfEmpty(seed), 2, 'the invalid entry is skipped, the rest are imported');
  assert.deepEqual(listRepos().map((p) => p.id), ['api', 'web']);
  // Stored with its defaults filled in, like the run profile.
  assert.deepEqual(getRepo('api')!.deployerConfig, { job: 'team/api', branchParam: 'BRANCH', params: {}, stage: null, timeoutMinutes: 60 });
  assert.equal(getRepo('web')!.verified, false, 'nothing is verified unless it says so');

  // Once there are projects the seed is never applied again.
  removeProject('web');
  assert.equal(importSeedIfEmpty(seed), 0);
  assert.equal(getRepo('web'), undefined);
});

test('a project is added with sensible defaults and its facts can be changed', () => {
  const added = saveProject({ id: 'svc', name: 'Service', localPath: '/repos/svc', prodBranch: 'release' });
  assert.deepEqual(added, {
    id: 'svc', name: 'Service', localPath: '/repos/svc', remoteUrl: null, prodBranch: 'release', stgBranch: null,
    testCmd: null, lintCmd: null, typecheckCmd: null, installCmd: null, runProfile: null, deployer: null,
    deployerConfig: null, verified: false, notes: '',
  });

  const changed = overrideRepo('svc', { testCmd: 'npm test', stgBranch: 'stg', runProfile: { command: 'npm start', port: 3000 } });
  assert.equal(changed.testCmd, 'npm test');
  // A run profile is stored with its defaults filled in, so what is shown is what will be used.
  assert.deepEqual(changed.runProfile, { command: 'npm start', port: 3000, readyPath: '/', readyTimeoutSec: 60, env: {}, envFile: null, api: true, ui: false, uiPath: '/' });
  assert.equal(changed.name, 'Service', 'facts that were not mentioned are kept');
  assert.equal(setVerified('svc', true).verified, true);
  assert.equal(setVerified('svc', false).verified, false);

  assert.equal(removeProject('svc'), true);
  assert.equal(removeProject('svc'), false);
});

test('facts that would break a release are refused', () => {
  const base = { id: 'ok', name: 'Ok', localPath: '/repos/ok', prodBranch: 'main' };
  const refused = (input: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => saveProject({ ...base, ...input } as never), (e: unknown) => e instanceof ProjectError && pattern.test(e.message));
  refused({ id: 'Has Spaces' }, /project id/);
  refused({ id: '../escape' }, /project id/);
  refused({ name: '  ' }, /needs a name/);
  refused({ localPath: 'relative/path' }, /must be absolute/);
  refused({ prodBranch: '' }, /production branch/);
  refused({ stgBranch: 'main' }, /cannot be the same branch/);
  assert.equal(getRepo('ok'), undefined, 'nothing was stored for a refused project');
  assert.throws(() => overrideRepo('nope', { name: 'x' }), /Unknown project/);

  saveProject(base);
  assert.throws(() => overrideRepo('ok', { stgBranch: 'main' }), /cannot be the same branch/);
  assert.equal(getRepo('ok')!.stgBranch, null, 'a refused change leaves the project as it was');
});
