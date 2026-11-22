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
import { saveJenkinsCredentials, loadJenkinsCredentials, jenkinsStatus, removeJenkinsCredentials, validateDeployer, deployParams, inputKind, DeployConfigError, checkJenkins, readCredentials } from '../src/deploy/config';
import { osascriptArgs } from '../src/notify/desktop';
import { StubJenkins } from './fixtures/stub-jenkins';
import { credentialsFromMcp, envInsteadOfServer, findJenkinsServer, FromMcpError } from '../src/deploy/fromMcp';

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

// ─── Checking a setup before it is kept ───────────────────────────────────────
// A deploy is the one thing FryDay cannot try out for itself, so what the owner types is put to
// Jenkins when they type it. Before this, a wrong token sat there looking set up until a deploy
// failed on it, and a job name that was never there failed the same way.

const good = () => ({ baseUrl: jenkins.url, user: jenkins.user, token: jenkins.token });

test('a token Jenkins refuses is told apart from a Jenkins that cannot be reached', async () => {
  const refused = await checkJenkins({ ...good(), token: 'not-the-token' });
  assert.equal(refused.ok, false);
  assert.equal(refused.unreachable, false, 'Jenkins answered, so this is about the token');
  assert.match(refused.problem!, /refused the request \(401\)/);

  // Nothing listening: that says nothing about whether the credentials are right.
  const down = await checkJenkins({ ...good(), baseUrl: 'http://127.0.0.1:1' });
  assert.equal(down.ok, false);
  assert.equal(down.unreachable, true);

  const ok = await checkJenkins(good());
  assert.deepEqual([ok.ok, ok.user, ok.problem], [true, 'FryDay Test', null]);
});

test('a job that is not there answers with the names that are', async () => {
  jenkins.addJob({ name: 'apps/shop-api', parameters: [{ name: 'BRANCH', defaultValue: 'dev' }], stages: [] });
  const missing = await checkJenkins(good(), { name: 'apps/shop-deployment', branchParam: 'BRANCH' });
  assert.equal(missing.ok, false);
  assert.match(missing.problem!, /^There is no job named apps\/shop-deployment on this Jenkins\.$/);
  assert.ok(missing.didYouMean.includes('apps/shop-deploy'), `got ${JSON.stringify(missing.didYouMean)}`);
  // The user is known even though the job is not: the credentials are not what is wrong here.
  assert.equal(missing.user, 'FryDay Test');

  const found = await checkJenkins(good(), { name: 'apps/shop-deploy', branchParam: 'BRANCH' });
  assert.equal(found.ok, true);
});

test('a job that cannot take the branch is caught before any deploy is offered', async () => {
  jenkins.addJob({ name: 'apps/no-params', parameters: [], stages: [] });
  const noParam = await checkJenkins(good(), { name: 'apps/no-params', branchParam: 'BRANCH' });
  assert.equal(noParam.ok, false);
  assert.match(noParam.problem!, /no "BRANCH" parameter \(it takes no parameters\)/);

  jenkins.addJob({ name: 'apps/other-param', parameters: [{ name: 'REF', defaultValue: 'dev' }], stages: [] });
  const wrong = await checkJenkins(good(), { name: 'apps/other-param', branchParam: 'BRANCH' });
  assert.match(wrong.problem!, /no "BRANCH" parameter \(it takes REF\)/);
});

test('the three fields are read and tidied before anything is tried', () => {
  const c = readCredentials({ baseUrl: `${jenkins.url}/`, user: ' me ', token: ' t0ken ' });
  assert.deepEqual([c.baseUrl, c.user, c.token], [jenkins.url, 'me', 't0ken']);
  for (const bad of [{ user: 'a b' }, { user: 'a:b' }, { user: '' }, { token: '' }, { token: 'has space' }]) {
    assert.throws(() => readCredentials({ baseUrl: jenkins.url, user: 'me', token: 'tok', ...bad }), DeployConfigError, JSON.stringify(bad));
  }
});

// ─── Taking the settings from Claude Code's MCP server ────────────────────────
// The developer's credentials live in one file of their own. Rather than a second copy here,
// the server's own setup line is run with the server it would start replaced by `env`.

