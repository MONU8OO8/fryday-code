/**
 * A project's run profile: how core starts the project as a running service so tester
 * agents can use it the way a client or a person would.
 *
 * The developer writes it once on the Projects page. Without one, a change is checked by
 * the repo's own commands and by review, but never exercised running.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names core sets itself, or that would change how the sandboxed command runs. */
const RESERVED_ENV = new Set(['PORT', 'HOST', 'HOME', 'PATH', 'TMPDIR', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']);

const urlPath = z.string().trim().max(300).regex(/^\/(?![/\\])[^\s]*$/, 'must be a path on the service, starting with "/"');

const RunProfileSchema = z.object({
  /** The command line that starts the service in the repository folder, e.g. "npm start". */
  command: z.string().trim().min(1).max(500),
  /**
   * The port the service listens on. Leave empty when the service reads its port from
   * PORT: core then picks a free one, which also lets two tasks be verified in a row
   * without waiting for the port.
   */
  port: z.number().int().min(1024).max(65535).nullable().default(null),
  /** A path that answers once the service is up. Any answer below 500 counts. */
  readyPath: urlPath.default('/'),
  readyTimeoutSec: z.number().int().min(5).max(600).default(60),
  /** Plain values for the service's environment. Not for secrets: they are stored and shown. */
  env: z.record(z.string().regex(ENV_NAME, 'is not an environment variable name'), z.string().max(2000)).default({}),
  /**
   * A file of NAME=value lines with local or test values the service needs. Core reads
   * it when it starts the service; it is never copied into an agent's checkout.
   */
  envFile: z.string().trim().max(500).nullable().default(null),
  /** Exercise the HTTP API with the API tester. */
  api: z.boolean().default(true),
  /** Open the pages in a browser with the UI tester. */
  ui: z.boolean().default(false),
  /** Where the UI tester starts. */
  uiPath: urlPath.default('/'),
}).strict();

export type RunProfile = z.infer<typeof RunProfileSchema>;

export class ProfileError extends Error {}

/** The profile as stored on a project, or null when there is none or it is not usable. */
export function parseRunProfile(raw: unknown): RunProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = RunProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Check a profile the developer entered. Returns it with defaults filled in, or throws with what is wrong. */
export function validateRunProfile(raw: unknown): RunProfile {
  const parsed = RunProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProfileError(parsed.error.issues.map((i) => `${i.path.join('.') || 'run profile'}: ${i.message}`).join('; '));
  }
  const profile = parsed.data;
  for (const name of Object.keys(profile.env)) {
    if (RESERVED_ENV.has(name)) throw new ProfileError(`${name} is set by FryDay Code and cannot be given in the run profile`);
  }
  if (!profile.api && !profile.ui) throw new ProfileError('Choose at least one of the API tester and the UI tester, or remove the run profile');
  return profile;
}

/** NAME=value lines, the way dotenv files are written. Comments and blank lines are skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!ENV_NAME.test(name) || RESERVED_ENV.has(name)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, '');
    out[name] = value;
  }
  return out;
}

/**
 * The environment the service gets from its profile: the env file first, the plain
 * values over it. A relative env file is looked up in the developer's own clone.
 */
export function profileEnv(profile: RunProfile, ownerRepoPath: string): Record<string, string> {
  let fromFile: Record<string, string> = {};
  if (profile.envFile) {
    const file = path.isAbsolute(profile.envFile) ? profile.envFile : path.join(ownerRepoPath, profile.envFile);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw new ProfileError(`The run profile's env file was not found: ${file}`);
    }
    fromFile = parseEnvFile(text);
  }
  return { ...fromFile, ...profile.env };
}
