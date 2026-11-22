/**
 * What differs between macOS, Linux and Docker, tested with the system passed in, so
 * the Linux paths are checked on a Mac too (and the other way round in CI).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { browserHost, inContainer, inDocker, machineName, nestedSandbox, useContainerChecks, type ContainerChecks } from '../src/platform';
import { findChrome, LINUX_CHROME_NAMES } from '../src/verify/tools';
import { parseLsofListen, parseSsListen, serviceUnreachableReason } from '../src/verify/service';
import { memoryPressureFromPsi, memoryPressureLevel } from '../src/pipeline/checks';
import { keepAwakeCommand } from '../src/runner/keepAwake';
import { desktopNotifyCommand, desktopNotifyOff, notifySendArgs } from '../src/notify/desktop';
import { sandboxSettings } from '../src/pipeline/sandbox';
import { cursorSandbox } from '../src/runner/runners';
import { buildSettings } from '../src/guard/runGuard';
import { installCommand, linuxDistro, nodeAtLeast } from '../src/connections/doctor';

const withEnv = <T>(key: string, value: string | undefined, fn: () => T): T => {
  const before = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return fn(); } finally { if (before === undefined) delete process.env[key]; else process.env[key] = before; }
};

// ─── Docker ───────────────────────────────────────────────────────────────────

/** A system with the given files, for the container checks. */
const system = (files: Record<string, string>): ContainerChecks => ({
  exists: (f) => f in files,
  read: (f) => files[f] ?? null,
});
const HOST = system({ '/proc/1/cgroup': '0::/init.scope\n' });
const DOCKERENV = system({ '/.dockerenv': '' });
const CGROUP_V1 = system({ '/proc/1/cgroup': '12:pids:/docker/3f2a9c\n11:memory:/docker/3f2a9c\n' });
const CONTAINERD = system({ '/proc/1/cgroup': '0::/system.slice/containerd.service/abc\n' });
const KUBE = system({ '/proc/1/cgroup': '0::/kubepods/besteffort/pod1/abc\n' });

const withContainer = <T>(checks: ContainerChecks, fn: () => T): T => {
  useContainerChecks(checks);
  try { return fn(); } finally { useContainerChecks(null); }
};

test('a container is recognised by /.dockerenv or by PID 1 cgroup naming docker, containerd or kubepods', () => {
  assert.equal(inContainer(HOST), false);
  assert.equal(inContainer(system({})), false, 'no /proc (macOS)');
  for (const c of [DOCKERENV, CGROUP_V1, CONTAINERD, KUBE]) assert.equal(inContainer(c), true);
});

test('the nested sandbox is used only in a container whose image says so', () => {
  const docker = { FRYDAY_IN_DOCKER: '1' };
  assert.equal(inDocker({}, DOCKERENV), false, 'a container that is not the FryDay image');
  assert.equal(inDocker(docker, DOCKERENV), true);
  assert.equal(inDocker(docker, CGROUP_V1), true);
  assert.equal(inDocker({ FRYDAY_IN_DOCKER: 'true' }, DOCKERENV), false, 'only the exact value the image sets');
  // FRYDAY_IN_DOCKER=1 set on a host does not weaken the sandbox.
  assert.equal(inDocker(docker, HOST), false);
  assert.equal(inDocker(docker, system({})), false);
  assert.deepEqual(nestedSandbox({}, DOCKERENV), {});
  assert.deepEqual(nestedSandbox(docker, HOST), {});
  assert.deepEqual(nestedSandbox(docker, DOCKERENV), { enableWeakerNestedSandbox: true });
});

test('every sandbox settings writer turns on nested mode in Docker, and never outside it', () => {
  const ws = path.join(os.tmpdir(), 'ws');
  const writers: Record<string, () => Record<string, unknown>> = {
    'checks and services (srt)': () => sandboxSettings(ws, path.join(os.tmpdir(), 't')),
    'cursor (srt)': () => cursorSandbox(ws, path.join(os.tmpdir(), 'h'), path.join(os.tmpdir(), 't'), '/usr/local/bin/cursor-agent'),
    'claude code': () => buildSettings({ runId: 'r1', role: 'coder', workspacePath: ws, runsDir: os.tmpdir() }, path.join(os.tmpdir(), 'p.json'))['sandbox'] as Record<string, unknown>,
  };
  for (const [name, write] of Object.entries(writers)) {
    const inImage = () => withContainer(DOCKERENV, () => withEnv('FRYDAY_IN_DOCKER', '1', write));
    assert.equal(withContainer(DOCKERENV, () => withEnv('FRYDAY_IN_DOCKER', undefined, write))['enableWeakerNestedSandbox'], undefined, `${name}: off outside the image`);
    assert.equal(withContainer(HOST, () => withEnv('FRYDAY_IN_DOCKER', '1', write))['enableWeakerNestedSandbox'], undefined, `${name}: off on a host that sets the variable`);
    assert.equal(inImage()['enableWeakerNestedSandbox'], true, `${name}: on in Docker`);
    // Nothing else is loosened along with it.
    const docker = inImage();
    const plain = withContainer(HOST, () => withEnv('FRYDAY_IN_DOCKER', undefined, write));
    delete docker['enableWeakerNestedSandbox'];
    assert.deepEqual(docker, plain, `${name}: the rest is unchanged`);
  }
});

