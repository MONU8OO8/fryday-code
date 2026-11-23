/**
 * Finding the code a task is about, and packing it into a token budget.
 *
 *   1. candidates   BM25 over the pieces (FTS5) and, when available, nearest vectors
 *   2. merge        Reciprocal Rank Fusion: score = Σ 1 / (60 + rank) over both lists
 *   3. boost        pieces of files the plan names or the task changed, and the files they
 *                   import or are imported by, count for more
 *   4. diversity    Maximal Marginal Relevance (λ 0.7), so one file cannot fill the pack
 *   5. pack         best first into the budget; neighbouring pieces of a file become one block
 *
 * Only files the project's production commit has, as the task changed them, are searched.
 * Search never throws: with no index or no model it returns less, or nothing.
 */

import { hasVectors, indexDb } from './store.js';
import { embedQuery } from './embed.js';
import { tokensOf } from './chunk.js';

export interface Piece {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
  text: string;
  tokens: number;
  score: number;
}

export interface SearchOptions {
  projectId: string;
  taskId?: string | null;
  query: string;
  /** Token budget for what is returned. */
  budget: number;
  /** Files that matter more: named in the plan, or changed by the task. */
  boostPaths?: string[];
  /** At most this many pieces. */
  maxPieces?: number;
}

export interface SearchResult { pieces: Piece[]; tokens: number; byMeaning: boolean }

const RRF_K = 60;
const LAMBDA = 0.7;
const CANDIDATES = 50;

const STOP = new Set(['fix', 'fixed', 'bug', 'please', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'than', 'are', 'was', 'were', 'has', 'have', 'not', 'but', 'its', 'can', 'should', 'must', 'will', 'add', 'make', 'use', 'new', 'all', 'any', 'each', 'what', 'which', 'only', 'also', 'returns', 'return', 'true', 'false', 'null', 'undefined', 'test', 'tests', 'task', 'file', 'files', 'code', 'change', 'existing', 'still', 'their', 'there', 'they', 'them', 'does', 'done']);

/** Words of a query, with identifiers split as well as kept whole: "applyDiscount" → applydiscount, apply, discount. */
export function queryTerms(text: string, max = 24): string[] {
  const out = new Map<string, number>();
  const bump = (w: string, n: number) => { if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.set(w, (out.get(w) ?? 0) + n); };
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    // A name written the way code writes it (camelCase, snake_case) says more than a plain word.
    bump(raw.toLowerCase(), /[a-z][A-Z]|_/.test(raw) ? 3 : 2);
    for (const part of raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[_\s]+/)) if (part.toLowerCase() !== raw.toLowerCase()) bump(part.toLowerCase(), 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

const ftsQuery = (terms: string[]) => terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ');

/** The files a search may see: the production files, as the task changed them. */
function fileSet(projectId: string, taskId: string | null): { sql: string; params: string[] } {
  if (!taskId) return { sql: 'SELECT path, blob_sha FROM files WHERE project_id = ?', params: [projectId] };
  return {
    sql: `SELECT path, blob_sha FROM files WHERE project_id = ? AND path NOT IN (SELECT path FROM task_files WHERE task_id = ?)
          UNION ALL SELECT path, blob_sha FROM task_files WHERE task_id = ? AND blob_sha IS NOT NULL`,
    params: [projectId, taskId, taskId],
  };
}

type Row = { id: number; path: string; start_line: number; end_line: number; symbol: string | null; text: string; tokens: number };
const toPiece = (r: Row, score = 0): Piece => ({ id: r.id, path: r.path, startLine: r.start_line, endLine: r.end_line, symbol: r.symbol, text: r.text, tokens: r.tokens, score });

function keywordHits(projectId: string, taskId: string | null, terms: string[]): Row[] {
  if (terms.length === 0) return [];
  const fs = fileSet(projectId, taskId);
  return indexDb().prepare(`
    WITH fs AS (${fs.sql})
    SELECT c.id, fs.path, c.start_line, c.end_line, c.symbol, c.text, c.tokens
    FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN fs ON fs.blob_sha = c.blob_sha
    WHERE chunks_fts MATCH ?
    ORDER BY bm25(chunks_fts, 4.0, 1.0, 2.0)
    LIMIT ${CANDIDATES * 2}
  `).all(...fs.params, ftsQuery(terms)) as Row[];
}

async function meaningHits(projectId: string, taskId: string | null, query: string): Promise<Row[] | null> {
  if (!hasVectors()) return null;
  const vector = await embedQuery(query);
  if (!vector) return null;
  const db = indexDb();
  const near = db.prepare(`SELECT rowid, distance FROM chunk_vec WHERE embedding MATCH ? AND k = 400 ORDER BY distance`).all(vector) as Array<{ rowid: number; distance: number }>;
  if (near.length === 0) return [];
  const fs = fileSet(projectId, taskId);
  const ids = near.map((n) => Number(n.rowid));
  const rows = db.prepare(`
    WITH fs AS (${fs.sql})
    SELECT c.id, fs.path, c.start_line, c.end_line, c.symbol, c.text, c.tokens
    FROM chunks c JOIN fs ON fs.blob_sha = c.blob_sha
    WHERE c.id IN (${ids.map(() => '?').join(',')})
  `).all(...fs.params, ...ids) as Row[];
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!).slice(0, CANDIDATES);
}

