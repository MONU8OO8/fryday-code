import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConnections, guessEnvironment, readMcpServers, realProbe, type Probe, type RunResult } from '../src/connections/doctor';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const fails = (code: number | null = 1, stderr = ''): RunResult => ({ code, stdout: '', stderr });

/** A machine where everything works; each test breaks one thing. */
function machine(change: Partial<Probe> & { answers?: Record<string, RunResult> } = {}): Probe {
  const answers: Record<string, RunResult> = {
    'claude --version': ok('2.1.0 (Claude Code)\n'),
    'claude auth status': ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'someone@example.com', orgName: 'Secret Org' })),
    'git --version': ok('git version 2.50.0\n'),
    'git config --global user.name': ok('Dev\n'),
    'git config --global user.email': ok('dev@example.com\n'),
    'gh auth status': ok('Logged in to github.com account dev-account\n'),
    'cursor-agent --version': ok('1.2.3\n'),
    ...change.answers,
  };
  return {
    which: (name) => `/usr/local/bin/${name.split('/').pop()}`,
    run: async (file, args) => answers[`${file.split('/').pop()} ${args.join(' ')}`] ?? fails(null),
    readFile: () => JSON.stringify({ mcpServers: {} }),
    exists: () => true,
    sandbox: async () => ({ ok: true, detail: '' }),
    platform: 'darwin',
    nodeVersion: 'v22.12.0',
    totalMemoryBytes: 16 * 1024 ** 3,
    memoryPressure: () => 1,
    home: '/Users/dev',
    claudeBin: 'claude',
    apiKeySet: false,
    cursorKeySet: true,
    ...change,
  };
}
const byId = async (p: Probe) => Object.fromEntries((await checkConnections(p)).checks.map((c) => [c.id, c]));

test('a machine where everything works reports every check as ok', async () => {
  const report = await checkConnections(machine());
  assert.deepEqual(report.checks.map((c) => `${c.id}:${c.state}`), [
    'claude:ok', 'sandbox:ok', 'git:ok', 'github:ok', 'node:ok', 'machine:ok', 'browser:ok', 'cursor:ok',
  ]);
});

test('Cursor is optional: without a key it says what is missing, and it is never required', async () => {
  const noKey = (await byId(machine({ cursorKeySet: false })))['cursor']!;
  assert.equal(noKey.state, 'warn');
  assert.match(noKey.summary, /no Cursor API key is set/);
  assert.equal(noKey.required, false);
  const missing = (await byId(machine({ which: (n) => (n === 'cursor-agent' ? null : `/usr/local/bin/${n}`) })))['cursor']!;
  assert.equal(missing.state, 'off');
});

test('account details from the tools are never passed on', async () => {
  const text = JSON.stringify(await checkConnections(machine()));
  for (const secret of ['someone@example.com', 'Secret Org', 'dev-account', 'dev@example.com']) {
    assert.equal(text.includes(secret), false, `${secret} must not appear in the report`);
  }
});

test('a missing, broken or signed-out Claude Code is a problem with the way to fix it', async () => {
  const missing = (await byId(machine({ which: (n) => (n === 'claude' ? null : `/usr/local/bin/${n}`) })))['claude']!;
  assert.equal(missing.state, 'problem');
  assert.match(missing.summary, /not found/);
  assert.match(missing.fix ?? '', /claude auth login/);

  const broken = (await byId(machine({ answers: { 'claude --version': fails(126) } })))['claude']!;
  assert.equal(broken.state, 'problem');
  assert.match(broken.summary, /does not run/);

  const signedOut = (await byId(machine({ answers: { 'claude auth status': { code: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: '' } } })))['claude']!;
  assert.equal(signedOut.state, 'problem');
  assert.match(signedOut.summary, /not signed in/);
  assert.equal(signedOut.fix, 'claude auth login');

  // An older claude that prints text: the exit code decides.
  const oldSignedOut = (await byId(machine({ answers: { 'claude auth status': { code: 1, stdout: 'Not logged in', stderr: '' } } })))['claude']!;
  assert.equal(oldSignedOut.state, 'problem');

  const withKey = (await byId(machine({ apiKeySet: true, answers: { 'claude auth status': fails(1) } })))['claude']!;
  assert.equal(withKey.state, 'ok');
  assert.match(withKey.summary, /ANTHROPIC_API_KEY/);

  const soon = new Date(Date.now() + 2 * 86_400_000 + 60_000).toISOString();
  const expiring = (await byId(machine({ answers: { 'claude auth status': ok(JSON.stringify({ loggedIn: true, loginExpiresAt: soon })) } })))['claude']!;
  assert.equal(expiring.state, 'warn');
  assert.match(expiring.summary, /ends in 2 days/);
});