test('a link for the browser never names a listen-on-everything address', () => {
  assert.equal(browserHost('0.0.0.0'), '127.0.0.1');
  assert.equal(browserHost('::'), '127.0.0.1');
  assert.equal(browserHost('127.0.0.1'), '127.0.0.1');
  assert.equal(browserHost('localhost'), 'localhost');
  assert.equal(machineName('darwin'), 'this Mac');
  assert.equal(machineName('linux'), 'this machine');
});

// ─── Linux: the service under test ──────────────────────────────────────────

test('on Linux the testers are not offered, with the reason; on macOS they are', () => {
  assert.match(serviceUnreachableReason('linux') ?? '', /not available on Linux/);
  assert.equal(serviceUnreachableReason('darwin'), null);
});

test('ss output is read for how a port is listened on', () => {
  const ss = [
    'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
    'LISTEN 0      511        127.0.0.1:3000       0.0.0.0:*     users:(("node",pid=12,fd=20))',
    'LISTEN 0      511            [::1]:3000          [::]:*     users:(("node",pid=12,fd=21))',
    'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*',
    'LISTEN 0      511          0.0.0.0:8080       0.0.0.0:*',
    'LISTEN 0      511                *:9090             *:*',
    'LISTEN 0      511             [::]:7000          [::]:*',
    'LISTEN 0      511      192.168.1.5:6000       0.0.0.0:*',
  ].join('\n');
  assert.equal(parseSsListen(ss, 3000), 'loopback');
  assert.equal(parseSsListen(ss, 53), 'loopback');
  assert.equal(parseSsListen(ss, 8080), 'all');
  assert.equal(parseSsListen(ss, 9090), 'all');
  assert.equal(parseSsListen(ss, 7000), 'all');
  assert.equal(parseSsListen(ss, 6000), 'all', 'a LAN address is reachable from other machines');
  assert.equal(parseSsListen(ss, 4000), 'unknown');
  assert.equal(parseSsListen(ss, 300), 'unknown', 'a port is matched whole, not as a prefix');
  assert.equal(parseSsListen('', 3000), 'unknown');
});

test('lsof output is read as before', () => {
  const lsof = 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 12 dev 20u IPv4 0x1 0t0 TCP 127.0.0.1:3000 (LISTEN)\n';
  assert.equal(parseLsofListen(lsof), 'loopback');
  assert.equal(parseLsofListen(`${lsof}node 12 dev 21u IPv6 0x2 0t0 TCP *:3000 (LISTEN)\n`), 'all');
  assert.equal(parseLsofListen(''), 'unknown');
});

// ─── Linux: Chrome ───────────────────────────────────────────────────────────

test('Chrome is found by name on PATH on Linux, in order, and at its app path on macOS', () => {
  const onPath = (names: string[]) => (n: string) => (names.includes(n) ? `/usr/bin/${n}` : null);
  assert.equal(findChrome({ platform: 'linux', override: '', which: onPath(['chromium', 'google-chrome-stable']) }), '/usr/bin/google-chrome-stable');
  assert.equal(findChrome({ platform: 'linux', override: '', which: onPath(['chromium-browser']) }), '/usr/bin/chromium-browser');
  assert.equal(findChrome({ platform: 'linux', override: '', which: onPath([]) }), null);
  assert.deepEqual(LINUX_CHROME_NAMES, ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);

  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(findChrome({ platform: 'darwin', override: '', home: '/Users/dev', exists: (f) => f === mac, which: () => '/usr/bin/x' }), mac);
  const userMac = '/Users/dev/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(findChrome({ platform: 'darwin', override: '', home: '/Users/dev', exists: (f) => f === userMac }), userMac);
  assert.equal(findChrome({ platform: 'win32', override: '', which: () => '/x' }), null);
});

test('FRYDAY_CHROME wins on every system, and a wrong one is not replaced by another browser', () => {
  const which = (n: string) => (n === 'chromium' ? '/usr/bin/chromium' : n === 'brave' ? '/opt/brave/brave' : null);
  assert.equal(findChrome({ platform: 'linux', override: '/opt/chrome/chrome', exists: (f) => f === '/opt/chrome/chrome', which }), '/opt/chrome/chrome');
  assert.equal(findChrome({ platform: 'linux', override: '/opt/missing', exists: () => false, which }), null);
  assert.equal(findChrome({ platform: 'linux', override: 'brave', which }), '/opt/brave/brave');
  assert.equal(withEnv('FRYDAY_CHROME', '/opt/missing/chrome', () => findChrome({ platform: 'linux', which })), null);
});

// ─── Linux: memory pressure ─────────────────────────────────────────────────

const psi = (some: number, full: number) =>
  `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=123\nfull avg10=${full.toFixed(2)} avg60=0.00 avg300=0.00 total=45\n`;

