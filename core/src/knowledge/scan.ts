/**
 * What a project is made of, read without a model from its production commit: package
 * names and scripts, env key names (never values), the services it calls, the routes it
 * exposes and its docker-compose services.
 *
 * Files are read from git's object store at the commit (`ls-tree` + `cat-file --batch`):
 * nothing is checked out, nothing is written, nothing from the repository runs. A real
 * `.env` file is never opened, even when it is committed; only `.env.example`-style files are.
 */

import { execFileSync, spawn } from 'child_process';
import { git } from '../pipeline/worktrees.js';
import { redactSecrets } from '../secretPatterns.js';

export interface ScanFile { path: string; text: string }

export interface Route { method: string; path: string; file: string }

export interface ScanFacts {
  sha: string;
  packageName: string | null;
  /** Other package.json names in the repository (a monorepo's packages). */
  packages: string[];
  scripts: string[];
  dependencies: string[];
  frameworks: string[];
  topDirs: Array<{ dir: string; files: number }>;
  /** Second-level folders under src/, app/, lib/ or packages/, with the most files. */
  modules: Array<{ dir: string; files: number }>;
  entryPoints: string[];
  envKeys: string[];
  /** Env keys that point at another service (ending in _URL or _HOST), where they are used. */
  outbound: Array<{ key: string; files: string[] }>;
  /** Outside hosts written literally in a base URL or a fetch. */
  hosts: Array<{ host: string; files: string[] }>;
  routes: Route[];
  composeServices: string[];
  /** Some files were left out to stay within the scan's limits. */
  truncated: boolean;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', 'vendor', '.git', '.turbo', '.cache', 'tmp', '__snapshots__']);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const COMPOSE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/;
const ENV_EXAMPLE = /(^|\/)\.env(\.[\w-]+)*\.(example|sample|template|dist|defaults?)$/i;
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const LIST_CAP = 200;

/** A real env file: `.env`, `.env.local`, `.env.production`… Never opened. */
export { SKIP_DIRS, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES };

export const isRealEnvFile = (file: string): boolean => {
  const base = file.split('/').pop() ?? '';
  return /^\.env(\..+)?$/.test(base) && !ENV_EXAMPLE.test(file);
};

export const skipped = (file: string) => file.split('/').slice(0, -1).some((d) => SKIP_DIRS.has(d)) || /\.(min|bundle)\.js$/.test(file) || /\.d\.ts$/.test(file);

/** The files worth opening, most telling first; null for a file never to open. */
function rank(file: string): number | null {
  if (skipped(file) || isRealEnvFile(file)) return null;
  const base = file.split('/').pop()!;
  if (base === 'package.json') return 0;
  if (ENV_EXAMPLE.test(file) || COMPOSE.test(file)) return 0;
  if (/(^|\/)(config|configs)\//.test(file) && /\.(json|ya?ml|ts|js)$/.test(file)) return 1;
  if (/\.config\.(ts|js|mjs|cjs)$/.test(file)) return 1;
  if (/\.(spec|test)\.[jt]sx?$/.test(file) || /(^|\/)(__tests__|test|tests|e2e)\//.test(file)) return null;
  if (SOURCE.test(file)) return /(^|\/)(main|server|app|index)\.[jt]s$/.test(file) ? 2 : 3;
  return null;
}

export function pickFiles(paths: string[]): { files: string[]; truncated: boolean } {
  const ranked = paths.map((p) => [p, rank(p)] as const).filter((x): x is readonly [string, number] => x[1] !== null);
  ranked.sort((a, b) => a[1] - b[1] || a[0].split('/').length - b[0].split('/').length || a[0].localeCompare(b[0]));
  return { files: ranked.slice(0, MAX_FILES).map((x) => x[0]), truncated: ranked.length > MAX_FILES };
}

/** Text from a repository, made safe to keep: no control characters, nothing secret-looking, a sane length. */
export const cleanLabel = (s: string, max = 200) => redactSecrets(s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, max);

const OUTBOUND = /^[A-Z][A-Z0-9_]*_(URL|HOST)$/;
const ENV_CODE = [
  /process\.env\.([A-Z][A-Z0-9_]{1,})/g,
  /process\.env\[\s*['"`]([A-Z][A-Z0-9_]{1,})['"`]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]{1,})/g,
  /\b\w*[cC]onfig\w*\s*\.\s*get(?:OrThrow)?\s*(?:<[^>()]*>)?\(\s*['"`]([A-Z][A-Z0-9_]{1,})['"`]/g,
];
const HOST_CODE = [
  /baseURL\s*:\s*['"`](https?:\/\/[^'"`\s$]+)/g,
  /\bfetch\(\s*['"`](https?:\/\/[^'"`\s$]+)/g,
  /\baxios\.(?:get|post|put|patch|delete|request)\(\s*['"`](https?:\/\/[^'"`\s$]+)/g,
];
const FRAMEWORKS: Array<[string, string]> = [
  ['@nestjs/core', 'NestJS'], ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'], ['next', 'Next.js'], ['react', 'React'],
  ['vue', 'Vue'], ['@angular/core', 'Angular'], ['typeorm', 'TypeORM'], ['prisma', 'Prisma'], ['@prisma/client', 'Prisma'], ['mongoose', 'Mongoose'],
  ['sequelize', 'Sequelize'], ['react-native', 'React Native'], ['expo', 'Expo'], ['vite', 'Vite'],
];

function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (!h || h === 'localhost' || /^127\.|^0\.0\.0\.0$|^\[?::1\]?$/.test(h) || /(^|\.)example\.(com|org|net)$/.test(h)) return null;
    return h;
  } catch {
    return null;
  }
}

const joinPath = (...parts: Array<string | undefined>) => {
  const p = parts.filter((x) => x && x !== '/').map((x) => x!.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
  return `/${p}`;
};

/** Routes a NestJS controller file exposes, with the app's global prefix. */
export function nestRoutes(file: string, text: string, globalPrefix = ''): Route[] {
  const out: Route[] = [];
  const controllers = [...text.matchAll(/@Controller\(\s*(?:['"`]([^'"`]*)['"`]|\{[^}]*?path\s*:\s*['"`]([^'"`]*)['"`][^}]*\})?\s*\)/g)]
    .map((m) => ({ at: m.index!, prefix: m[1] ?? m[2] ?? '' }));
  if (controllers.length === 0) return out;
  for (const m of text.matchAll(/@(Get|Post|Put|Patch|Delete|All|Options|Head)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g)) {
    const owner = [...controllers].reverse().find((c) => c.at < m.index!);
    if (!owner) continue;
    out.push({ method: m[1]!.toUpperCase() === 'ALL' ? 'ANY' : m[1]!.toUpperCase(), path: joinPath(globalPrefix, owner.prefix, m[2]), file });
  }
  return out;
}

export function expressRoutes(file: string, text: string): Route[] {
  return [...text.matchAll(/\b(?:router|app|server|api|\w+Router)\s*\.\s*(get|post|put|patch|delete|all)\(\s*['"`](\/[^'"`]*)['"`]/g)]
    .map((m) => ({ method: m[1] === 'all' ? 'ANY' : m[1]!.toUpperCase(), path: m[2]!, file }));
}

/** Next.js API routes, from where the file is (pages/api) or what it exports (app/…/route.ts). */
export function nextRoutes(file: string, text: string): Route[] {
  const pages = file.match(/(?:^|\/)pages\/api\/(.+)\.[jt]sx?$/);
  if (pages) return [{ method: 'ANY', path: joinPath('api', pages[1]!.replace(/(^|\/)index$/, '')), file }];
  const app = file.match(/(?:^|\/)(?:src\/)?app\/(.+)\/route\.[jt]s$/);
  if (!app) return [];
  const segments = app[1]!.split('/').filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
  const methods = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]!);
  return [...new Set(methods.length ? methods : ['ANY'])].map((method) => ({ method, path: joinPath(...segments), file }));
}

/** The top-level service names of a docker-compose file. */
export function composeServices(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  let indent: number | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = line.match(/^(\s+)([A-Za-z0-9_.-]+):\s*(#.*)?$/);
    if (!m) continue;
    indent ??= m[1]!.length;
    if (m[1]!.length === indent) out.push(m[2]!);
  }
  return out;
}

function addUse(map: Map<string, Set<string>>, key: string, file: string) {
  const files = map.get(key) ?? new Set<string>();
  files.add(file);
  map.set(key, files);
}

const counted = (paths: string[], depth: (p: string) => string | null, limit: number) => {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const d = depth(p);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([dir, files]) => ({ dir, files }));
};

/** Everything the scan keeps, from the files it opened and the list of all paths at the commit. */
export function extractFacts(sha: string, allPaths: string[], files: ScanFile[], truncated: boolean): ScanFacts {
  const visible = allPaths.filter((p) => !skipped(p));
  const pkgs = files.filter((f) => f.path.split('/').pop() === 'package.json').sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const parsed = pkgs.map((f) => { try { return { path: f.path, json: JSON.parse(f.text) as Record<string, any> }; } catch { return null; } }).filter((x) => x !== null);
  const root = parsed.find((p) => p!.path === 'package.json')?.json ?? parsed[0]?.json ?? null;
  const deps = new Set<string>();
  for (const p of parsed) for (const k of Object.keys({ ...(p!.json['dependencies'] ?? {}) })) deps.add(k);
  const devDeps = new Set<string>(parsed.flatMap((p) => Object.keys(p!.json['devDependencies'] ?? {})));

  const envKeys = new Set<string>();
  const outbound = new Map<string, Set<string>>();
  const hosts = new Map<string, Set<string>>();
  const routes: Route[] = [];
  const compose = new Set<string>();
  const globalPrefix = files.map((f) => f.text.match(/setGlobalPrefix\(\s*['"`]([^'"`]+)['"`]/)?.[1]).find(Boolean) ?? '';

  for (const f of files) {
    if (ENV_EXAMPLE.test(f.path)) {
      for (const m of f.text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,})\s*=/gm)) envKeys.add(m[1]!);
      continue;
    }
    if (COMPOSE.test(f.path)) { for (const s of composeServices(f.text)) compose.add(s); continue; }
    if (!SOURCE.test(f.path) && !/\.(json|ya?ml)$/.test(f.path)) continue;
    for (const re of ENV_CODE) for (const m of f.text.matchAll(re)) {
      envKeys.add(m[1]!);
      if (OUTBOUND.test(m[1]!)) addUse(outbound, m[1]!, f.path);
    }
    if (!SOURCE.test(f.path)) continue;
    for (const re of HOST_CODE) for (const m of f.text.matchAll(re)) {
      const h = hostOf(m[1]!);
      if (h) addUse(hosts, h, f.path);
    }
    routes.push(...nestRoutes(f.path, f.text, globalPrefix), ...expressRoutes(f.path, f.text), ...nextRoutes(f.path, f.text));
  }
  for (const k of envKeys) if (OUTBOUND.test(k) && !outbound.has(k)) outbound.set(k, new Set());

  const uniqueRoutes = [...new Map(routes.map((r) => [`${r.method} ${r.path}`, r])).values()]
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  const entry = new Set<string>();
  if (typeof root?.['main'] === 'string') entry.add(root['main']);
  for (const p of ['src/main.ts', 'src/index.ts', 'src/server.ts', 'src/app.ts', 'index.js', 'server.js', 'app.js', 'src/main.tsx', 'src/App.tsx', 'app/layout.tsx', 'src/app/layout.tsx', 'pages/_app.tsx', 'App.tsx']) {
    if (allPaths.includes(p)) entry.add(p);
  }
  const all = new Set([...deps, ...devDeps]);
  return {
    sha,
    packageName: typeof root?.['name'] === 'string' ? cleanLabel(root['name'], 100) : null,
    packages: parsed.filter((p) => p!.json !== root && typeof p!.json['name'] === 'string').map((p) => cleanLabel(p!.json['name'], 100)).slice(0, 30),
    scripts: Object.keys(root?.['scripts'] ?? {}).map((s) => cleanLabel(s, 60)).slice(0, 40),
    dependencies: [...deps].sort().slice(0, LIST_CAP),
    frameworks: [...new Set(FRAMEWORKS.filter(([pkg]) => all.has(pkg)).map(([, name]) => name))],
    topDirs: counted(visible, (p) => (p.includes('/') ? p.split('/')[0]! : null), 12),
    modules: counted(visible, (p) => {
      const parts = p.split('/');
      return parts.length > 2 && ['src', 'app', 'lib', 'packages', 'apps'].includes(parts[0]!) ? `${parts[0]}/${parts[1]}` : null;
    }, 15),
    entryPoints: [...entry].map((e) => cleanLabel(e, 120)),
    envKeys: [...envKeys].sort().slice(0, LIST_CAP),
    outbound: [...outbound.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, LIST_CAP).map(([key, f]) => ({ key, files: [...f].slice(0, 5) })),
    hosts: [...hosts.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 50).map(([host, f]) => ({ host, files: [...f].slice(0, 5) })),
    routes: uniqueRoutes.slice(0, 400).map((r) => ({ method: r.method, path: cleanLabel(r.path, 160), file: r.file })),
    composeServices: [...compose].map((s) => cleanLabel(s, 60)).slice(0, 40),
    truncated,
  };
}

// ─── Reading the commit ───────────────────────────────────────────────────────

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

/** The production commit: origin/<branch> as last fetched, else the local branch. */
export function productionSha(repoPath: string, prodBranch: string): string {
  for (const ref of [`origin/${prodBranch}`, prodBranch]) {
    try { return git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); } catch { /* next */ }
  }
  throw new Error(`no commit for ${prodBranch} (neither origin/${prodBranch} nor a local branch)`);
}

/** Every path at the commit, with its size and blob id. */
export function listTree(repoPath: string, sha: string): Array<{ path: string; size: number; blob: string }> {
  const out = execFileSync('git', ['-C', repoPath, ...NO_HOOKS, 'ls-tree', '-r', '-z', '--long', sha], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\0').filter(Boolean).flatMap((entry) => {
    const tab = entry.indexOf('\t');
    const [, type, blob, size] = entry.slice(0, tab).split(/\s+/);
    const file = entry.slice(tab + 1);
    return type === 'blob' && !file.includes('\n') ? [{ path: file, size: Number(size) || 0, blob: blob! }] : [];
  });
}

/** The contents of `paths` at `sha`, in one `git cat-file --batch`. */
export function readBlobs(repoPath: string, sha: string, paths: string[]): Promise<ScanFile[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...NO_HOOKS, 'cat-file', '--batch'], {
      env: { ...process.env, ...GIT_ENV }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`git cat-file failed: ${err.trim().slice(0, 200)}`)); return; }
      const buf = Buffer.concat(chunks);
      const files: ScanFile[] = [];
      let at = 0;
      for (const p of paths) {
        const nl = buf.indexOf(10, at);
        if (nl < 0) break;
        const header = buf.subarray(at, nl).toString();
        at = nl + 1;
        const m = header.match(/^\S+ (\w+) (\d+)$/);
        if (!m) continue;
        const size = Number(m[2]);
        if (m[1] === 'blob') files.push({ path: p, text: buf.subarray(at, at + size).toString('utf8') });
        at += size + 1;
      }
      resolve(files);
    });
    child.stdin.end(paths.map((p) => `${sha}:${p}\n`).join(''));
  });
}

/** Scan a project's production commit. Throws when the commit cannot be read. */
export async function scanRepository(repoPath: string, sha: string): Promise<ScanFacts> {
  const tree = listTree(repoPath, sha);
  const sizes = new Map(tree.map((t) => [t.path, t.size]));
  const picked = pickFiles(tree.map((t) => t.path));
  let total = 0;
  let truncated = picked.truncated;
  const toRead = picked.files.filter((p) => {
    const size = sizes.get(p) ?? 0;
    if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) { truncated = true; return false; }
    total += size;
    return true;
  });
  const files = toRead.length ? await readBlobs(repoPath, sha, toRead) : [];
  return extractFacts(sha, tree.map((t) => t.path), files, truncated);
}
