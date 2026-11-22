/**
 * A desktop notification for the owner: the same nudges that go to the Chat space.
 *   - macOS: osascript's `display notification`;
 *   - Linux: `notify-send`, when there is a desktop session to show it in;
 *   - anywhere else, or with no display (a server, a container): nothing.
 *
 * The text is handed over as arguments, never pasted into a script or a shell line, so
 * a task title or a note cannot become AppleScript or a command-line option. Failures
 * are ignored: a notification is a nudge, the task page is the record.
 */

import { execFile } from 'child_process';

export type DesktopNotifier = (title: string, body: string) => void;

const SCRIPT = ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', 'end run'];
const MAX_TITLE = 80;
const MAX_BODY = 240;

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** Whether a Linux process can reach a desktop to show a notification on. */
export function hasDesktopSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['DISPLAY'] || env['WAYLAND_DISPLAY']);
}

/** The program and arguments that show a notification on this system, or null when there is nowhere to show it. */
export function desktopNotifyCommand(title: string, body: string, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } | null {
  if (platform === 'darwin') return { file: 'osascript', args: osascriptArgs(title, body) };
  if (platform === 'linux' && hasDesktopSession(env)) return { file: 'notify-send', args: notifySendArgs(title, body) };
  return null;
}

function show(title: string, body: string): void {
  const cmd = desktopNotifyCommand(title, body);
  if (cmd) execFile(cmd.file, cmd.args, { timeout: 5000 }, () => undefined);
}

let notifier: DesktopNotifier = show;

/** For tests: catch notifications instead of showing them. */
export function setDesktopNotifier(n: DesktopNotifier | null): void {
  notifier = n ?? show;
}

/** Switched off for test runs and check scripts. FRYDAY_MAC_NOTIFY is the older name and still works. */
export function desktopNotifyOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['FRYDAY_DESKTOP_NOTIFY'] === 'off' || env['FRYDAY_MAC_NOTIFY'] === 'off';
}

export function notifyDesktop(title: string, body: string): void {
  // Test runs and check scripts start their own core; they must not pop notifications on the owner's desktop.
  if (desktopNotifyOff() && notifier === show) return;
  try {
    notifier(title, body);
  } catch {
    /* a nudge only */
  }
}

/** The arguments osascript is called with, for the test that checks nothing is pasted into the script. */
export function osascriptArgs(title: string, body: string): string[] {
  return [...SCRIPT.flatMap((l) => ['-e', l]), clip(title, MAX_TITLE), clip(body, MAX_BODY)];
}

/** The arguments notify-send is called with. "--" ends the options, so a title starting with "-" stays text. */
export function notifySendArgs(title: string, body: string): string[] {
  return ['--app-name=FryDay Code', '--', clip(title, MAX_TITLE), clip(body, MAX_BODY)];
}