test('the GitHub CLI is optional: missing is "off", signed out is a warning', async () => {
  const none = (await byId(machine({ which: (n) => (n === 'gh' ? null : `/usr/local/bin/${n}`) })))['github']!;
  assert.equal(none.state, 'off');
  assert.equal(none.required, false);

  const signedOut = (await byId(machine({ answers: { 'gh auth status': fails(1, 'You are not logged into any GitHub hosts.') } })))['github']!;
  assert.equal(signedOut.state, 'warn');
  assert.match(signedOut.summary, /not signed in/);
  assert.equal(signedOut.fix, 'gh auth login');
});

test('a sandbox that cannot run, another platform, old Node and missing git identity are all said', async () => {
  const sandbox = (await byId(machine({ sandbox: async () => ({ ok: false, detail: 'sandbox-exec: operation not permitted' }) })))['sandbox']!;
  assert.equal(sandbox.state, 'problem');
  assert.match(sandbox.summary, /operation not permitted/);
  assert.match(sandbox.summary, /stop rather than run unconfined/);

  // Every system runs the same probe; Linux is not refused for being Linux.
  let probed = 0;
  const linux = (await byId(machine({ platform: 'linux', sandbox: async () => { probed++; return { ok: true, detail: '' }; } })))['sandbox']!;
  assert.equal(linux.state, 'ok');
  assert.equal(probed, 1);

  assert.equal((await byId(machine({ nodeVersion: 'v18.20.0' })))['node']!.state, 'problem');
  // The sandbox needs 22.12: 22.11 is too old, 23.0 is fine.
  const old = (await byId(machine({ nodeVersion: 'v22.11.0' })))['node']!;
  assert.equal(old.state, 'problem');
  assert.match(old.summary, /22\.12 or newer/);
  assert.equal((await byId(machine({ nodeVersion: 'v23.0.0' })))['node']!.state, 'ok');

  const noIdentity = (await byId(machine({ answers: { 'git config --global user.email': fails(1) } })))['git']!;
  assert.equal(noIdentity.state, 'warn');
  assert.match(noIdentity.summary, /No global author/);

  const pressure = (await byId(machine({ memoryPressure: () => 4 })))['machine']!;
  assert.equal(pressure.state, 'warn');
  assert.match(pressure.summary, /critical/);
});

test('server names are read for what they point at; production wins when a name says both', () => {
  assert.equal(guessEnvironment('orders-prod-db'), 'production');
  assert.equal(guessEnvironment('billing-live'), 'production');
  assert.equal(guessEnvironment('orders-stg-db'), 'staging');
  assert.equal(guessEnvironment('prod-copy-for-test'), 'production');
  assert.equal(guessEnvironment('localhost'), 'local');
  assert.equal(guessEnvironment('github'), 'unknown');
  assert.equal(guessEnvironment('reproduce'), 'unknown'); // "prod" inside a word is not a match
});

