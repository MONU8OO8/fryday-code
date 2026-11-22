import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// Plain JS on purpose: the same file runs inside the hook without a build step.
import { decide, bashDenyReason, commandPrograms, isSecretFile } from '../src/guard/decide.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-guard-')));
const wt = path.join(tmp, 'worktree');
const outside = path.join(tmp, 'outside');
const hook = path.join(__dirname, '..', 'src', 'guard', 'hook.mjs');
const policyPath = path.join(tmp, 'policy.json');

const coder = { role: 'coder', allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'], readRoots: [wt], writeRoots: [wt] };
const tester = { role: 'tester', allowedTools: ['Read', 'Bash', 'Grep', 'Glob'], readRoots: [wt], writeRoots: [] as string[] };

const allowed = (tool: string, input: Record<string, unknown>, policy = coder) => decide(policy, tool, input, wt).allow;

before(() => {
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(wt, 'src', 'a.ts'), 'x');
  fs.writeFileSync(path.join(outside, 'creds.sh'), 'export TOKEN=canary');
  fs.symlinkSync(outside, path.join(wt, 'escape'));
  fs.writeFileSync(policyPath, JSON.stringify(coder));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('tools outside the role policy are refused', () => {
  assert.equal(allowed('Write', { file_path: path.join(wt, 'x.ts') }, tester), false);
  assert.equal(allowed('WebFetch', { url: 'https://example.com' }), false);
  assert.equal(allowed('mcp__github__push_files', {}), false);
  assert.equal(allowed('Agent', { prompt: 'x' }), false);
});

test('reads stay inside the workspace', () => {
  assert.equal(allowed('Read', { file_path: path.join(wt, 'src', 'a.ts') }), true);
  assert.equal(allowed('Read', { file_path: 'src/a.ts' }), true);
  assert.equal(allowed('Read', { file_path: path.join(outside, 'creds.sh') }), false);
  assert.equal(allowed('Read', { file_path: '../outside/creds.sh' }), false);
  assert.equal(allowed('Read', { file_path: path.join(wt, 'escape', 'creds.sh') }), false, 'symlink out of the workspace');
  assert.equal(allowed('Read', { file_path: path.join(os.homedir(), '.ssh', 'id_rsa') }), false);
  assert.equal(allowed('Read', {}), false);
  assert.equal(allowed('Grep', { pattern: 'x' }), true, 'defaults to cwd');
  assert.equal(allowed('Grep', { pattern: 'TOKEN', path: outside }), false);
  assert.equal(allowed('Glob', { pattern: '**/*.ts' }), true);
  assert.equal(allowed('Glob', { pattern: '/etc/**' }), false);
  assert.equal(allowed('Glob', { pattern: '../outside/*' }), false);
  assert.equal(allowed('Glob', { pattern: '~/.ssh/*' }), false);
});

test('secret files are refused even inside the workspace', () => {
  for (const name of ['.env', '.env.production', 'deploy.pem', 'id_ed25519', 'team-creds.sh', 'credentials.json', '.npmrc']) {
    assert.equal(allowed('Read', { file_path: path.join(wt, name) }), false, name);
    assert.equal(allowed('Write', { file_path: path.join(wt, name), content: 'x' }), false, name);
  }
  assert.equal(allowed('Read', { file_path: path.join(wt, '.env.example') }), true);
  assert.equal(isSecretFile('/x/src/environment.ts'), false);
  assert.equal(isSecretFile('/x/src/credentialsForm.tsx'), false);
});

test('writes stay inside the workspace and off its protected paths', () => {
  assert.equal(allowed('Write', { file_path: path.join(wt, 'src', 'new.ts'), content: 'x' }), true);
  assert.equal(allowed('Edit', { file_path: 'src/a.ts' }), true);
  assert.equal(allowed('Write', { file_path: path.join(outside, 'x.txt') }), false);
  assert.equal(allowed('Write', { file_path: path.join(wt, 'escape', 'x.txt') }), false, 'symlink out of the workspace');
  assert.equal(allowed('Write', { file_path: path.join(wt, '..', 'x.txt') }), false);
  for (const rel of ['.git', '.git/hooks/pre-commit', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/x.sh', 'pkg/.git/config']) {
    assert.equal(allowed('Write', { file_path: path.join(wt, rel) }), false, rel);
  }
  assert.equal(allowed('Write', { file_path: path.join(wt, '.github', 'workflows', 'ci.yml') }), true);
  assert.equal(allowed('Write', { file_path: path.join(wt, 'src', 'x.ts') }, tester), false, 'tester has no write tool');
});

test('Bash refuses outward and escalating commands at command position', () => {
  const refused = [
    'git push origin HEAD', 'git -C . push', 'cd x && git remote add evil https://x', 'git config core.hooksPath /tmp/h',
    'git commit -m x', 'git fetch', 'git status', 'git diff HEAD~1', '/opt/homebrew/bin/git log', 'cd src && git stash', 'curl http://127.0.0.1:7475/api/approvals', '/usr/bin/curl x', 'FOO=1 curl x',
    'echo hi | nc 10.0.0.1 80', 'env curl x', 'xargs curl < urls', 'timeout 5 curl x', 'sudo rm -rf /', 'ssh host',
    'open https://x', 'osascript -e "x"', 'security find-generic-password -s x', 'pm2 restart all', 'clasp push',
    'gh pr create', 'aws s3 ls', 'npm publish', 'true; (curl x)', 'echo $(curl x)', 'echo `wget x`',
    'bash -c "curl x"', "sh -c 'git push'", 'python3 -c "import os; os.system(\'curl x\')"', 'eval "curl x"',
    'cat < /dev/tcp/10.0.0.1/80', 'launchctl load x', 'crontab -e',
    // Linux: the desktop session, systemd and D-Bus run outside the sandbox.
    'xdg-open https://x', '/usr/bin/xdg-open x', 'gio open x', 'systemctl --user start x', 'systemd-run --user sh -c x',
    'dbus-send --session --dest=org.x / x', 'gdbus call --session -d org.x', 'busctl --user call x', 'env systemctl stop x',
    'bash -c "systemd-run --user touch x"',
    // Linux: another user, the Flatpak host, namespaces, containers, the desktop's browser, logind.
    'pkexec rm -rf /', '/usr/bin/pkexec id', 'run0 id', 'flatpak-spawn --host sh', 'nsenter -t 1 -m -u -i -n -p sh',
    'unshare -r sh', 'env unshare --user --map-root-user sh', 'loginctl terminate-user x', 'podman run --rm alpine sh',
    'x-www-browser https://x', 'sensible-browser https://x', 'timeout 5 pkexec id', 'true && nsenter -t 1 sh',
    'bash -c "flatpak-spawn --host touch x"', "sh -c 'podman ps'",
  ];
  for (const command of refused) assert.notEqual(bashDenyReason(command), null, command);
  assert.equal(allowed('Bash', { command: 'git push' }), false);
  assert.equal(allowed('Bash', { command: '' }), false);
  assert.equal(allowed('Bash', {}), false);
});

test('Bash allows ordinary development commands', () => {
  const fine = [
    'npm test', 'npm run lint -- --fix', 'ls -la src', 'cat .gitignore', 'grep -rn "git push" docs',
    'grep -rn "curl" src', 'grep -r "open(" .', 'node scripts/build.js', 'npx tsc --noEmit', 'cat package.json | head -20',
    'mkdir -p src/at && touch src/at/index.ts', 'echo "ssh keys are documented in README"', 'sed -n 1,20p src/security.ts',
    'python3 -m pytest tests/', 'FOO=bar npm run build', 'rm -rf dist && npm run build',
    // The Linux programs are refused as programs, not as words.
    'grep -rn "systemctl" docs', 'cat src/gio.ts', 'node scripts/dbus-send-mock.js',
  ];
  for (const command of fine) assert.equal(bashDenyReason(command), null, command);
  assert.deepEqual(commandPrograms('FOO=1 env node x.js | grep y && (ls; pwd)'), ['node', 'grep', 'ls', 'pwd']);
});

test('a missing or malformed policy refuses everything', () => {
  assert.equal(decide(undefined as never, 'Read', { file_path: path.join(wt, 'src', 'a.ts') }, wt).allow, false);
  assert.equal(decide({ role: 'coder' } as never, 'Read', { file_path: 'src/a.ts' }, wt).allow, false);
  assert.equal(decide({ ...coder, allowedTools: [...coder.allowedTools, 'NewTool'] }, 'NewTool', {}, wt).allow, false);
});

// ─── The hook process itself ──────────────────────────────────────────────────

function runHook(stdin: string, args: string[] = [policyPath]) {
  return spawnSync('node', [hook, ...args], { input: stdin, encoding: 'utf8' });
}
const call = (tool_name: string, tool_input: Record<string, unknown>) => JSON.stringify({ tool_name, tool_input, cwd: wt });

test('hook exits 0 for an allowed call and 2 with a reason for a refused one', () => {
  assert.equal(runHook(call('Read', { file_path: 'src/a.ts' })).status, 0);
  const denied = runHook(call('Read', { file_path: path.join(outside, 'creds.sh') }));
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /Blocked by Fryday guard: .*outside this task's workspace/);
  assert.equal(runHook(call('Bash', { command: 'git push' })).status, 2);
});

test('hook fails closed on anything unexpected', () => {
  assert.equal(runHook('not json').status, 2);
  assert.equal(runHook('').status, 2);
  assert.equal(runHook(call('Read', { file_path: 'src/a.ts' }), []).status, 2, 'no policy argument');
  assert.equal(runHook(call('Read', { file_path: 'src/a.ts' }), [path.join(tmp, 'missing.json')]).status, 2);
  const broken = path.join(tmp, 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  assert.equal(runHook(call('Read', { file_path: 'src/a.ts' }), [broken]).status, 2);
  assert.equal(runHook(JSON.stringify({ tool_input: {}, cwd: wt })).status, 2, 'no tool name');
});

test('the Analyst and the Planner can only read, and only inside their folder', () => {
  // The policy an agent actually gets is built from its role; check that, not a hand-written copy.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildPolicy } = require('../src/guard/runGuard') as typeof import('../src/guard/runGuard');
  for (const role of ['analyst', 'planner'] as const) {
    const policy = buildPolicy({ runId: 'r', role, workspacePath: wt, runsDir: tmp, structuredOutput: true });
    assert.deepEqual(policy.allowedTools, ['Read', 'Grep', 'Glob', 'StructuredOutput'], role);
    assert.deepEqual(policy.writeRoots, [], `${role} may write nowhere`);
    assert.equal(decide(policy, 'Read', { file_path: path.join(wt, 'src', 'a.ts') }, wt).allow, true);
    for (const [tool, input] of [
      ['Write', { file_path: path.join(wt, 'x.ts'), content: 'x' }],
      ['Edit', { file_path: path.join(wt, 'src', 'a.ts'), old_string: 'x', new_string: 'y' }],
      ['Bash', { command: 'ls' }],
      ['Read', { file_path: path.join(outside, 'creds.sh') }],
      ['Read', { file_path: path.join(wt, 'escape', 'creds.sh') }],
      ['WebFetch', { url: 'https://example.com' }],
    ] as Array<[string, Record<string, unknown>]>) {
      assert.equal(decide(policy, tool, input, wt).allow, false, `${role} must not ${tool} ${JSON.stringify(input)}`);
    }
  }
});
