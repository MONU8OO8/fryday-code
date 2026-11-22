/**
 * Projects — the repositories this install works on, and the facts agents and core
 * need about each: where the clone is, which branch is production, which is staging,
 * how to check the code, how it is deployed.
 *
 * Projects live in the database and belong to the developer who added them. Nothing
 * about any particular company or machine is built into the product.
 */

import fs from 'fs';
import { getDb, nowMs } from '../db/db.js';
import { ProfileError, validateRunProfile } from '../verify/profile.js';
import { DeployConfigError, validateDeployer } from '../deploy/config.js';

export interface Project {
  id: string;
  name: string;
  /** The developer's own clone. Core never changes its working copy. */
  localPath: string;
  remoteUrl: string | null;
  prodBranch: string;
  stgBranch: string | null;
  testCmd: string | null;
  lintCmd: string | null;
  typecheckCmd: string | null;
  installCmd: string | null;
  /** How to start the project as a service for tester agents (verify/profile.ts). Null: it is not run. */
  runProfile: Record<string, unknown> | null;
  /** Which deployer releases staging: 'jenkins', or null for none. */
  deployer: string | null;
  deployerConfig: Record<string, unknown> | null;
  /** The developer has confirmed these facts. Tasks only start on verified projects. */
  verified: boolean;
  notes: string;
}

/** What must be given to add a project; everything else has a default. */
export type NewProject = Pick<Project, 'id' | 'name' | 'localPath' | 'prodBranch'> & Partial<Project>;

interface ProjectRow {
  id: string; name: string; local_path: string; remote_url: string | null; prod_branch: string; stg_branch: string | null;
  test_cmd: string | null; lint_cmd: string | null; typecheck_cmd: string | null; install_cmd: string | null;
  run_profile_json: string | null; deployer: string | null; deployer_config_json: string | null;
  verified: number; notes: string;
}

const parse = (json: string | null): Record<string, unknown> | null => {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const fromRow = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  localPath: r.local_path,
  remoteUrl: r.remote_url,
  prodBranch: r.prod_branch,
  stgBranch: r.stg_branch,
  testCmd: r.test_cmd,
  lintCmd: r.lint_cmd,
  typecheckCmd: r.typecheck_cmd,
  installCmd: r.install_cmd,
  runProfile: parse(r.run_profile_json),
  deployer: r.deployer,
  deployerConfig: parse(r.deployer_config_json),
  verified: r.verified === 1,
  notes: r.notes,
});

export class ProjectError extends Error {}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function getRepo(id: string): Project | undefined {
  const row = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function listRepos(): Project[] {
  return (getDb().prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as ProjectRow[]).map(fromRow);
}

function write(p: Project): void {
  const now = nowMs();
  getDb().prepare(`
    INSERT INTO projects (id, name, local_path, remote_url, prod_branch, stg_branch, test_cmd, lint_cmd, typecheck_cmd,
                          install_cmd, run_profile_json, deployer, deployer_config_json, verified, notes, created_at, updated_at)
    VALUES (@id, @name, @localPath, @remoteUrl, @prodBranch, @stgBranch, @testCmd, @lintCmd, @typecheckCmd,
            @installCmd, @runProfile, @deployer, @deployerConfig, @verified, @notes, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, local_path = excluded.local_path, remote_url = excluded.remote_url,
      prod_branch = excluded.prod_branch, stg_branch = excluded.stg_branch, test_cmd = excluded.test_cmd,
      lint_cmd = excluded.lint_cmd, typecheck_cmd = excluded.typecheck_cmd, install_cmd = excluded.install_cmd,
      run_profile_json = excluded.run_profile_json, deployer = excluded.deployer,
      deployer_config_json = excluded.deployer_config_json, verified = excluded.verified, notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run({
    ...p,
    runProfile: p.runProfile ? JSON.stringify(p.runProfile) : null,
    deployerConfig: p.deployerConfig ? JSON.stringify(p.deployerConfig) : null,
    verified: p.verified ? 1 : 0,
    now,
  });
}

function validate(p: Project): void {
  if (!ID.test(p.id)) throw new ProjectError('A project id is lowercase letters, digits, dots, dashes or underscores');
  if (!p.name.trim()) throw new ProjectError('A project needs a name');
  if (!p.localPath.startsWith('/')) throw new ProjectError('The path to the clone must be absolute');
  if (!p.prodBranch.trim()) throw new ProjectError('A project needs its production branch');
  if (p.stgBranch !== null && p.stgBranch === p.prodBranch) throw new ProjectError('Staging and production cannot be the same branch');
  try {
    // Stored with its defaults filled in, like the run profile.
    const deployer = validateDeployer(p.deployer, p.deployerConfig);
    p.deployerConfig = deployer;
  } catch (err) {
    if (!(err instanceof DeployConfigError)) throw err;
    throw new ProjectError(`Deploy: ${err.message}`);
  }
  if (p.runProfile !== null) {
    try {
      // Stored with its defaults filled in, so what is shown is what will be used.
      p.runProfile = validateRunProfile(p.runProfile);
    } catch (err) {
      if (!(err instanceof ProfileError)) throw err;
      throw new ProjectError(`Run profile: ${err.message}`);
    }
  }
}

/** Add a project, or replace the one with the same id. */
export function saveProject(input: NewProject): Project {
  const project: Project = {
    remoteUrl: null, stgBranch: null, testCmd: null, lintCmd: null, typecheckCmd: null, installCmd: null,
    runProfile: null, deployer: null, deployerConfig: null, verified: false, notes: '',
    ...input,
  };
  validate(project);
  write(project);
  return getRepo(project.id)!;
}

/** Change some facts of an existing project. */
export function overrideRepo(id: string, partial: Partial<Omit<Project, 'id'>>): Project {
  const existing = getRepo(id);
  if (!existing) throw new ProjectError(`Unknown project: ${id}`);
  const updated = { ...existing, ...partial, id };
  validate(updated);
  write(updated);
  return getRepo(id)!;
}

export function setVerified(id: string, verified: boolean): Project {
  return overrideRepo(id, { verified });
}

export function removeProject(id: string): boolean {
  return getDb().prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}

/**
 * On a fresh install, load projects from a seed file if the developer has one
 * (`<FRYDAY_HOME>/projects.seed.json`). Never overwrites existing projects.
 * Returns how many were imported.
 */
export function importSeedIfEmpty(seedPath: string): number {
  const count = (getDb().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
  if (count > 0 || !fs.existsSync(seedPath)) return 0;
  const entries = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as unknown;
  if (!Array.isArray(entries)) throw new ProjectError(`${seedPath} must contain a JSON array of projects`);
  let imported = 0;
  for (const entry of entries) {
    try {
      saveProject(entry as NewProject);
      imported++;
    } catch (err) {
      console.error(`[fryday-core] skipped a project in ${seedPath}:`, err instanceof Error ? err.message : err);
    }
  }
  return imported;
}
