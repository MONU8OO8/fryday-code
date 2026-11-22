/**
 * Deploy settings: the Jenkins this install uses (with its credentials), and per project
 * which job deploys its staging branch.
 *
 * The credentials are a secret. They are kept in <FRYDAY_HOME>/jenkins.json, readable
 * only by the developer, can be set and removed, and are never sent back to the UI or
 * to any agent. No agent can read the state folder.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { JenkinsClient, JenkinsError, jobPath, normaliseBase, type JenkinsCredentials } from './jenkins.js';

// ─── The Jenkins ──────────────────────────────────────────────────────────────

export class DeployConfigError extends Error {}

const credsFile = () => path.join(getConfig().home, 'jenkins.json');

export interface JenkinsStatus {
  configured: boolean;
  /** The address and the user name; never the token. */
  baseUrl: string | null;
  user: string | null;
}

export function loadJenkinsCredentials(): JenkinsCredentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(credsFile(), 'utf8')) as Partial<JenkinsCredentials>;
    if (typeof raw.baseUrl === 'string' && typeof raw.user === 'string' && typeof raw.token === 'string' && raw.token) return { baseUrl: raw.baseUrl, user: raw.user, token: raw.token };
  } catch {
    /* not set up */
  }
  return null;
}

export function jenkinsStatus(): JenkinsStatus {
  const c = loadJenkinsCredentials();
  return { configured: c !== null, baseUrl: c?.baseUrl ?? null, user: c?.user ?? null };
}

/** The three fields, checked for shape only. Throws DeployConfigError on anything unusable. */
export function readCredentials(input: { baseUrl?: unknown; user?: unknown; token?: unknown }): JenkinsCredentials {
  const user = typeof input.user === 'string' ? input.user.trim() : '';
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!user || user.length > 200 || /[\s:]/.test(user)) throw new DeployConfigError('The Jenkins user name is required and has no spaces or colons');
  if (!token || token.length > 500 || /\s/.test(token)) throw new DeployConfigError('The Jenkins API token is required (Jenkins → your name → Security → API Token)');
  let base: URL;
  try {
    base = normaliseBase(typeof input.baseUrl === 'string' ? input.baseUrl : '');
  } catch (err) {
    throw new DeployConfigError(err instanceof JenkinsError ? err.message : String(err));
  }
  return { baseUrl: base.href.replace(/\/$/, ''), user, token };
}

export function saveJenkinsCredentials(input: { baseUrl?: unknown; user?: unknown; token?: unknown }): JenkinsStatus {
  const { baseUrl, user, token } = readCredentials(input);
  const base = new URL(baseUrl);
  fs.mkdirSync(path.dirname(credsFile()), { recursive: true, mode: 0o700 });
  const tmp = `${credsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ baseUrl: base.href.replace(/\/$/, ''), user, token }), { mode: 0o600 });
  fs.renameSync(tmp, credsFile());
  return jenkinsStatus();
}

export function removeJenkinsCredentials(): JenkinsStatus {
  fs.rmSync(credsFile(), { force: true });
  return jenkinsStatus();
}

// ─── Per project ──────────────────────────────────────────────────────────────

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/;

const JenkinsDeployerSchema = z.object({
  /** The job, with its folders: "team/service/deploy". */
  job: z.string().trim().min(1).max(300),
  /**
   * The parameter that names the branch to build, e.g. "BRANCH". FryDay sets it to the
   * staging branch. Null for a job that always builds staging.
   */
  branchParam: z.string().trim().regex(PARAM_NAME).nullable().default(null),
  /** Other parameters, passed as they are. Not for secrets: they are stored and shown. */
  params: z.record(z.string().regex(PARAM_NAME), z.string().max(500)).default({}),
  /**
   * The pipeline stage that is the staging deploy, e.g. "Deploy to STG". When set, the
   * deploy has succeeded once that stage has; later stages (a production deploy waiting
   * for someone's yes) are not FryDay's. When empty, the whole build must succeed.
   */
  stage: z.string().trim().min(1).max(200).nullable().default(null),
  /** Longest FryDay follows a build before it hands it to the owner. */
  timeoutMinutes: z.number().int().min(1).max(24 * 60).default(60),
}).strict();

export type JenkinsDeployer = z.infer<typeof JenkinsDeployerSchema>;

/** Check a deployer the developer entered. Returns it with defaults, or throws with what is wrong. */
export function validateDeployer(kind: string | null, raw: unknown): JenkinsDeployer | null {
  if (kind === null) return null;
  if (kind !== 'jenkins') throw new DeployConfigError(`Unknown deployer "${kind}"`);
  const parsed = JenkinsDeployerSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new DeployConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'deployer'}: ${i.message}`).join('; '));
  try {
    jobPath(parsed.data.job);
  } catch (err) {
    throw new DeployConfigError(err instanceof Error ? err.message : String(err));
  }
  if (parsed.data.branchParam && parsed.data.branchParam in parsed.data.params) {
    throw new DeployConfigError(`${parsed.data.branchParam} is set by FryDay to the staging branch; leave it out of the other parameters`);
  }
  return parsed.data;
}

/** The deployer of a project as stored, or null when there is none or it no longer validates. */
export function deployerOf(project: { deployer: string | null; deployerConfig: Record<string, unknown> | null }): JenkinsDeployer | null {
  try {
    return validateDeployer(project.deployer, project.deployerConfig);
  } catch {
    return null;
  }
}

