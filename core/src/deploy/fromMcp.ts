/**
 * Taking the Jenkins credentials from the MCP server Claude Code already uses, instead of the
 * developer keeping a second copy of them here.
 *
 * On this machine (and the ones this is written for) an MCP server is started by a shell line
 * that loads the developer's own credentials file and then execs the server:
 *
 *   /bin/zsh -lc 'source ~/…/creds.sh && load_jenkins && exec node …/jenkins-mcp-runner.js'
 *
 * The credentials live in that file and nowhere else, which is what the developer's own rules
 * ask for. To read them without keeping a copy, the same line is run with the final `exec …`
 * replaced by `env`, so the shell does exactly the setup the server would get and then prints
 * the environment instead of starting anything. Only variables whose name says Jenkins are
 * read, and the token is never logged or returned to the UI.
 *
 * This reads credentials; it does not deploy through MCP. The deploy itself stays on FryDay's
 * own Jenkins client (deploy/jenkins.ts), which is what refuses to answer a prompt about
 * production and checks that the build really contains the merge.
 */

import { execFile } from 'child_process';
import { getConfig } from '../config.js';
import { readDefinitions } from '../connections/store.js';
import type { JenkinsCredentials } from './jenkins.js';

export class FromMcpError extends Error {}

/** How long the setup line may take to print the environment. */
const TIMEOUT_MS = 20_000;

interface Stdio {
  command: string;
  args: string[];
}

/** The MCP server that talks to Jenkins, by name or by what it starts. */
export function findJenkinsServer(file = getConfig().claudeSettingsPath): { name: string; stdio: Stdio } | null {
  for (const [name, def] of readDefinitions(file)) {
    const command = typeof def['command'] === 'string' ? def['command'] : '';
    const args = Array.isArray(def['args']) ? def['args'].filter((a): a is string => typeof a === 'string') : [];
    if (!command) continue;
    const says = `${name} ${args.join(' ')}`.toLowerCase();
    if (/jenkins/.test(says)) return { name, stdio: { command, args } };
  }
  return null;
}

/**
 * The shell line with the server it would start replaced by `env`. Returns null when the line
 * does not end by exec'ing something, because then there is no way to stop short of starting it.
 */
export function envInsteadOfServer(args: string[]): string[] | null {
  const last = args.length - 1;
  if (last < 0) return null;
  const line = args[last]!;
  // The exec that starts the server: the last one, with everything after it on the line.
  if (!/\bexec\s+\S/.test(line)) return null;
  const stopped = line.replace(/\bexec\s+[\s\S]*$/, 'env');
  return [...args.slice(0, last), stopped];
}

const read = (command: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      // A login shell often prints to stderr for reasons of its own; only a failure to run counts.
      if (err && !stdout) reject(new FromMcpError(`Could not run the MCP server's setup: ${err.message}`));
      else resolve(stdout);
    });
  });

/** Variables from `env` output, keeping only the ones whose name says Jenkins. */
function jenkinsVars(envText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of envText.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const name = line.slice(0, at);
    if (/^[A-Z0-9_]+$/.test(name) && name.includes('JENKINS')) out.set(name, line.slice(at + 1));
  }
  return out;
}

/** The first variable whose name ends one of these ways. MCP_-prefixed names win: that is the server's own. */
function pick(vars: Map<string, string>, endings: string[]): string | null {
  const names = [...vars.keys()].sort((a, b) => Number(b.startsWith('MCP_')) - Number(a.startsWith('MCP_')));
  for (const ending of endings) {
    const found = names.find((n) => n.endsWith(ending) && vars.get(n));
    if (found) return vars.get(found)!;
  }
  return null;
}

/**
 * The Jenkins address, user and token the MCP server runs with. Throws FromMcpError with
 * something the developer can act on when they cannot be read.
 */
export async function credentialsFromMcp(file = getConfig().claudeSettingsPath): Promise<{ server: string; creds: JenkinsCredentials }> {
  const found = findJenkinsServer(file);
  if (!found) throw new FromMcpError('Claude Code has no MCP server for Jenkins on this machine, so there is nothing to take the address and token from.');
  const args = envInsteadOfServer(found.stdio.args);
  if (!args) {
    throw new FromMcpError(`The MCP server "${found.name}" is not started by a shell line that execs it, so FryDay cannot read its settings without starting it. Type the address and token in instead.`);
  }
  const vars = jenkinsVars(await read(found.stdio.command, args));
  const baseUrl = pick(vars, ['_URL']);
  const user = pick(vars, ['_USER', '_USERNAME']);
  const token = pick(vars, ['_API_TOKEN', '_TOKEN', '_PASSWORD']);
  const missing = [!baseUrl && 'the address', !user && 'the user', !token && 'the token'].filter(Boolean);
  if (missing.length > 0) {
    const seen = [...vars.keys()].sort();
    throw new FromMcpError(`The MCP server "${found.name}" ran, but ${missing.join(' and ')} could not be found in what it sets${seen.length ? ` (it sets ${seen.join(', ')})` : ''}.`);
  }
  return { server: found.name, creds: { baseUrl: baseUrl!.replace(/\/$/, ''), user: user!, token: token! } };
}
