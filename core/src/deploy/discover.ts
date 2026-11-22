/**
 * Finding the Jenkins job that deploys a project's staging, without the owner naming it.
 *
 * A job is the project's when its last builds checked out the project's repository: that is
 * a fact Jenkins records, not a guess from the job's name. Among those, a job about
 * production is never taken, and one must be able to build the staging branch (it takes a
 * branch parameter, or staging is what it last built). When two jobs fit equally well,
 * FryDay does not pick: the owner is told the names.
 */

import { looksLikeProduction, looksLikeStaging } from './config.js';
import type { JobSummary } from './jenkins.js';

/** "git@github.com:Acme/shop.git" and "https://github.com/acme/shop" are the same repository. */
export function repoKey(url: string): string | null {
  const m = url.trim().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]+@)?([^:/\s]+)[:/](.+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const path = m[2]!.replace(/^\d+\//, ''); // an ssh:// address with a port
  return `${m[1]!.toLowerCase()}/${path.toLowerCase()}`;
}

/** The parameter a job takes the branch in, when it has one. */
export function branchParamOf(parameters: string[]): string | null {
  return parameters.find((p) => /^(git_?)?branch(_?name)?$/i.test(p)) ?? parameters.find((p) => /branch/i.test(p)) ?? null;
}

const builtBranch = (job: JobSummary, branch: string) =>
  job.branches.some((b) => b.replace(/^(refs\/remotes\/)?origin\//, '').replace(/^refs\/heads\//, '') === branch);

export type Found =
  | { kind: 'found'; job: string; branchParam: string | null }
  | { kind: 'several'; jobs: string[] }
  | { kind: 'none'; looked: number };

export interface Candidate { name: string; branchParam: string | null; score: number }

/**
 * Every job that could deploy this project's staging, best first: it builds the project's
 * repository, is not about production, and can be made to build the staging branch. This is
 * the whole list anyone but the owner at the Projects page may choose from.
 */
export function deployJobsOf(jobs: JobSummary[], remoteUrl: string, stgBranch: string): Candidate[] {
  const want = repoKey(remoteUrl);
  return jobs
    .filter((j) => j.buildable && !looksLikeProduction(j.name) && want !== null && j.remotes.some((r) => repoKey(r) === want))
    .map((j) => ({ job: j, branchParam: branchParamOf(j.parameters), builtStg: builtBranch(j, stgBranch) }))
    .filter((c) => c.branchParam !== null || c.builtStg)
    .map((c) => ({ name: c.job.name, branchParam: c.branchParam, score: (c.builtStg ? 4 : 0) + (looksLikeStaging(c.job.name) ? 2 : 0) + (c.branchParam ? 1 : 0) }))
    .sort((a, b) => b.score - a.score);
}

export function pickDeployJob(jobs: JobSummary[], remoteUrl: string, stgBranch: string): Found {
  const fits = deployJobsOf(jobs, remoteUrl, stgBranch);
  if (fits.length === 0) return { kind: 'none', looked: jobs.length };
  const best = fits[0]!;
  const tied = fits.filter((c) => c.score === best.score);
  if (tied.length > 1) return { kind: 'several', jobs: tied.map((c) => c.name).slice(0, 6) };
  return { kind: 'found', job: best.name, branchParam: best.branchParam };
}

/** The candidate a name given in conversation means: its full name, or its last part when only one has it. */
export function candidateNamed(fits: Candidate[], said: string): Candidate | null {
  const want = said.trim().toLowerCase();
  const tail = (n: string) => n.split('/').pop()!.toLowerCase();
  const exact = fits.filter((c) => c.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0]!;
  const byTail = fits.filter((c) => tail(c.name) === tail(want));
  return byTail.length === 1 ? byTail[0]! : null;
}