test('Linux memory pressure (PSI) maps to the same levels as macOS: 1 normal, 2 warn, 4 critical', () => {
  assert.equal(memoryPressureFromPsi(psi(0, 0)), 1);
  assert.equal(memoryPressureFromPsi(psi(9.99, 1.99)), 1);
  assert.equal(memoryPressureFromPsi(psi(10, 0)), 2);
  assert.equal(memoryPressureFromPsi(psi(3, 2)), 2);
  assert.equal(memoryPressureFromPsi(psi(40, 0)), 4);
  assert.equal(memoryPressureFromPsi(psi(15, 10)), 4);
  // Older kernels have no "full" line for memory.
  assert.equal(memoryPressureFromPsi('some avg10=12.50 avg60=1.00 avg300=0.10 total=9\n'), 2);
  assert.equal(memoryPressureFromPsi(''), null);
  assert.equal(memoryPressureFromPsi('garbage'), null);
});

test('memory pressure reads /proc/pressure/memory on Linux and is null where it cannot be read', () => {
  assert.equal(memoryPressureLevel('linux', () => psi(50, 20)), 4);
  assert.equal(memoryPressureLevel('linux', () => { throw new Error('ENOENT'); }), null, 'a kernel without PSI');
  assert.equal(memoryPressureLevel('win32'), null);
});

// ─── Linux: keeping awake, notifications ────────────────────────────────────

test('keeping awake: caffeinate on macOS, systemd-inhibit around core on Linux, nothing in Docker or without systemd', () => {
  const has = (names: string[]) => (n: string) => names.includes(n);
  assert.deepEqual(keepAwakeCommand('darwin', 42, has([])), { file: 'caffeinate', args: ['-i', '-w', '42'] });
  const linux = keepAwakeCommand('linux', 42, has(['systemd-inhibit', 'tail']), false)!;
  assert.equal(linux.file, 'systemd-inhibit');
  // The lock is held by a command that ends when core does.
  assert.deepEqual(linux.args.slice(-4), ['tail', '--pid=42', '-f', '/dev/null']);
  assert.equal(keepAwakeCommand('linux', 42, has(['tail']), false), null);
  assert.equal(keepAwakeCommand('linux', 42, has(['systemd-inhibit', 'tail']), true), null);
  assert.equal(keepAwakeCommand('win32', 42, has(['systemd-inhibit', 'tail']), false), null);
});

test('notifications: notify-send with a desktop session on Linux, nothing headless, text only as arguments', () => {
  assert.equal(desktopNotifyCommand('t', 'b', 'linux', {}), null, 'no display: nothing');
  const linux = desktopNotifyCommand('t', 'b', 'linux', { DISPLAY: ':0' })!;
  assert.equal(linux.file, 'notify-send');
  assert.equal(desktopNotifyCommand('t', 'b', 'linux', { WAYLAND_DISPLAY: 'wayland-0' })!.file, 'notify-send');
  assert.equal(desktopNotifyCommand('t', 'b', 'darwin', {})!.file, 'osascript');
  assert.equal(desktopNotifyCommand('t', 'b', 'win32', { DISPLAY: ':0' }), null);

  // "--" ends notify-send's options: a title that looks like one stays text.
  const args = notifySendArgs('--icon=/etc/passwd', 'x'.repeat(1000));
  assert.deepEqual(args.slice(0, 3), ['--app-name=FryDay Code', '--', '--icon=/etc/passwd']);
  assert.equal(args.at(-1)!.length, 240);
});

test('notifications switch off with FRYDAY_DESKTOP_NOTIFY=off, and the older FRYDAY_MAC_NOTIFY=off still works', () => {
  assert.equal(desktopNotifyOff({}), false);
  assert.equal(desktopNotifyOff({ FRYDAY_DESKTOP_NOTIFY: 'off' }), true);
  assert.equal(desktopNotifyOff({ FRYDAY_MAC_NOTIFY: 'off' }), true);
  assert.equal(desktopNotifyOff({ FRYDAY_DESKTOP_NOTIFY: 'on' }), false);
});

// ─── Doctor helpers ──────────────────────────────────────────────────────────

test('the Node floor is 22.12, compared as numbers', () => {
  assert.equal(nodeAtLeast('v22.12.0', [22, 12]), true);
  assert.equal(nodeAtLeast('v22.9.0', [22, 12]), false);
  assert.equal(nodeAtLeast('v24.0.0', [22, 12]), true);
  assert.equal(nodeAtLeast('v20.18.1', [22, 12]), false);
  assert.equal(nodeAtLeast('garbage', [22, 12]), false);
});

test('the Linux distribution is read from os-release, including derivatives', () => {
  assert.equal(linuxDistro('ID=ubuntu\nID_LIKE=debian\n'), 'debian');
  assert.equal(linuxDistro('ID="linuxmint"\nID_LIKE="ubuntu debian"\n'), 'debian');
  assert.equal(linuxDistro('ID="rocky"\nID_LIKE="rhel centos fedora"\n'), 'fedora');
  assert.equal(linuxDistro('ID=manjaro\nID_LIKE=arch\n'), 'arch');
  assert.equal(linuxDistro('ID=alpine\n'), null);
  assert.equal(linuxDistro(null), null);
  assert.equal(installCommand('socat', 'darwin', null), 'brew install socat');
});