test('MCP servers are listed by name with how they start, never with their command lines', () => {
  const settings = {
    mcpServers: {
      'orders-prod-db': { command: '/bin/zsh', args: ['-lc', 'source ~/creds.sh && exec npx -y some-db-server@latest --password hunter2'] },
      docs: { type: 'http', url: 'https://mcp.example.com/mcp?key=abc123' },
      pinned: { command: 'npx', args: ['-y', 'tool@1.2.3'] },
      floating: { command: 'npx', args: ['-y', 'tool'] },
      inline: { command: 'node', args: ['server.js'], env: { TOKEN: 'tok_secret' } },
    },
  };
  const { servers, note } = readMcpServers(machine({ readFile: () => JSON.stringify(settings) }));
  assert.equal(note, null);
  assert.deepEqual(servers.map((s) => s.name), ['docs', 'floating', 'inline', 'orders-prod-db', 'pinned']);
  const get = (name: string) => servers.find((s) => s.name === name)!;

  assert.equal(get('orders-prod-db').environment, 'production');
  assert.equal(get('orders-prod-db').looksLikeDatabase, true);
  assert.equal(get('orders-prod-db').notes.length, 2);
  assert.match(get('orders-prod-db').notes.join(' | '), /through a shell.*newest version/);
  assert.equal(get('docs').transport, 'http');
  assert.deepEqual(get('docs').notes, []);
  assert.deepEqual(get('pinned').notes, []);
  assert.match(get('floating').notes[0]!, /without a pinned version/);
  assert.match(get('inline').notes[0]!, /written into the Claude Code settings file/);

  const text = JSON.stringify(servers);
  for (const secret of ['hunter2', 'abc123', 'tok_secret', 'creds.sh', 'mcp.example.com']) {
    assert.equal(text.includes(secret), false, `${secret} must not appear`);
  }

  assert.match(readMcpServers(machine({ readFile: () => null })).note ?? '', /no settings file/);
  assert.match(readMcpServers(machine({ readFile: () => '{not json' })).note ?? '', /could not be read/);
});

test('on this machine the real checks run and a claude that does not exist is reported, not assumed', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  const real = realProbe();
  const report = await checkConnections({ ...real, claudeBin: '/nonexistent/claude' });
  const claude = report.checks.find((c) => c.id === 'claude')!;
  assert.equal(claude.state, 'problem');
  assert.match(claude.summary, /not found/);
  // The sandbox check really starts a sandboxed command here.
  assert.equal(report.checks.find((c) => c.id === 'sandbox')!.state, 'ok');
  assert.equal(report.checks.find((c) => c.id === 'node')!.state, 'ok');
});

/** A Linux machine: files in `files` (others are missing), programs in `programs` (others are not on PATH). */
function linuxMachine(files: Record<string, string> = {}, programs = ['bwrap', 'socat', 'rg', 'git', 'gh', 'claude', 'cursor-agent', 'google-chrome'], change: Partial<Probe> = {}): Probe {
  return machine({
    platform: 'linux',
    home: '/home/dev',
    which: (n) => (programs.includes(n) ? `/usr/bin/${n}` : null),
    readFile: (f) => files[f] ?? null,
    exists: () => false,
    ...change,
  });
}

