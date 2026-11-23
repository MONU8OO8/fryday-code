/**
 * Keeping the code index up to date.
 *
 *   indexProject     the project's production commit, read from git's object store like the
 *                    scan (nothing checked out, nothing run, a real .env never opened). Only
 *                    blobs not seen before are read and cut, so a new commit costs what changed.
 *   indexTaskFiles   the files a task changed, from its worktree, seen only by that task.
 *   embedPending     vectors for pieces that have none yet, in the background, a few at a time,
 *                    only while the machine has room.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { nowMs } from '../../db/db.js';
import { getRepo } from '../../registry/registry.js';
import { redactSecrets } from '../../secretPatterns.js';
import { admission } from '../../system/health.js';
import { isRealEnvFile, listTree, productionSha, readBlobs, skipped, MAX_FILES, MAX_TOTAL_BYTES } from '../scan.js';
import { chunkFile, importSpecs, indexable, resolveImport } from './chunk.js';
import { hasVectors, indexDb } from './store.js';
import { embedPassages, embeddingsWanted } from './embed.js';
import { embedMemory } from './memory.js';

export interface IndexState { projectId: string; sha: string | null; files: number; chunks: number; error: string | null; indexedAt: number }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** git's blob id for some content: the same id `git hash-object` gives, without running git. */
export function blobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

export function indexState(projectId: string): IndexState | null {
  const r = indexDb().prepare('SELECT * FROM index_state WHERE project_id = ?').get(projectId) as
    { project_id: string; sha: string | null; files: number; chunks: number; error: string | null; indexed_at: number } | undefined;
  return r ? { projectId: r.project_id, sha: r.sha, files: r.files, chunks: r.chunks, error: r.error, indexedAt: r.indexed_at } : null;
}

const known = (blobs: string[]): Set<string> => {
  const out = new Set<string>();
  const db = indexDb();
  for (let i = 0; i < blobs.length; i += 500) {
    const part = blobs.slice(i, i + 500);
    for (const r of db.prepare(`SELECT blob_sha FROM blobs WHERE blob_sha IN (${part.map(() => '?').join(',')})`).all(...part) as Array<{ blob_sha: string }>) out.add(r.blob_sha);
  }
  return out;
};

/** Cut one file's content and keep its pieces and its imports. A blob already kept is left alone. */
function storeBlob(blob: string, filePath: string, text: string): number {
  const db = indexDb();
  if (db.prepare('SELECT 1 FROM blobs WHERE blob_sha = ?').get(blob)) return 0;
  const chunks = chunkFile(filePath, text);
  const insertChunk = db.prepare('INSERT INTO chunks (blob_sha, start_line, end_line, kind, symbol, text, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, symbol, text, path) VALUES (?, ?, ?, ?)');
  const insertSpec = db.prepare('INSERT OR IGNORE INTO blob_imports (blob_sha, spec) VALUES (?, ?)');
  db.prepare('INSERT INTO blobs (blob_sha, indexed_at, embedded) VALUES (?, ?, 0)').run(blob, nowMs());
  for (const c of chunks) {
    const safe = redactSecrets(c.text);
    const id = Number(insertChunk.run(blob, c.startLine, c.endLine, c.kind, c.symbol, safe, c.tokens).lastInsertRowid);
    insertFts.run(id, c.symbol ?? '', safe, filePath);
  }
  for (const spec of importSpecs(text)) insertSpec.run(blob, spec);
  return chunks.length;
}

/** Resolve each file's relative imports against the files the project (or task) has. */
function rebuildImports(projectId: string): void {
  const db = indexDb();
  const files = db.prepare('SELECT path, blob_sha FROM files WHERE project_id = ?').all(projectId) as Array<{ path: string; blob_sha: string }>;
  const set = new Set(files.map((f) => f.path));
  const specs = db.prepare('SELECT spec FROM blob_imports WHERE blob_sha = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO imports (project_id, from_path, to_path) VALUES (?, ?, ?)');
  db.prepare('DELETE FROM imports WHERE project_id = ?').run(projectId);
  for (const f of files) {
    for (const { spec } of specs.all(f.blob_sha) as Array<{ spec: string }>) {
      const to = resolveImport(f.path, spec, set);
      if (to) insert.run(projectId, f.path, to);
    }
  }
}

