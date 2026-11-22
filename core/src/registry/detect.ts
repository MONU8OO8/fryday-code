/**
 * Working out a project's facts from its clone, so the developer confirms them rather
 * than typing them: where the repository root is, its remote, which branch is
 * production, whether there is a staging branch, and how the code is checked.
 *
 * Everything here is a suggestion. Nothing is saved until the developer says so, and a
 * project starts unverified.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { git, gitAsync } from '../pipeline/worktrees.js';
import { getRepo, type NewProject } from './registry.js';

export interface Detection {
  facts: NewProject;
  /** What was found and how each suggestion was reached. */
  notes: string[];
  /** Things the developer has to sort out before tasks can run. */
  problems: string[];
}

export class DetectError extends Error {}

const STAGING_NAMES = ['stg', 'staging', 'stage'];
const GIT_URL = /^(https:\/\/[\w.-]+(:\d+)?\/[\w./~-]+|ssh:\/\/[\w.@-]+(:\d+)?\/[\w./~-]+|[\w.-]+@[\w.-]+:[\w./~-]+)$/;

/** A remote URL with any embedded user name or token removed. */
export function withoutCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^/@]+@/, '$1');
}

export function isGitUrl(url: string): boolean {
  return GIT_URL.test(url) && !url.startsWith('-');
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 60) || 'project';
}

function freeId(base: string): string {
  if (!getRepo(base)) return base;
  for (let n = 2; ; n++) if (!getRepo(`${base}-${n}`)) return `${base}-${n}`;
}

interface Commands {
  testCmd: string | null;
  lintCmd: string | null;
  typecheckCmd: string | null;
  installCmd: string | null;
}

/** Check commands a repository offers, from its own files. */
export function detectCommands(root: string, notes: string[]): Commands {
  const has = (f: string) => fs.existsSync(path.join(root, f));
  const cmds: Commands = { testCmd: null, lintCmd: null, typecheckCmd: null, installCmd: null };

  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg) {
    const scripts = (pkg['scripts'] && typeof pkg['scripts'] === 'object' ? pkg['scripts'] : {}) as Record<string, string>;
    const deps = { ...(pkg['dependencies'] as object), ...(pkg['devDependencies'] as object) } as Record<string, string>;
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const run = (script: string) => (pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`);
    cmds.installCmd = pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : has('package-lock.json') ? 'npm ci' : null;

    const test = scripts['test'];
    if (test && !/no test specified/.test(test)) {
      // Jest starts a worker per core by default, which can exhaust memory on a laptop.
      cmds.testCmd = /^jest(\s|$)/.test(test.trim()) ? 'npx --no-install jest --ci --maxWorkers=2' : pm === 'npm' ? 'npm test' : `${pm} test`;
      notes.push(`Tests: package.json "test" is \`${test}\`.`);
    } else {
      notes.push('No test script in package.json.');
    }

    const lint = scripts['lint'];
    if (lint && /--fix\b/.test(lint)) {
      notes.push(`Lint: the "lint" script fixes files (\`${lint}\`), so it would hide problems instead of reporting them. Set a check-only command if you want lint checked.`);
    } else if (lint) {
      cmds.lintCmd = run('lint');
    }

    const start = ['start', 'serve', 'dev'].find((s) => scripts[s]);
    if (start) {
      notes.push(`It can be started with \`${start === 'start' && pm === 'npm' ? 'npm start' : run(start)}\`. Add a run profile to have every change tried out running by the API and UI testers.`);
    }

    const typeScript = ['typecheck', 'type-check', 'check-types', 'tsc'].find((s) => scripts[s]);
    if (typeScript) cmds.typecheckCmd = run(typeScript);
    else if (has('tsconfig.json') && deps['typescript']) cmds.typecheckCmd = 'npx --no-install tsc --noEmit';
    return cmds;
  }

  if (has('pyproject.toml') || has('pytest.ini') || has('setup.cfg') || has('requirements.txt')) {
    if (has('tests') || has('test') || has('pytest.ini')) cmds.testCmd = 'python3 -m pytest -q';
    notes.push('Python project: dependencies are not installed by FryDay Code yet, so checks only run if they work without them.');
    return cmds;
  }
  if (has('go.mod')) {
    cmds.testCmd = 'go test ./...';
    cmds.typecheckCmd = 'go vet ./...';
    return cmds;
  }
  if (has('Makefile') && /^test:/m.test(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'))) {
    cmds.testCmd = 'make test';
    return cmds;
  }
  notes.push('No known test setup found. Set the check commands yourself, or leave them empty.');
  return cmds;
}

/** Suggest a project's facts from a path inside its clone. */
export function detectProject(inputPath: string): Detection {
  const given = inputPath.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(given)) throw new DetectError('Give the full path to the clone, starting with / or ~');
  if (!fs.existsSync(given) || !fs.statSync(given).isDirectory()) throw new DetectError(`${given} is not a folder`);
  const root = tryGit(given, ['rev-parse', '--show-toplevel']);
  if (!root) throw new DetectError(`${given} is not inside a git repository`);

  const notes: string[] = [];
  const problems: string[] = [];
  if (path.resolve(root) !== path.resolve(given)) notes.push(`Using the repository root, ${root}.`);

  const remote = tryGit(root, ['remote', 'get-url', 'origin']);
  if (!remote) problems.push('This clone has no "origin" remote, so there is nothing to branch from or release to.');

  let prodBranch = (tryGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) ?? '').replace(/^origin\//, '');
  if (prodBranch) {
    notes.push(`Production branch: ${prodBranch} (the remote's default branch). Change it if you release from another branch.`);
  } else {
    prodBranch = ['main', 'master'].find((b) => tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]) !== null) ?? '';
    if (prodBranch) notes.push(`Production branch: ${prodBranch} (the remote has no default recorded locally; this is a guess).`);
    else problems.push('Could not tell which branch is production. Enter it.');
  }

  const stgBranch = STAGING_NAMES.find((b) => b !== prodBranch && tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]) !== null) ?? null;
  notes.push(stgBranch ? `Staging branch: ${stgBranch}.` : 'No staging branch found (looked for stg, staging, stage). Tasks will stop after review.');

  if (tryGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null) problems.push('This repository has no commits yet.');

  const pkg = readJson(path.join(root, 'package.json'));
  const folder = path.basename(root);
  const name = typeof pkg?.['name'] === 'string' && pkg['name'] ? String(pkg['name']) : folder;
  const commands = detectCommands(root, notes);

  return {
    facts: {
      id: freeId(slug(folder)),
      name,
      localPath: root,
      remoteUrl: remote ? withoutCredentials(remote) : null,
      prodBranch,
      stgBranch,
      ...commands,
      verified: false,
      notes: '',
    },
    notes,
    problems,
  };
}

/**
 * Clone a repository into FryDay Code's own folder, using the developer's git setup.
 * Returns the path of the new clone.
 */
export async function cloneRepository(url: string, reposDir: string): Promise<string> {
  if (!isGitUrl(url)) throw new DetectError('That does not look like a git URL (https://…, ssh://… or git@host:owner/repo)');
  const name = slug(path.basename(url.replace(/\/+$/, '')).replace(/\.git$/, ''));
  fs.mkdirSync(reposDir, { recursive: true });
  let target = path.join(reposDir, name);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(reposDir, `${name}-${n}`);
  try {
    // `--` keeps a URL from ever being read as an option.
    await gitAsync(reposDir, ['clone', '--', url, target], 10 * 60_000);
  } catch (err) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new DetectError(`Cloning failed: ${err instanceof Error ? err.message.split('\n').pop() : String(err)}`);
  }
  return target;
}
