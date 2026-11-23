import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB not initialized — call initDb() first');
  return _db;
}

export function initDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run the schema file as a whole: SQLite parses it properly, so a semicolon inside a
  // comment cannot split a statement (splitting on ';' by hand once did exactly that).
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  migrate(db);

  _db = db;
  return db;
}

/** Bring a database created by an earlier version up to the current schema. */
function migrate(db: Database.Database): void {
  const addColumn = (table: string, column: string, definition: string): void => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  addColumn('runs', 'log_offset', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('runs', 'result_text', 'TEXT');
  addColumn('runs', 'output_json', 'TEXT');
  addColumn('task_workspaces', 'baseline_json', 'TEXT');
  addColumn('runs', 'deadline_at', 'INTEGER');
  addColumn('runs', 'budget_usd', 'REAL');
  addColumn('tasks', 'brief_json', 'TEXT');
  addColumn('task_workspaces', 'target_branch', 'TEXT');
  addColumn('task_workspaces', 'fork_sha', 'TEXT');
  addColumn('task_workspaces', 'target_owned', 'INTEGER');
  addColumn('task_workspaces', 'pushed_ref', 'TEXT');
  addColumn('task_workspaces', 'pushed_sha', 'TEXT');
  addColumn('runs', 'tools_json', 'TEXT');
  addColumn('task_rounds', 'verify_json', 'TEXT');
  addColumn('runs', 'engine', "TEXT NOT NULL DEFAULT 'claude'");
  addColumn('runs', 'wants_json', 'INTEGER');
  addColumn('runs', 'token_limit', 'INTEGER');
  addColumn('tasks', 'parent_id', 'TEXT');
  addColumn('tasks', 'priority', "TEXT NOT NULL DEFAULT 'p2' CHECK (priority IN ('p0', 'p1', 'p2', 'p3'))");
  addColumn('tasks', 'kind', "TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'initiative'))");
  addColumn('tasks', 'auto_start', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('tasks', 'position', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('task_rounds', 'self_check_json', 'TEXT');
  addColumn('tasks', 'origin', "TEXT NOT NULL DEFAULT 'owner'");
  db.exec('CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id)');
  // A follow-up started before v2 kept its link in metadata; it becomes a link row once.
  const followUps = db.prepare(`SELECT id, json_extract(metadata_json, '$.followUpOf') AS of FROM tasks WHERE json_extract(metadata_json, '$.followUpOf') IS NOT NULL`).all() as Array<{ id: string; of: string }>;
  const link = db.prepare(`INSERT OR IGNORE INTO task_dependencies (task_id, depends_on, gate, created_at) SELECT ?, ?, 'link', ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?)`);
  for (const f of followUps) if (f.of !== f.id) link.run(f.id, f.of, Date.now(), f.of);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function nowMs(): number {
  return Date.now();
}