/** Blobs no project and no task points at any more. */
function collectGarbage(): void {
  const db = indexDb();
  const dead = db.prepare(`
    SELECT b.blob_sha FROM blobs b
    WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.blob_sha = b.blob_sha)
      AND NOT EXISTS (SELECT 1 FROM task_files t WHERE t.blob_sha = b.blob_sha)
  `).all() as Array<{ blob_sha: string }>;
  if (dead.length === 0) return;
  const vectors = hasVectors();
  const chunkIds = db.prepare('SELECT id FROM chunks WHERE blob_sha = ?');
  const delFts = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
  const delVec = vectors ? db.prepare('DELETE FROM chunk_vec WHERE rowid = ?') : null;
  db.transaction(() => {
    for (const { blob_sha } of dead) {
      for (const { id } of chunkIds.all(blob_sha) as Array<{ id: number }>) { delFts.run(id); delVec?.run(BigInt(id)); }
      db.prepare('DELETE FROM blobs WHERE blob_sha = ?').run(blob_sha);
    }
  })();
}

const running = new Map<string, Promise<IndexState | null>>();

/** Index a project's production commit; nothing to do when it is the commit already indexed. */
export function indexProject(projectId: string, opts: { force?: boolean } = {}): Promise<IndexState | null> {
  const going = running.get(projectId);
  if (going) return going;
  const job = (async () => {
    const project = getRepo(projectId);
    if (!project) return null;
    const db = indexDb();
    const record = (sha: string | null, files: number, chunks: number, error: string | null) => {
      db.prepare(`INSERT INTO index_state (project_id, sha, indexed_at, files, chunks, error) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET sha = excluded.sha, indexed_at = excluded.indexed_at, files = excluded.files, chunks = excluded.chunks, error = excluded.error`)
        .run(projectId, sha, nowMs(), files, chunks, error);
      return indexState(projectId);
    };
    let sha: string;
    try {
      sha = productionSha(project.localPath, project.prodBranch);
    } catch (err) {
      return record(null, 0, 0, message(err).slice(0, 300));
    }
    const last = indexState(projectId);
    if (!opts.force && last?.sha === sha && !last.error) return last;
    try {
      const tree = listTree(project.localPath, sha)
        .filter((t) => !skipped(t.path) && !isRealEnvFile(t.path) && indexable(t.path, t.size));
      let total = 0;
      const picked = tree.slice(0, MAX_FILES).filter((t) => (total += t.size) <= MAX_TOTAL_BYTES);
      const have = known(picked.map((t) => t.blob));
      const toRead = picked.filter((t) => !have.has(t.blob));
      for (let i = 0; i < toRead.length; i += 300) {
        const part = toRead.slice(i, i + 300);
        const read = await readBlobs(project.localPath, sha, part.map((t) => t.path));
        const byPath = new Map(part.map((t) => [t.path, t.blob]));
        db.transaction(() => { for (const f of read) storeBlob(byPath.get(f.path)!, f.path, f.text); })();
        await new Promise((r) => setImmediate(r));
      }
      db.transaction(() => {
        db.prepare('DELETE FROM files WHERE project_id = ?').run(projectId);
        const insert = db.prepare('INSERT INTO files (project_id, path, blob_sha) VALUES (?, ?, ?)');
        for (const t of picked) insert.run(projectId, t.path, t.blob);
      })();
      rebuildImports(projectId);
      collectGarbage();
      const chunks = (db.prepare('SELECT COUNT(*) AS n FROM chunks c JOIN files f ON f.blob_sha = c.blob_sha WHERE f.project_id = ?').get(projectId) as { n: number }).n;
      const state = record(sha, picked.length, chunks, null);
      kickEmbedding();
      return state;
    } catch (err) {
      return record(sha, 0, 0, `The index could not read ${project.prodBranch}: ${message(err).slice(0, 300)}`);
    }
  })().finally(() => running.delete(projectId));
  running.set(projectId, job);
  return job;
}

/**
 * Put a task's changed files in the index, seen only by that task: what the Builder wrote is
 * found by later searches on the task. A deleted file hides the production one.
 */