/** A settings file like Claude Code's, with one server started the way this machine starts them. */
function claudeSettings(servers: Record<string, unknown>): string {
  const file = path.join(tmp, `claude-${randomBytes(3).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return file;
}
const shellServer = (line: string) => ({ type: 'stdio', command: '/bin/sh', args: ['-c', line] });

test('the server that talks to Jenkins is found by its name or by what it starts', () => {
  const byName = claudeSettings({ postman: shellServer('exec true'), jenkins: shellServer('exec true') });
  assert.equal(findJenkinsServer(byName)?.name, 'jenkins');
  const byCommand = claudeSettings({ build: shellServer('exec node /opt/jenkins-mcp-runner.js') });
  assert.equal(findJenkinsServer(byCommand)?.name, 'build');
  assert.equal(findJenkinsServer(claudeSettings({ postman: shellServer('exec true') })), null);
  assert.equal(findJenkinsServer(path.join(tmp, 'not-a-file.json')), null);
});

test('the line that starts the server becomes a line that prints its environment', () => {
  assert.deepEqual(envInsteadOfServer(['-lc', 'source creds && load_jenkins && exec node runner.js']),
    ['-lc', 'source creds && load_jenkins && env']);
  assert.deepEqual(envInsteadOfServer(['-lc', 'exec node a.js --flag x']), ['-lc', 'env']);
  // Nothing is exec'd, so stopping short of starting the server is not possible: say so instead.
  assert.equal(envInsteadOfServer(['-lc', 'node runner.js']), null);
  assert.equal(envInsteadOfServer([]), null);
});

test('the address, user and token are read from the server without starting it', async () => {
  // `exec node …` would never return; that it does proves the server itself was not started.
  const file = claudeSettings({
    jenkins: shellServer(`export MCP_JENKINS_URL='${jenkins.url}/' MCP_JENKINS_USER='${jenkins.user}' MCP_JENKINS_API_TOKEN='${jenkins.token}' && exec node /does/not/exist.js`),
  });
  const { server, creds } = await credentialsFromMcp(file);
  assert.equal(server, 'jenkins');
  assert.deepEqual(creds, { baseUrl: jenkins.url, user: jenkins.user, token: jenkins.token });
  // And they are the real thing: Jenkins accepts them.
  assert.equal((await checkJenkins(creds)).ok, true);
});

test('the server\'s own MCP_ settings win over others left in the environment', async () => {
  const file = claudeSettings({
    jenkins: shellServer(`export JENKINS_URL='http://other.invalid' JENKINS_USER='someone-else' JENKINS_PASSWORD='old' MCP_JENKINS_URL='${jenkins.url}' MCP_JENKINS_USER='${jenkins.user}' MCP_JENKINS_API_TOKEN='${jenkins.token}' && exec node x.js`),
  });
  const { creds } = await credentialsFromMcp(file);
  assert.deepEqual([creds.baseUrl, creds.user, creds.token], [jenkins.url, jenkins.user, jenkins.token]);
});

test('what cannot be read says what is missing, and never half-sets anything up', async () => {
  await assert.rejects(credentialsFromMcp(claudeSettings({ postman: shellServer('exec true') })), FromMcpError);
  // A server that is not started by exec'ing something cannot be read without starting it.
  await assert.rejects(credentialsFromMcp(claudeSettings({ jenkins: { type: 'stdio', command: '/bin/sh', args: ['-c', 'node runner.js'] } })), /not started by a shell line that execs it/);
  // It ran, but the variables are not there.
  await assert.rejects(
    credentialsFromMcp(claudeSettings({ jenkins: shellServer("export MCP_JENKINS_URL='http://x.invalid' && exec node x.js") })),
    /the user and the token could not be found/);
});

// Real Jenkins ties a crumb to the session it was issued to. Signing in with an API token is
// exempt from that check, but a password is not: FryDay sent the crumb without the session and
// every deploy was refused with 403, which reads like "you may not build this job".
test('the session the crumb was issued to is carried to the build, so it is not refused', async () => {
  jenkins.requireSessionWithCrumb = true;
  try {
    const fresh = new JenkinsClient({ baseUrl: jenkins.url, user: jenkins.user, token: jenkins.token });
    const queued = await fresh.trigger('apps/shop-deploy', { BRANCH: 'stg' });
    assert.match(queued, /^\/queue\/item\/\d+\//);
    const posted = jenkins.requests.filter((r) => r.method === 'POST').at(-1)!;
    assert.ok(posted.crumb, 'the crumb is sent');
  } finally {
    jenkins.requireSessionWithCrumb = false;
  }
});