/** The parameters a deploy of this branch is started with. */
export function deployParams(d: JenkinsDeployer, stgBranch: string): Record<string, string> {
  return { ...d.params, ...(d.branchParam ? { [d.branchParam]: stgBranch } : {}) };
}

// ─── Telling staging from production ──────────────────────────────────────────

const PRODUCTION = /(^|[^a-z])(prod|production|live|prd|release to customers|go[- ]live)([^a-z]|$)/i;
const STAGING = /(^|[^a-z])(stg|stag|staging|stage|dev|test|qa|uat|preprod|pre-prod|sandbox)([^a-z]|$)/i;

/**
 * Whether a pipeline prompt may be put to the owner as a staging step. Anything that
 * mentions production — or does not clearly say staging — is never answered by FryDay.
 */
export function inputKind(stageName: string | null, message: string, proceedText: string): 'staging' | 'production' | 'unclear' {
  const text = `${stageName ?? ''} ${message} ${proceedText}`;
  if (PRODUCTION.test(text)) return 'production';
  if (STAGING.test(text)) return 'staging';
  return 'unclear';
}

/** A job or stage name that is about production. FryDay never sets one up as a staging deployer. */
export const looksLikeProduction = (text: string): boolean => PRODUCTION.test(text);
export const looksLikeStaging = (text: string): boolean => STAGING.test(text);

const SAYS_STAGING = /(^|[^a-z])(stg|stag|staging|pre-?prod|uat)([^a-z]|$)/i;

/**
 * Whether FryDay may answer a pipeline prompt itself, under a yes the owner gave for "put it on
 * staging". Stricter than what may be put to the owner: the prompt has to name staging outright
 * ("Move to STG"). A prompt that only says "test" or "dev" could be the gate before anything,
 * so that one still goes to the owner.
 */
export function answersItself(stageName: string | null, message: string, proceedText: string, hasParameters: boolean): boolean {
  return !hasParameters && inputKind(stageName, message, proceedText) === 'staging' && SAYS_STAGING.test(`${stageName ?? ''} ${message} ${proceedText}`);
}

// ─── Checking a setup before it is kept ───────────────────────────────────────

/**
 * What a check of the Jenkins setup found, in words the owner can act on. Deploys are the one
 * thing FryDay cannot try out for itself later, so both the credentials and the job a project
 * names are checked when they are given, not left to fail at the deploy.
 */
export interface JenkinsCheck {
  ok: boolean;
  /** Who Jenkins says we are, when the credentials work. */
  user: string | null;
  /** The problem, in one sentence, when ok is false. */
  problem: string | null;
  /** Job names that do exist, when the one given is not there. */
  didYouMean: string[];
  /** The credentials are fine but Jenkins could not be reached to be sure. */
  unreachable: boolean;
}

const nearest = (want: string, names: string[]): string[] => {
  const tail = (n: string) => n.split('/').pop() ?? n;
  const w = tail(want).toLowerCase().replace(/[^a-z0-9]/g, '');
  const score = (n: string) => {
    const t = tail(n).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!t || !w) return 0;
    if (t === w) return 100;
    if (w.includes(t) || t.includes(w)) return 50 + Math.min(t.length, w.length);
    const shared = [...new Set(t)].filter((c) => w.includes(c)).length;
    return shared;
  };
  return names.filter((n) => score(n) > 3).sort((a, b) => score(b) - score(a)).slice(0, 5);
};

/**
 * Ask Jenkins whether these credentials work, and whether the job is there with the branch
 * parameter it is meant to take. Read-only: nothing is started.
 */
export async function checkJenkins(
  creds: JenkinsCredentials,
  job?: { name: string; branchParam: string },
  client = new JenkinsClient(creds),
): Promise<JenkinsCheck> {
  const base = { ok: false, user: null as string | null, problem: null as string | null, didYouMean: [] as string[], unreachable: false };
  let user: string;
  try {
    user = await client.whoAmI();
  } catch (err) {
    if (!(err instanceof JenkinsError)) throw err;
    // Refused is an answer: the credentials are wrong. Not reached is not an answer about them.
    const refused = err.status === 401 || err.status === 403;
    return { ...base, problem: err.message, unreachable: !refused };
  }
  if (!job) return { ...base, ok: true, user };
  try {
    const info = await client.jobInfo(job.name);
    const names = info.parameters.map((p) => p.name);
    if (!info.buildable) return { ...base, user, problem: `The job ${info.fullName} is there but is disabled in Jenkins, so it cannot be started.` };
    if (!names.includes(job.branchParam)) {
      const has = names.length ? `it takes ${names.join(', ')}` : 'it takes no parameters';
      return { ...base, user, problem: `The job ${info.fullName} has no "${job.branchParam}" parameter (${has}), so FryDay cannot tell it which branch to deploy.` };
    }
    return { ...base, ok: true, user };
  } catch (err) {
    if (!(err instanceof JenkinsError)) throw err;
    if (err.status !== 404) return { ...base, user, problem: err.message, unreachable: err.status === null };
    return { ...base, user, problem: `There is no job named ${job.name} on this Jenkins.`, didYouMean: nearest(job.name, await client.siblingJobs(job.name)) };
  }
}