export function indexTaskFiles(taskId: string, projectId: string, worktreePath: string, changed: string[]): void {
  const db = indexDb();
  const root = path.resolve(worktreePath);
  db.transaction(() => {
    db.prepare('DELETE FROM task_files WHERE task_id = ?').run(taskId);
    const insert = db.prepare('INSERT OR REPLACE INTO task_files (task_id, project_id, path, blob_sha) VALUES (?, ?, ?, ?)');
    for (const rel of changed.slice(0, 500)) {
      if (skipped(rel) || isRealEnvFile(rel)) continue;
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root + path.sep)) continue;
      let content: Buffer;
      try {
        const st = fs.lstatSync(abs);
        if (!st.isFile()) { insert.run(taskId, projectId, rel, null); continue; }
        if (!indexable(rel, st.size)) continue;
        content = fs.readFileSync(abs);
      } catch {
        insert.run(taskId, projectId, rel, null); // deleted by the task
        continue;
      }
      const blob = blobId(content);
      storeBlob(blob, rel, content.toString('utf8'));
      insert.run(taskId, projectId, rel, blob);
    }
  })();
  kickEmbedding();
}

/** A finished task's own files are no longer needed in the index. */
export function forgetTaskFiles(taskId: string): void {
  indexDb().prepare('DELETE FROM task_files WHERE task_id = ?').run(taskId);
}

// ─── Vectors in the background ────────────────────────────────────────────────

let embedding: Promise<number> | null = null;
const BATCH_BLOBS = 8;

/** Start the background embedding loop if it is not running. Never throws. */
export function kickEmbedding(): void {
  if (!embeddingsWanted() || !hasVectors()) return;
  void embedPending().catch((err) => { console.warn(`[fryday-core] embedding stopped: ${message(err)}`); return 0; });
}

/**
 * Embed pieces that have no vector yet; resolves with how many got one. One loop at a time:
 * a call while it runs waits for that loop.
 */
export function embedPending(): Promise<number> {
  embedding ??= embedLoop().finally(() => { embedding = null; });
  return embedding;
}

async function embedLoop(maxBlobs = Number.POSITIVE_INFINITY): Promise<number> {
  const db = indexDb();
  let done = 0;
  let blobsDone = 0;
  const pick = db.prepare(`SELECT blob_sha FROM blobs WHERE embedded = 0 LIMIT ${BATCH_BLOBS}`);
  const chunksOf = db.prepare('SELECT c.id, c.symbol, c.text FROM chunks c WHERE c.blob_sha = ?');
  const pathOf = db.prepare('SELECT path FROM files WHERE blob_sha = ? UNION SELECT path FROM task_files WHERE blob_sha = ? LIMIT 1');
  // vec0 has no INSERT OR REPLACE: a vector left by an interrupted run is removed first.
  const dropVec = db.prepare('DELETE FROM chunk_vec WHERE rowid = ?');
  const insertVec = db.prepare('INSERT INTO chunk_vec (rowid, embedding) VALUES (?, ?)');
  const mark = db.prepare('UPDATE blobs SET embedded = 1 WHERE blob_sha = ?');
  while (blobsDone < maxBlobs) {
    if (!admission().ok) { await new Promise((r) => setTimeout(r, 30_000)); continue; }
    const blobs = pick.all() as Array<{ blob_sha: string }>;
    if (blobs.length === 0) { done += await embedMemory(); break; }
    for (const { blob_sha } of blobs) {
      const chunks = chunksOf.all(blob_sha) as Array<{ id: number; symbol: string | null; text: string }>;
      const where = (pathOf.get(blob_sha, blob_sha) as { path: string } | undefined)?.path ?? '';
      const vectors = chunks.length ? await embedPassages(chunks.map((c) => `${where}${c.symbol ? ` ${c.symbol}` : ''}\n${c.text}`)) : [];
      if (vectors === null) return done; // switched off, or the model is not available
      db.transaction(() => {
        chunks.forEach((c, i) => { dropVec.run(BigInt(c.id)); insertVec.run(BigInt(c.id), vectors[i]!); });
        mark.run(blob_sha);
      })();
      done += chunks.length;
      blobsDone++;
      await new Promise((r) => setImmediate(r));
    }
  }
  return done;
}
