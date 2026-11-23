/**
 * Cutting a file into pieces an agent can be shown on their own: one function, class or
 * method where the language makes that easy to see, else a window of lines. Each piece
 * keeps its line numbers and the name of what it holds, so a pack of pieces can say
 * "price.js:12-30 applyDiscount" and the agent can open the file there if it needs more.
 *
 * No parser: brace depth for C-like languages, indentation for Python, headings for
 * Markdown. Strings and comments are skipped well enough for this; a piece that comes out
 * a little long is still a useful piece.
 */

export interface Chunk {
  startLine: number;
  endLine: number;
  kind: 'symbol' | 'header' | 'window' | 'section';
  symbol: string | null;
  text: string;
  tokens: number;
}

export type Lang = 'brace' | 'python' | 'markdown' | 'text';

const MAX_LINES = 120;
const WINDOW = 60;
const OVERLAP = 10;
const HEADER_MAX = 40;

/** About 4 characters a token for code: the one estimate the index and its packs use. */
export const tokensOf = (text: string): number => Math.ceil(text.length / 4);

export function langOf(path: string): Lang | null {
  const base = path.split('/').pop()!.toLowerCase();
  if (/\.(ts|tsx|js|jsx|mjs|cjs|java|kt|kts|go|cs|rs|swift|scala|php|c|cc|cpp|h|hpp|vue|svelte|dart)$/.test(base)) return 'brace';
  if (/\.py$/.test(base)) return 'python';
  if (/\.(md|mdx)$/.test(base)) return 'markdown';
  if (/\.(sql|graphql|gql|prisma|proto|ya?ml|toml|rb|sh|html|css|scss)$/.test(base) || base === 'dockerfile') return 'text';
  return null;
}

/** Files never worth indexing even when their language is known. */
export function indexable(path: string, size: number): boolean {
  const base = path.split('/').pop()!.toLowerCase();
  if (size === 0 || size > 256 * 1024) return false;
  if (/(^|[.-])lock(\.|$)|^package-lock\.json$|^yarn\.lock$|^pnpm-lock\.ya?ml$|\.lock$/.test(base)) return false;
  if (/\.(min|bundle)\.(js|css)$|\.map$|\.d\.ts$|\.snap$/.test(base)) return false;
  return langOf(path) !== null;
}

