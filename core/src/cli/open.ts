/**
 * Open FryDay Code in the browser: asks the running core for a one-time launch link
 * (proving ownership with the install's secret file) and opens it.
 *
 *   fryday-code open            open the default browser   (npm run open)
 *   fryday-code open --print    just print the link        (npm run open -- --print)
 */

import { execFile } from 'node:child_process';
import { getConfig } from '../config.js';
import { browserHost, inDocker } from '../platform.js';
import { hasDesktopSession } from '../notify/desktop.js';

/** The program that opens a link in the default browser here, or null (no desktop: the link is printed only). */
export function opener(): string | null {
  if (process.platform === 'darwin') return 'open';
  if (process.platform === 'linux' && !inDocker() && hasDesktopSession()) return 'xdg-open';
  return null;
}

/** Open a link in the default browser when there is one; true if a browser was asked to. */
export function openInBrowser(url: string): boolean {
  const program = opener();
  if (!program) return false;
  execFile(program, [url], () => undefined);
  return true;
}

/** A new one-time launch link from the core at `base`, asked for with the install's secret. */
export async function fetchLaunchLink(base: string, secret: string): Promise<{ ok: true; url: string } | { ok: false; status: number | null }> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/session/launch-code`, { method: 'POST', headers: { 'x-fryday-core-token': secret } });
  } catch {
    return { ok: false, status: null };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const { url } = (await res.json()) as { url: string };
  return { ok: true, url };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cfg = getConfig();
  const base = `http://${browserHost(cfg.host)}:${cfg.port}`;
  const link = await fetchLaunchLink(base, cfg.coreSecret);
  if (!link.ok && link.status === null) {
    console.error(`FryDay Code is not running on ${base}. Start it with: npx fryday-code (or npm start in a clone)`);
    return 1;
  }
  if (!link.ok) {
    console.error(`FryDay Code refused the request (${link.status}). Is another install using port ${cfg.port}?`);
    return 1;
  }
  console.log(link.url);
  if (!argv.includes('--print')) openInBrowser(link.url);
  return 0;
}

if (require.main === module) main().then((code) => process.exit(code));