test('Linux: the sandbox programs and user namespaces are checked, each with the fix for this distribution', async () => {
  const report = await checkConnections(linuxMachine());
  assert.deepEqual(report.checks.map((c) => `${c.id}:${c.state}`), [
    'claude:ok', 'sandbox:ok', 'bwrap:ok', 'socat:ok', 'ripgrep:ok', 'userns:ok', 'testers:warn', 'git:ok', 'github:ok', 'node:ok', 'machine:ok', 'browser:ok', 'cursor:ok',
  ]);
  assert.equal(report.checks.find((c) => c.id === 'machine')!.name, 'This machine');

  const ubuntu = { '/etc/os-release': 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n' };
  const missing = await byId(linuxMachine(ubuntu, ['git', 'claude']));
  assert.equal(missing['bwrap']!.state, 'problem');
  assert.equal(missing['bwrap']!.fix, 'sudo apt-get install -y bubblewrap');
  assert.equal(missing['socat']!.fix, 'sudo apt-get install -y socat');
  assert.equal(missing['ripgrep']!.fix, 'sudo apt-get install -y ripgrep');
  assert.equal(missing['bwrap']!.required, true);
  assert.match(missing['github']!.fix ?? '', /^sudo apt-get install -y gh, then: gh auth login$/);

  const fedora = await byId(linuxMachine({ '/etc/os-release': 'ID=fedora\n' }, ['claude']));
  assert.equal(fedora['socat']!.fix, 'sudo dnf install -y socat');
  assert.equal(fedora['git']!.fix, 'sudo dnf install -y git');
  const arch = await byId(linuxMachine({ '/etc/os-release': 'ID=arch\n' }, ['claude']));
  assert.equal(arch['github']!.fix, 'sudo pacman -S github-cli, then: gh auth login');
  // Not known which distribution: every family's command.
  const unknown = await byId(linuxMachine({}, ['claude']));
  assert.match(unknown['bwrap']!.fix ?? '', /apt-get install -y bubblewrap.*dnf install -y bubblewrap.*pacman -S bubblewrap/);
});

test('Linux: the Ubuntu 24.04 user-namespace restriction and the other kernel switches are said, with the sysctl that fixes them', async () => {
  const ubuntu = (await byId(linuxMachine({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' })))['userns']!;
  assert.equal(ubuntu.state, 'problem');
  assert.match(ubuntu.summary, /Ubuntu 24\.04/);
  assert.match(ubuntu.fix ?? '', /^sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0 && /);
  assert.equal((await byId(linuxMachine({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0\n' })))['userns']!.state, 'ok');

  const debian = (await byId(linuxMachine({ '/proc/sys/kernel/unprivileged_userns_clone': '0' })))['userns']!;
  assert.match(debian.fix ?? '', /kernel\.unprivileged_userns_clone=1/);
  const none = (await byId(linuxMachine({ '/proc/sys/user/max_user_namespaces': '0' })))['userns']!;
  assert.match(none.fix ?? '', /user\.max_user_namespaces=15000/);

  // In Docker the kernel is the host's: the fix is run there.
  const docker = (await byId(linuxMachine({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }, undefined, { inDocker: true })))['userns']!;
  assert.match(docker.fix ?? '', /^On the Docker host: sudo sysctl/);
});

test('Docker: reduced isolation is reported, and only there', async () => {
  const docker = await byId(linuxMachine({}, undefined, { inDocker: true }));
  assert.equal(docker['isolation']!.state, 'warn');
  assert.match(docker['isolation']!.summary, /Reduced isolation \(nested sandbox\)/);
  assert.equal((await byId(linuxMachine()))['isolation'], undefined);
  assert.equal((await byId(machine()))['isolation'], undefined);
  // The Setup page needs the sandbox itself to read ok in Docker.
  assert.equal(docker['sandbox']!.state, 'ok');
});

test('the browser is found on Linux by name on PATH, and FRYDAY_CHROME wins wherever it is set', async () => {
  assert.equal((await byId(linuxMachine({}, ['claude', 'chromium'])))['browser']!.state, 'ok');
  const none = (await byId(linuxMachine({}, ['claude'])))['browser']!;
  assert.equal(none.state, 'off');
  assert.match(none.fix ?? '', /FRYDAY_CHROME/);
  // Set but wrong: reported, not replaced by whatever else is installed.
  const wrong = (await byId(machine({ chromeOverride: '/opt/nothing/chrome', exists: (f) => f.startsWith('/Applications') })))['browser']!;
  assert.equal(wrong.state, 'off');
  assert.match(wrong.summary, /FRYDAY_CHROME/);
  assert.equal((await byId(machine({ chromeOverride: '/opt/chrome/chrome', exists: (f) => f === '/opt/chrome/chrome' })))['browser']!.state, 'ok');
});