const DECL_BRACE = /^(export\s+)?(default\s+)?(async\s+)?(function\*?|class|interface|type|enum|abstract\s+class|const|let|var|public|private|protected|static|func|fn|pub|impl|struct|trait|module|namespace|@\w+|describe\(|it\(|test\(|def\s|object\s|override\s|suspend\s|data\s+class|sealed\s|open\s+class)/;
const NAME = /(?:function\*?|class|interface|type|enum|const|let|var|func|fn|struct|trait|impl|def|namespace|module|object)\s+([A-Za-z_$][\w$]*)/;
const METHOD_NAME = /^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

function nameOf(line: string): string | null {
  const m = line.match(NAME) ?? line.match(METHOD_NAME);
  return m?.[1] && !/^(if|for|while|switch|catch|return|function)$/.test(m[1]) ? m[1] : null;
}

/** Brace depth change of one line, ignoring braces inside strings and comments. */
function braceDelta(line: string, state: { block: boolean }): number {
  let d = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const n = line[i + 1];
    if (state.block) { if (c === '*' && n === '/') { state.block = false; i++; } continue; }
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '/' && n === '/') break;
    if (c === '/' && n === '*') { state.block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') d++;
    else if (c === '}') d--;
  }
  return d;
}

function piece(lines: string[], start: number, end: number, kind: Chunk['kind'], symbol: string | null): Chunk {
  const text = lines.slice(start, end + 1).join('\n');
  return { startLine: start + 1, endLine: end + 1, kind, symbol, text, tokens: tokensOf(text) };
}

/** A long piece becomes overlapping windows, each keeping the piece's name. */
function bounded(c: Chunk, lines: string[]): Chunk[] {
  if (c.endLine - c.startLine + 1 <= MAX_LINES) return [c];
  const out: Chunk[] = [];
  for (let s = c.startLine - 1; s <= c.endLine - 1; s += WINDOW - OVERLAP) {
    const e = Math.min(s + WINDOW - 1, c.endLine - 1);
    out.push(piece(lines, s, e, c.kind, c.symbol));
    if (e === c.endLine - 1) break;
  }
  return out;
}

function windows(lines: string[]): Chunk[] {
  const out: Chunk[] = [];
  for (let s = 0; s < lines.length; s += WINDOW - OVERLAP) {
    const e = Math.min(s + WINDOW - 1, lines.length - 1);
    out.push(piece(lines, s, e, 'window', null));
    if (e === lines.length - 1) break;
  }
  return out;
}

function braceChunks(lines: string[]): Chunk[] {
  const out: Chunk[] = [];
  const state = { block: false };
  let depth = 0;
  let header: [number, number] | null = null;
  let open: { start: number; symbol: string | null } | null = null;
  const flushHeader = () => {
    if (header) out.push(piece(lines, header[0], header[1], 'header', null));
    header = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const before = depth;
    depth = Math.max(0, depth + braceDelta(line, state));
    if (before === 0 && open === null) {
      if (trimmed === '' && header === null) continue;
      if (DECL_BRACE.test(trimmed) && (depth > 0 || /[{(=]\s*$/.test(trimmed) || /=>/.test(trimmed))) {
        flushHeader();
        open = { start: i, symbol: nameOf(trimmed) };
        if (depth === 0 && !/[{(,=]\s*$/.test(trimmed) && !/=>\s*$/.test(trimmed)) { out.push(piece(lines, i, i, 'symbol', open.symbol)); open = null; }
        continue;
      }
      if (trimmed !== '') {
        header = header ? [header[0], i] : [i, i];
        if (header[1] - header[0] + 1 >= HEADER_MAX) flushHeader();
      }
      continue;
    }
    if (open && depth === 0 && (before > 0 || /[;)}\]]\s*$/.test(trimmed))) {
      out.push(...bounded(piece(lines, open.start, i, 'symbol', open.symbol), lines));
      open = null;
    }
  }
  if (open) out.push(...bounded(piece(lines, open.start, lines.length - 1, 'symbol', open.symbol), lines));
  flushHeader();
  return out.length ? out : windows(lines);
}

function pythonChunks(lines: string[]): Chunk[] {
  const out: Chunk[] = [];
  let start = 0;
  let symbol: string | null = null;
  let kind: Chunk['kind'] = 'header';
  const close = (end: number) => {
    let e = end;
    while (e > start && lines[e]!.trim() === '') e--;
    if (e >= start && lines.slice(start, e + 1).some((l) => l.trim() !== '')) out.push(...bounded(piece(lines, start, e, kind, symbol), lines));
  };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
    const decorator = /^@\w/.test(lines[i]!);
    const afterDecorator = i > 0 && /^@\w/.test(lines[i - 1]!);
    if ((m || decorator) && !afterDecorator) {
      if (i > start) close(i - 1);
      start = i;
      kind = 'symbol';
      let j = i;
      while (j < lines.length && /^@\w/.test(lines[j]!)) j++;
      symbol = lines[j]?.match(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/)?.[1] ?? null;
    }
  }
  close(lines.length - 1);
  return out.length ? out : windows(lines);
}

function markdownChunks(lines: string[]): Chunk[] {
  const out: Chunk[] = [];
  let start = 0;
  let title: string | null = null;
  for (let i = 0; i <= lines.length; i++) {
    const heading = i < lines.length ? lines[i]!.match(/^#{1,3}\s+(.+)/) : null;
    if (heading || i === lines.length) {
      if (i > start && lines.slice(start, i).some((l) => l.trim())) out.push(...bounded(piece(lines, start, i - 1, 'section', title), lines));
      start = i;
      title = heading?.[1]?.trim().slice(0, 80) ?? null;
    }
  }
  return out;
}

/** Neighbouring pieces of a few lines each read better, and search better, as one. */
function mergeSmall(chunks: Chunk[], lines: string[]): Chunk[] {
  const out: Chunk[] = [];
  const small = (c: Chunk) => c.endLine - c.startLine + 1 < 8;
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && small(c) && (small(last) || last.kind === 'header') && c.startLine - last.endLine <= 3 && c.endLine - last.startLine + 1 <= HEADER_MAX) {
      const names = [last.symbol, c.symbol].filter(Boolean).join(', ');
      out[out.length - 1] = piece(lines, last.startLine - 1, c.endLine - 1, last.kind === 'symbol' || c.kind === 'symbol' ? 'symbol' : last.kind, names ? names.slice(0, 80) : null);
    } else {
      out.push(c);
    }
  }
  return out;
}

export function chunkFile(path: string, text: string): Chunk[] {
  const lang = langOf(path);
  if (!lang || text.includes('\u0000')) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return [];
  const chunks = lang === 'brace' ? braceChunks(lines) : lang === 'python' ? pythonChunks(lines) : lang === 'markdown' ? markdownChunks(lines) : windows(lines);
  return mergeSmall(chunks.filter((c) => c.text.trim().length > 0), lines);
}

// ─── Imports, for "one hop away" ──────────────────────────────────────────────

const IMPORT_RES = [
  /\bimport\s+(?:[^'"`;]*?\sfrom\s+)?['"`](\.{1,2}\/[^'"`]+)['"`]/g,
  /\brequire\(\s*['"`](\.{1,2}\/[^'"`]+)['"`]\s*\)/g,
  /\bexport\s+[^'"`;]*?\sfrom\s+['"`](\.{1,2}\/[^'"`]+)['"`]/g,
  /^\s*from\s+(\.+[\w.]*)\s+import\b/gm,
];
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '.py', '/__init__.py'];

function resolve(from: string, spec: string, files: Set<string>): string | null {
  const dir = from.split('/').slice(0, -1);
  let rel = spec;
  if (/^\.+[\w.]*$/.test(spec) && !spec.includes('/')) {
    // Python: ".mod" or "..pkg.mod"
    const dots = spec.match(/^\.+/)![0].length;
    rel = `${'../'.repeat(dots - 1) || './'}${spec.slice(dots).replace(/\./g, '/')}`;
  }
  const parts = [...dir];
  for (const seg of rel.replace(/\.js$/, '').split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const base = parts.join('/');
  for (const ext of EXTS) if (files.has(base + ext)) return base + ext;
  if (files.has(`${base}.js`.replace(/\.js$/, '.ts'))) return `${base}.ts`;
  return null;
}

/** The relative import specifiers in a file ("./price", "..utils"), unresolved. */
export function importSpecs(text: string): string[] {
  const out = new Set<string>();
  for (const re of IMPORT_RES) for (const m of text.matchAll(re)) out.add(m[1]!);
  return [...out].slice(0, 200);
}

/** The project file a relative import in `from` points at, or null. */
export function resolveImport(from: string, spec: string, files: Set<string>): string | null {
  const target = resolve(from, spec, files);
  return target && target !== from ? target : null;
}

/** The project files a file imports with a relative path. */
export function importsOf(path: string, text: string, files: Set<string>): string[] {
  return [...new Set(importSpecs(text).map((s) => resolveImport(path, s, files)).filter((t): t is string => t !== null))];
}
