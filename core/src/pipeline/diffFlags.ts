/**
 * What a task's diff does that deserves a second look — found by reading the diff, not
 * by asking an agent.
 *
 *   blocking: the change weakens the tests (deletes a test file, skips or focuses a
 *             test), or adds what looks like a credential (a key, a token, a secrets
 *             file). Green checks mean nothing after the first; the second must never
 *             reach a remote. Either way the task goes back.
 *   review:   the change touches something that runs code elsewhere or loosens a
 *             safety net (hooks, CI, package scripts, dependencies, lint/type
 *             suppressions). Allowed, but shown to the Tester and the owner.
 */

import { SECRET_VALUES } from '../secretPatterns.js';

export type FlagSeverity = 'blocking' | 'review';

export interface DiffFlag {
  severity: FlagSeverity;
  kind:
    | 'test-deleted'
    | 'test-skipped'
    | 'test-focused'
    | 'hook-or-ci'
    | 'package-scripts'
    | 'dependencies'
    | 'suppression'
    | 'claude-config'
    | 'secret';
  path: string;
  detail: string;
}

export interface ChangedFile {
  status: string;
  path: string;
}

const TEST_FILE = /(^|\/)(__tests__|tests?|specs?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|Tests?\.(java|kt|cs)$/;
const SKIPPED = /\b(describe|context|it|test|suite)\s*\.\s*skip\s*\(|\b(xit|xtest|xdescribe|xcontext)\s*\(|\b(it|test)\s*\.\s*todo\s*\(|@pytest\.mark\.(skip|skipif|xfail)|@unittest\.skip|\bt\.Skip(f|Now)?\(|@Ignore\b|@Disabled\b|\{\s*skip:\s*true/;
const FOCUSED = /\b(describe|context|it|test|suite)\s*\.\s*only\s*\(|\b(fit|fdescribe)\s*\(|\{\s*only:\s*true/;
const HOOK_OR_CI = /(^|\/)(\.husky|\.githooks|\.github\/workflows|\.circleci)\/|(^|\/)(Jenkinsfile|\.gitlab-ci\.yml|Dockerfile|docker-compose[^/]*\.ya?ml|Makefile|lefthook\.ya?ml|\.pre-commit-config\.yaml)$/;
const DEPENDENCY_FILE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|poetry\.lock|Pipfile(\.lock)?|go\.(mod|sum))$/;
const CLAUDE_CONFIG = /(^|\/)(\.claude\/|\.cursor\/|CLAUDE\.md$|AGENTS\.md$|\.mcp\.json$)/;
// The guard's secrets-file pattern (guard/decide.mjs SECRET_FILE / SECRET_OK); diffFlags.test.ts checks the two agree.
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|p12|pfx|keystore)|.*creds?.*\.sh|credentials(\.json)?|secrets?(\.(json|ya?ml|env))?)$/i;
const SECRET_OK = /(^|\/)\.env\.(example|sample|template)$/i;
const SUPPRESSION = /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|#\s*type:\s*ignore|#\s*noqa|nolint|istanbul ignore|c8 ignore|pragma: no cover/;

/** Added lines per file, from a unified diff (`git diff -U0` is enough). */
export function addedLinesByFile(patch: string): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      const file = line.slice(4).replace(/^b\//, '');
      current = file === '/dev/null' ? null : [];
      if (current) byFile.set(file, current);
    } else if (line.startsWith('diff --git ')) {
      current = null;
    } else if (current && line.startsWith('+') && !line.startsWith('+++')) {
      current.push(line.slice(1));
    }
  }
  return byFile;
}

function scriptsOf(packageJson: string | null): Record<string, string> {
  if (!packageJson) return {};
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: unknown }).scripts;
    return scripts && typeof scripts === 'object' ? (scripts as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export interface AnalyzeInput {
  files: ChangedFile[];
  /** Unified diff of the task's changes. */
  patch: string;
  /** package.json content before and after, per changed package.json path. */
  packageJson?: Record<string, { before: string | null; after: string | null }>;
}

export function analyzeDiff(input: AnalyzeInput): DiffFlag[] {
  const flags: DiffFlag[] = [];
  const added = addedLinesByFile(input.patch);

  for (const file of input.files) {
    const p = file.path;
    const isTest = TEST_FILE.test(p);

    if (isTest && file.status.startsWith('D')) {
      flags.push({ severity: 'blocking', kind: 'test-deleted', path: p, detail: 'a test file was deleted' });
    }
    if (HOOK_OR_CI.test(p)) {
      flags.push({ severity: 'review', kind: 'hook-or-ci', path: p, detail: 'hooks, CI or build configuration changed' });
    }
    if (DEPENDENCY_FILE.test(p)) {
      flags.push({ severity: 'review', kind: 'dependencies', path: p, detail: 'dependencies changed' });
    }
    if (CLAUDE_CONFIG.test(p)) {
      flags.push({ severity: 'review', kind: 'claude-config', path: p, detail: 'instructions or settings for AI agents changed' });
    }
    if (!file.status.startsWith('D') && SECRET_FILE.test(p) && !SECRET_OK.test(p)) {
      flags.push({ severity: 'blocking', kind: 'secret', path: p, detail: 'a file that holds secrets was added or changed' });
    }

    const lines = added.get(p) ?? [];
    // The detail names what it looks like and where; it never repeats the value.
    for (const [what, pattern] of SECRET_VALUES) {
      const at = lines.findIndex((l) => pattern.test(l));
      if (at >= 0) { flags.push({ severity: 'blocking', kind: 'secret', path: p, detail: `an added line looks like ${what}` }); break; }
    }
    if (isTest) {
      const skipped = lines.find((l) => SKIPPED.test(l));
      if (skipped) flags.push({ severity: 'blocking', kind: 'test-skipped', path: p, detail: `a test was skipped: ${skipped.trim().slice(0, 120)}` });
      const focused = lines.find((l) => FOCUSED.test(l));
      if (focused) flags.push({ severity: 'blocking', kind: 'test-focused', path: p, detail: `a test was focused, so the others no longer run: ${focused.trim().slice(0, 120)}` });
    }
    const suppressed = lines.find((l) => SUPPRESSION.test(l));
    if (suppressed) flags.push({ severity: 'review', kind: 'suppression', path: p, detail: `a lint, type or coverage check was silenced: ${suppressed.trim().slice(0, 120)}` });

    if (/(^|\/)package\.json$/.test(p)) {
      const pkg = input.packageJson?.[p];
      const before = scriptsOf(pkg?.before ?? null);
      const after = scriptsOf(pkg?.after ?? null);
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
      if (changed.length > 0) {
        flags.push({ severity: 'review', kind: 'package-scripts', path: p, detail: `package scripts changed: ${changed.join(', ')}` });
      }
      const deps = (text: string | null) => {
        try {
          const j = JSON.parse(text ?? '{}') as Record<string, unknown>;
          return JSON.stringify([j['dependencies'], j['devDependencies'], j['peerDependencies'], j['optionalDependencies']]);
        } catch {
          return '';
        }
      };
      if (pkg && deps(pkg.before) !== deps(pkg.after)) {
        flags.push({ severity: 'review', kind: 'dependencies', path: p, detail: 'dependencies changed' });
      }
    }
  }
  return flags;
}

export function hasBlockingFlag(flags: DiffFlag[]): boolean {
  return flags.some((f) => f.severity === 'blocking');
}
