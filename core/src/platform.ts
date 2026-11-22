/**
 * What differs between the systems FryDay Code runs on: macOS, Linux, and Linux inside
 * Docker. Kept small and free of side effects, so each difference can be tested with
 * the system passed in.
 */

import fs from 'node:fs';

/** How to look for a container marker; passed in by tests. */
export interface ContainerChecks {
  exists(file: string): boolean;
  read(file: string): string | null;
}

const HOST_CHECKS: ContainerChecks = {
  exists: (file) => fs.existsSync(file),
  read: (file) => {
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
  },
};
let hostChecks: ContainerChecks = HOST_CHECKS;

/** Tests only: replace the checks the default `inDocker()` uses; null restores the real ones. */
export function useContainerChecks(checks: ContainerChecks | null): void {
  hostChecks = checks ?? HOST_CHECKS;
}

/** Whether this process is in a container: Docker's /.dockerenv, or PID 1's cgroup naming a container runtime. */
export function inContainer(checks: ContainerChecks = hostChecks): boolean {
  if (checks.exists('/.dockerenv')) return true;
  return /docker|containerd|kubepods/.test(checks.read('/proc/1/cgroup') ?? '');
}

/**
 * True when this core runs in the FryDay Code Docker image: it sets FRYDAY_IN_DOCKER=1, and the
 * process must also be in a container. The variable alone, set on a host, never turns on the
 * sandbox's nested mode (below).
 */
export function inDocker(env: NodeJS.ProcessEnv = process.env, checks: ContainerChecks = hostChecks): boolean {
  return env['FRYDAY_IN_DOCKER'] === '1' && inContainer(checks);
}

/**
 * The sandbox runtime's nested mode, for Docker only. A container cannot mount a fresh
 * /proc for the sandbox, so the runtime binds the container's own instead: commands in
 * the sandbox can see the container's other processes. The container is the outer wall
 * there. Never switched on outside Docker.
 */
export function nestedSandbox(env: NodeJS.ProcessEnv = process.env, checks: ContainerChecks = hostChecks): { enableWeakerNestedSandbox?: true } {
  return inDocker(env, checks) ? { enableWeakerNestedSandbox: true } : {};
}

/** The address to put in a link for the browser: a listen-on-everything address is not one a browser can open. */
export function browserHost(host: string): string {
  return host === '' || host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host;
}

/** How this machine is named to the owner. */
export function machineName(platform: string = process.platform): string {
  return platform === 'darwin' ? 'this Mac' : 'this machine';
}
