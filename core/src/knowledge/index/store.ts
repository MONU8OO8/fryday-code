/**
 * The code index: every project's production code cut into pieces (chunk.ts), searchable by
 * keyword (SQLite FTS5, BM25) and by meaning (sqlite-vec, one vector per piece).
 *
 * It lives in its own file beside the main database (<FRYDAY_HOME>/index.db), so a large index
 * never slows the database the rest of core uses, and it can be thrown away and rebuilt.
 *
 * Pieces are stored per git blob: a file that did not change between commits, or appears in two
 * tasks, is cut and embedded once. Which blob each path holds is kept per project (the
 * production commit) and per task (files the task changed), and a search only sees those.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { getConfig } from '../../config.js';

export const VECTOR_DIMS = 384;

let db: Database.Database | null = null;
let vectors = false;

export function indexPath(): string {
  return process.env['FRYDAY_INDEX_DB'] ?? path.join(getConfig().home, 'index.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS blobs (
  blob_sha TEXT PRIMARY KEY,
  indexed_at INTEGER NOT NULL,
  embedded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  blob_sha TEXT NOT NULL REFERENCES blobs(blob_sha) ON DELETE CASCADE,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  kind TEXT NOT NULL,
  symbol TEXT,
  text TEXT NOT NULL,
  tokens INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_blob ON chunks(blob_sha);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(symbol, text, path, tokenize = "unicode61 tokenchars '_'");
CREATE TABLE IF NOT EXISTS files (
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);
CREATE INDEX IF NOT EXISTS files_blob ON files(blob_sha);
CREATE TABLE IF NOT EXISTS task_files (
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_sha TEXT,
  PRIMARY KEY (task_id, path)
);
CREATE TABLE IF NOT EXISTS blob_imports (
  blob_sha TEXT NOT NULL REFERENCES blobs(blob_sha) ON DELETE CASCADE,
  spec TEXT NOT NULL,
  PRIMARY KEY (blob_sha, spec)
);
CREATE TABLE IF NOT EXISTS imports (
  project_id TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  PRIMARY KEY (project_id, from_path, to_path)
);
CREATE TABLE IF NOT EXISTS index_state (
  project_id TEXT PRIMARY KEY,
  sha TEXT,
  indexed_at INTEGER NOT NULL,
  files INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS memory (
  task_id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  outcome TEXT,
  at INTEGER NOT NULL,
  embedded INTEGER NOT NULL DEFAULT 0
);
`;

/** The index database, opened on first use. Vectors work only when sqlite-vec loads. */
export function indexDb(): Database.Database {
  if (db) return db;
  const file = indexPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  try {
    // A native extension from the package FryDay installed, never from a repository.
    sqliteVec.load(db);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding float[${VECTOR_DIMS}]);
             CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[${VECTOR_DIMS}]);`);
    vectors = true;
  } catch (err) {
    vectors = false;
    console.warn(`[fryday-core] code search by meaning is off: sqlite-vec did not load (${err instanceof Error ? err.message : String(err)})`);
  }
  return db;
}

/** Whether vector search is available in this install. */
export function hasVectors(): boolean {
  indexDb();
  return vectors;
}

/** For tests: close and forget the index, so the next use opens FRYDAY_INDEX_DB afresh. */
export function closeIndex(): void {
  db?.close();
  db = null;
  vectors = false;
}
