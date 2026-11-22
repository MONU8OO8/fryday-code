// The Jenkins client against a stand-in Jenkins, and the deploy settings.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const tmp = path.join(os.tmpdir(), `fryday-jenkins-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';

import { JenkinsClient, JenkinsError, jobPath, normaliseBase } from '../src/deploy/jenkins';
import { saveJenkinsCredentials, loadJenkinsCredentials, jenkinsStatus, removeJenkinsCredentials, validateDeployer, deployParams, inputKind, DeployConfigError } from '../src/deploy/config';
import { osascriptArgs } from '../src/notify/desktop';
import { StubJenkins } from './fixtures/stub-jenkins';

const SHA = 'a'.repeat(40);
const jenkins = new StubJenkins();
let client: JenkinsClient;

before(async () => {
  await jenkins.start();
  jenkins.addJob({
    name: 'apps/shop-deploy',
    parameters: [{ name: 'BRANCH', defaultValue: 'dev' }],
    stages: [{ name: 'Build' }, { name: 'Deploy to STG', input: { id: 'Stg1', message: 'Deploy to staging?' } }, { name: 'Deploy to PROD', input: { id: 'Prod1', message: 'Deploy to production?' } }],
    builtSha: () => SHA,
  });
  client = new JenkinsClient({ baseUrl: jenkins.url, user: jenkins.user, token: jenkins.token });
});
after(async () => { await jenkins.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('job names become Jenkins paths, and nothing else does', () => {
  assert.equal(jobPath('apps/shop deploy'), '/job/apps/job/shop%20deploy');
  assert.equal(jobPath('a'), '/job/a');
  for (const bad of ['', '/', 'a/../b', 'a/./b', ' ', 'a/ /b']) assert.throws(() => jobPath(bad), JenkinsError, bad);
});

test('the Jenkins address must be https, or http on this machine, with no credentials in it', () => {
  assert.equal(normaliseBase('https://ci.example.com/jenkins/').href, 'https://ci.example.com/jenkins');
  assert.equal(normaliseBase('http://127.0.0.1:8080').origin, 'http://127.0.0.1:8080');
  for (const bad of ['http://ci.example.com', 'ftp://ci.example.com', 'https://u:p@ci.example.com', 'https://ci.example.com/?x=1', 'not a url']) {
    assert.throws(() => normaliseBase(bad), JenkinsError, bad);
  }
});

test('every address Jenkins hands back is pinned to the configured Jenkins', () => {
  const c = new JenkinsClient({ baseUrl: 'https://ci.example.com/jenkins', user: 'u', token: 't' });
  assert.equal(c.urlFor('/job/x/api/json'), 'https://ci.example.com/jenkins/job/x/api/json');
  assert.equal(c.urlFor('/jenkins/queue/item/5/'), 'https://ci.example.com/jenkins/queue/item/5/');
  // Jenkins configured with the wrong root URL (http, another host name) still lands on the configured one.
  assert.equal(c.urlFor('http://ci.internal:8080/jenkins/queue/item/5/'), 'https://ci.example.com/jenkins/queue/item/5/');
  for (const bad of ['//evil.example/x', 'queue/item/1', '/jenkins/..%2f..', '\\\\evil']) {
    assert.throws(() => c.urlFor(bad), JenkinsError, bad);
  }
});

test('the client reads a job, starts a build with its parameters and a crumb, and follows it to a prompt', async () => {
  assert.equal(await client.whoAmI(), 'FryDay Test');
  const info = await client.jobInfo('apps/shop-deploy');
  assert.deepEqual(info.parameters, [{ name: 'BRANCH', type: 'StringParameterDefinition', defaultValue: 'dev' }]);

  const queuePath = await client.trigger('apps/shop-deploy', { BRANCH: 'stg' });
  assert.match(queuePath, /^\/queue\/item\/\d+\/$/);
  const post = jenkins.actions.at(-1)!;
  assert.equal(post.path, '/job/apps/job/shop-deploy/buildWithParameters');
  assert.equal(post.body, 'BRANCH=stg');
  assert.equal(post.crumb, jenkins.crumb, 'a POST carries the CSRF crumb');

  assert.equal((await client.queueItem(queuePath)).buildNumber, null);
  const started = await client.queueItem(queuePath);
  assert.equal(started.buildNumber, 101);

  const b1 = await client.build('apps/shop-deploy', 101);
  assert.equal(b1.builtSha, SHA);
  assert.deepEqual(b1.builtShas, [SHA]);
  let inputs = await client.pendingInputs('apps/shop-deploy', 101);
  for (let i = 0; i < 5 && inputs.length === 0; i++) { await client.build('apps/shop-deploy', 101); inputs = await client.pendingInputs('apps/shop-deploy', 101); }
  assert.deepEqual(inputs, [{ id: 'Stg1', message: 'Deploy to staging?', proceedText: 'Proceed', hasParameters: false }]);
  const stages = await client.stages('apps/shop-deploy', 101);
  assert.deepEqual(stages?.stages.map((s) => s.status), ['SUCCESS', 'PAUSED_PENDING_INPUT', 'NOT_EXECUTED']);
  await client.proceed('apps/shop-deploy', 101, 'Stg1');
  assert.equal(jenkins.actions.at(-1)!.path, '/job/apps/job/shop-deploy/101/input/Stg1/proceedEmpty');
  await assert.rejects(() => client.proceed('apps/shop-deploy', 101, '../x'), JenkinsError);
});

test('wrong credentials, a missing job, a redirect elsewhere and an odd queue address are errors, not guesses', async () => {
  const wrong = new JenkinsClient({ baseUrl: jenkins.url, user: jenkins.user, token: 'nope' });
  await assert.rejects(() => wrong.whoAmI(), /refused the request \(401\)/);
  await assert.rejects(() => client.jobInfo('apps/missing'), /has nothing at/);
  await assert.rejects(() => client.trigger('apps/missing', {}), /no job apps\/missing/);

  jenkins.locationOverride = () => 'http://evil.example/steal/';
  await assert.rejects(() => client.trigger('apps/shop-deploy', { BRANCH: 'stg' }), /did not say which queue item/);
  jenkins.locationOverride = null;

  jenkins.redirectEverythingTo = 'http://evil.example/';
  await assert.rejects(() => client.whoAmI(), JenkinsError, 'a redirect is not followed');
  jenkins.redirectEverythingTo = null;
  assert.ok(!jenkins.requests.some((r) => r.path.includes('steal')));
});

test('credentials are kept in a file only the owner reads, and never shown again', () => {
  assert.equal(jenkinsStatus().configured, false);
  assert.throws(() => saveJenkinsCredentials({ baseUrl: 'http://ci.example.com', user: 'u', token: 't' }), DeployConfigError);
  assert.throws(() => saveJenkinsCredentials({ baseUrl: 'https://ci.example.com', user: '', token: 't' }), /user name/);
  assert.throws(() => saveJenkinsCredentials({ baseUrl: 'https://ci.example.com', user: 'u', token: '' }), /API token/);
  const status = saveJenkinsCredentials({ baseUrl: 'https://ci.example.com/', user: 'me', token: 'secret-token-value' });
  assert.deepEqual(status, { configured: true, baseUrl: 'https://ci.example.com', user: 'me' });
  assert.ok(!JSON.stringify(status).includes('secret-token-value'));
  const file = path.join(tmp, 'jenkins.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadJenkinsCredentials()?.token, 'secret-token-value');
  assert.equal(removeJenkinsCredentials().configured, false);
  assert.equal(fs.existsSync(file), false);
});

test('a deployer is checked when it is entered, and gets its defaults', () => {
  assert.equal(validateDeployer(null, null), null);
  const d = validateDeployer('jenkins', { job: 'apps/shop-deploy', branchParam: 'BRANCH', stage: 'Deploy to STG' })!;
  assert.deepEqual(d, { job: 'apps/shop-deploy', branchParam: 'BRANCH', params: {}, stage: 'Deploy to STG', timeoutMinutes: 60 });
  assert.deepEqual(deployParams({ ...d, params: { ENV: 'stg' } }, 'stg'), { ENV: 'stg', BRANCH: 'stg' });
  for (const bad of [{}, { job: '' }, { job: 'a/../b' }, { job: 'x', branchParam: 'has space' }, { job: 'x', branchParam: 'B', params: { B: 'main' } }, { job: 'x', surprise: 1 }, { job: 'x', timeoutMinutes: 0 }]) {
    assert.throws(() => validateDeployer('jenkins', bad), DeployConfigError, JSON.stringify(bad));
  }
  assert.throws(() => validateDeployer('github', { job: 'x' }), /Unknown deployer/);
});

test('a prompt is answered for staging only: production, or anything unclear, never', () => {
  assert.equal(inputKind('Deploy to STG', 'Approve?', 'Proceed'), 'staging');
  assert.equal(inputKind(null, 'Deploy to staging?', 'Yes'), 'staging');
  assert.equal(inputKind('Deploy to PROD', 'Approve?', 'Proceed'), 'production');
  assert.equal(inputKind('Deploy to STG', 'Promote to production?', 'Proceed'), 'production', 'production anywhere wins');
  assert.equal(inputKind('Deploy', 'Go live now?', 'Proceed'), 'production');
  assert.equal(inputKind('Deploy', 'Approve?', 'Proceed'), 'unclear');
  assert.equal(inputKind('Release', 'Continue?', 'OK'), 'unclear');
});

test('the Mac notification gets the text as arguments, never as part of the script', () => {
  const args = osascriptArgs('FryDay · T-1', 'Title" & (do shell script "touch /tmp/pwned") & "');
  const script = args.filter((_, i) => args[i - 1] === '-e');
  assert.ok(script.every((l) => !l.includes('pwned')), 'the script lines are fixed');
  assert.equal(args.at(-1), 'Title" & (do shell script "touch /tmp/pwned") & "');
  assert.equal(osascriptArgs('t', 'x'.repeat(1000)).at(-1)!.length, 240);
});