function boostSets(projectId: string, taskId: string | null, boostPaths: string[]): { direct: Set<string>; near: Set<string> } {
  const direct = new Set(boostPaths);
  const near = new Set<string>();
  if (direct.size === 0) return { direct, near };
  const list = [...direct];
  const marks = list.map(() => '?').join(',');
  const rows = indexDb().prepare(`SELECT from_path, to_path FROM imports WHERE project_id = ? AND (from_path IN (${marks}) OR to_path IN (${marks}))`)
    .all(projectId, ...list, ...list) as Array<{ from_path: string; to_path: string }>;
  for (const r of rows) { if (!direct.has(r.from_path)) near.add(r.from_path); if (!direct.has(r.to_path)) near.add(r.to_path); }
  void taskId;
  return { direct, near };
}

const identifiers = (text: string) => new Set((text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).map((w) => w.toLowerCase()));

function similarity(a: Piece & { ids: Set<string> }, b: Piece & { ids: Set<string> }): number {
  let shared = 0;
  for (const w of a.ids) if (b.ids.has(w)) shared++;
  const jaccard = shared / Math.max(1, a.ids.size + b.ids.size - shared);
  return a.path === b.path ? 0.5 + jaccard / 2 : jaccard;
}

/** Search the project for the query, and return the pieces that fit the budget. */
export async function search(opts: SearchOptions): Promise<SearchResult> {
  const taskId = opts.taskId ?? null;
  const empty: SearchResult = { pieces: [], tokens: 0, byMeaning: false };
  try {
    const terms = queryTerms(opts.query);
    const keyword = keywordHits(opts.projectId, taskId, terms);
    const meaning = await meaningHits(opts.projectId, taskId, opts.query).catch(() => null);
    const scores = new Map<number, Piece>();
    const fuse = (rows: Row[]) => rows.forEach((r, rank) => {
      const p = scores.get(r.id) ?? toPiece(r);
      p.score += 1 / (RRF_K + rank + 1);
      scores.set(r.id, p);
    });
    fuse(dedupe(keyword).slice(0, CANDIDATES));
    if (meaning) fuse(meaning);

    const { direct, near } = boostSets(opts.projectId, taskId, opts.boostPaths ?? []);
    const named = new Set(terms);
    for (const p of scores.values()) {
      if (direct.has(p.path)) p.score *= 1.5;
      else if (near.has(p.path)) p.score *= 1.2;
      if (p.symbol && named.has(p.symbol.toLowerCase())) p.score *= 1.2;
    }
    // A file the plan names is worth showing even when no word of the query is in it.
    if (direct.size) addNamedFiles(opts.projectId, taskId, direct, scores);
    if (scores.size === 0) return empty;

    const picked = mmr([...scores.values()], opts.maxPieces ?? 30);
    let left = opts.budget;
    const kept: Piece[] = [];
    for (const p of picked) {
      if (p.tokens > left) continue;
      kept.push(p);
      left -= p.tokens;
      if (left < 150) break;
    }
    return { pieces: kept, tokens: opts.budget - left, byMeaning: meaning !== null };
  } catch (err) {
    console.warn(`[fryday-core] code search failed: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
}

function dedupe(rows: Row[]): Row[] {
  const seen = new Set<number>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

function addNamedFiles(projectId: string, taskId: string | null, direct: Set<string>, scores: Map<number, Piece>): void {
  const fs = fileSet(projectId, taskId);
  const list = [...direct].slice(0, 20);
  const rows = indexDb().prepare(`
    WITH fs AS (${fs.sql})
    SELECT c.id, fs.path, c.start_line, c.end_line, c.symbol, c.text, c.tokens
    FROM chunks c JOIN fs ON fs.blob_sha = c.blob_sha
    WHERE fs.path IN (${list.map(() => '?').join(',')})
    ORDER BY fs.path, c.start_line
  `).all(...fs.params, ...list) as Row[];
  const floor = 1 / (RRF_K + CANDIDATES);
  for (const r of rows) if (!scores.has(r.id)) scores.set(r.id, toPiece(r, floor));
}

/** Maximal Marginal Relevance: each next piece is relevant and unlike the ones already chosen. */
export function mmr(pieces: Piece[], max: number, lambda = LAMBDA): Piece[] {
  const top = Math.max(...pieces.map((p) => p.score), 1e-9);
  const pool = pieces.map((p) => ({ ...p, ids: identifiers(`${p.symbol ?? ''} ${p.text}`) }));
  const chosen: typeof pool = [];
  while (pool.length && chosen.length < max) {
    let best = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i]!;
      const redundancy = chosen.length ? Math.max(...chosen.map((c) => similarity(p, c))) : 0;
      const value = lambda * (p.score / top) - (1 - lambda) * redundancy;
      if (value > bestValue) { bestValue = value; best = i; }
    }
    chosen.push(pool.splice(best, 1)[0]!);
  }
  return chosen.map(({ ids: _ids, ...p }) => p);
}

const fenceFor = (text: string) => (text.includes('```') ? '````' : '```');
const langTag = (path: string) => path.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';

/** Pieces as Markdown: one block per run of neighbouring pieces of a file, files in order of their best piece. */
export function renderPieces(pieces: Piece[]): string {
  const byFile = new Map<string, Piece[]>();
  for (const p of pieces) byFile.set(p.path, [...(byFile.get(p.path) ?? []), p]);
  const blocks: string[] = [];
  for (const [path, list] of byFile) {
    list.sort((a, b) => a.startLine - b.startLine);
    const runs: Piece[][] = [];
    for (const p of list) {
      const last = runs[runs.length - 1];
      if (last && p.startLine <= last[last.length - 1]!.endLine + 2) last.push(p);
      else runs.push([p]);
    }
    for (const run of runs) {
      // Overlapping windows share lines: keep each line once.
      const lines = new Map<number, string>();
      for (const p of run) p.text.split('\n').forEach((l, i) => { if (!lines.has(p.startLine + i)) lines.set(p.startLine + i, l); });
      const start = run[0]!.startLine;
      const end = Math.max(...run.map((p) => p.endLine));
      const text = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l).join('\n');
      const names = [...new Set(run.map((p) => p.symbol).filter(Boolean))].slice(0, 4).join(', ');
      const fence = fenceFor(text);
      blocks.push(`### ${path} (lines ${start}–${end})${names ? ` · ${names}` : ''}\n${fence}${langTag(path)}\n${text}\n${fence}`);
    }
  }
  return blocks.join('\n\n');
}

export const RELEVANT_LABEL = '## Relevant code';

/**
 * A "Relevant code" section for a prompt, or '' when the project is not indexed or nothing
 * matched. Says what it is, so the agent reads further only when it needs to.
 */
export async function relevantCode(opts: SearchOptions): Promise<string> {
  const found = await search(opts);
  if (found.pieces.length === 0) return '';
  const body = renderPieces(found.pieces);
  const how = found.byMeaning ? 'by keyword and by meaning' : 'by keyword';
  return `${RELEVANT_LABEL}\n\nFryDay searched this project ${how} for what this task is about and found these pieces (about ${tokensOf(body)} tokens). They are excerpts with their line numbers, so you need not search for them again. Open a file yourself only for what is not here.\n\n${body}`;
}
