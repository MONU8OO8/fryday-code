/**
 * Keeps the machine from idle-sleeping while agents or checks are running. A sleeping
 * machine stalls the work and makes time limits fire for the wrong reason.
 *
 * Counted: the machine may sleep again as soon as nothing is active. The helper is tied
 * to this process so it can never outlive core:
 *   - macOS: `caffeinate -i -w <core's pid>`;
 *   - Linux: `systemd-inhibit` holding its lock around `tail --pid=<core's pid>`, where
 *     systemd is there and this is not a container.
 * Anywhere else, or if the helper is missing or refused, it does nothing.
 */

import { spawn, type ChildProcess } from 'child_process';
import { findOnPath } from '../config.js';
import { inDocker } from '../platform.js';

let holders = 0;
let helper: ChildProcess | null = null;

/** The program that keeps this system awake for as long as `pid` lives, or null when there is none to use. */
export function keepAwakeCommand(platform: string, pid: number, has: (name: string) => boolean, docker = inDocker()): { file: string; args: string[] } | null {
  if (platform === 'darwin') return { file: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'linux' && !docker && has('systemd-inhibit') && has('tail')) {
    return {
      file: 'systemd-inhibit',
      args: ['--what=idle:sleep', '--who=FryDay Code', '--why=Agents are working', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'],
    };
  }
  return null;
}

export function keepAwake(): () => void {
  holders++;
  if (holders === 1) {
    const cmd = keepAwakeCommand(process.platform, process.pid, (name) => findOnPath(name) !== null);
    if (cmd) {
      try {
        helper = spawn(cmd.file, cmd.args, { stdio: 'ignore' });
        helper.on('error', () => { helper = null; });
        helper.unref();
      } catch {
        helper = null;
      }
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders === 0 && helper) {
      helper.kill();
      helper = null;
    }
  };
}

/** How many things are currently keeping the machine awake. For tests and the health endpoint. */
export function awakeHolders(): number {
  return holders;
}
