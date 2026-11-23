-- Fryday core SQLite schema
-- Run once at startup via db.ts migrate()

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Projects (the repositories this install works on) ───────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  local_path    TEXT NOT NULL,            -- the developer's own clone; never modified
  remote_url    TEXT,
  prod_branch   TEXT NOT NULL,
  stg_branch    TEXT,
  test_cmd      TEXT,
  lint_cmd      TEXT,
  typecheck_cmd TEXT,
  install_cmd   TEXT,
  run_profile_json TEXT,                  -- how to start the service for testers
  deployer      TEXT,                     -- 'jenkins' | NULL (none)
  deployer_config_json TEXT,
  verified      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ─── Settings (what the developer changed from the defaults) ─────────────────
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ─── Tasks ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,          -- T-1, T-2, ...
  seq         INTEGER UNIQUE,            -- monotonic counter for id generation
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'queued',
  -- queued | intake | waiting_owner | planning | workspace | coding | testing | verifying | awaiting_approval | deploying
  -- | releasing | deployed | failed | needs_owner
  created_at  INTEGER NOT NULL,          -- unix ms
  updated_at  INTEGER NOT NULL,
  plan_json   TEXT,                      -- Planner output (repos, criteria, HLD)
  brief_json  TEXT,                      -- Analyst output (requirements, assumptions)
  metadata_json TEXT,                    -- arbitrary per-task KV
  parent_id   TEXT,                      -- the initiative this task is part of (null: a task of its own)
  priority    TEXT NOT NULL DEFAULT 'p2' CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
  kind        TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task', 'initiative')),
  auto_start  INTEGER NOT NULL DEFAULT 0, -- 1: the scheduler starts it when a slot is free and its dependencies are met
  position    INTEGER NOT NULL DEFAULT 0, -- order in the backlog (lower first)
  origin      TEXT NOT NULL DEFAULT 'owner' -- owner: asked for by the owner | bug: filed by core from what an agent found
);

CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at DESC);

-- ─── Task dependencies (one task waits for another) ──────────────────────────
-- start    task_id is not started until depends_on has passed its review
-- release  task_id is not merged into staging until depends_on is on staging
-- link     the two are related (a follow-up); nothing waits
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  depends_on TEXT NOT NULL REFERENCES tasks(id),
  gate       TEXT NOT NULL CHECK (gate IN ('start', 'release', 'link')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
);

CREATE INDEX IF NOT EXISTS task_dependencies_on ON task_dependencies(depends_on);

-- ─── Runs ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,          -- run-<uuid>
  task_id     TEXT REFERENCES tasks(id),
  role        TEXT NOT NULL,             -- fryday|analyst|planner|coder|tester|api_tester|ui_tester|system
  round       INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'running',
  -- running | completed | failed | killed | budget (stopped at its token limit) | timeout
  pid         INTEGER,
  session_id  TEXT,                      -- claude session_id from init event
  model       TEXT,
  log_path    TEXT NOT NULL,             -- <state folder>/runs/<id>.jsonl
  log_offset  INTEGER NOT NULL DEFAULT 0, -- bytes of log_path already processed
  result_text TEXT,                      -- the agent's final message
  output_json TEXT,                      -- structured output, when the run had a JSON schema
  deadline_at INTEGER,                   -- the run is stopped if it is still going at this time
  budget_usd  REAL,                      -- unused since version 12 (limits are in tokens); kept for old rows
  token_limit INTEGER,                   -- most tokens (input + output + cache writes) this run may use
  tools_json  TEXT,                      -- how many times the agent called each tool: { name: count }
  engine      TEXT NOT NULL DEFAULT 'claude', -- claude | cursor: which program ran the agent (runner/runners.ts)
  wants_json  INTEGER,                   -- 1 when the run was asked for an answer in a JSON schema
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  exit_code   INTEGER,
  error_msg   TEXT
);

CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS runs_state ON runs(state);

-- ─── Task workspaces (one git worktree per task and repo) ────────────────────
CREATE TABLE IF NOT EXISTS task_workspaces (
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  repo_id       TEXT NOT NULL,
  repo_path     TEXT NOT NULL,            -- the owner's working copy (never modified)
  worktree_path TEXT NOT NULL,
  branch        TEXT NOT NULL,
  base_ref      TEXT NOT NULL,            -- e.g. origin/main
  base_sha      TEXT NOT NULL,
  head_sha      TEXT,                     -- last commit core made on the branch
  files_json    TEXT,                     -- [{status, path}] changed since base_sha
  baseline_json TEXT,                     -- check results on base_sha, by check name (run once, on demand)
  target_branch TEXT,                     -- existing remote branch this task continues (null: a fresh branch from production)
  fork_sha      TEXT,                     -- where target_branch left production
  target_owned  INTEGER,                  -- 1 when every commit on target_branch is the owner's own
  pushed_ref    TEXT,                     -- remote branch the work was pushed to, once approved
  pushed_sha    TEXT,
  removed_at    INTEGER,                  -- set when the worktree and branch were discarded
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (task_id, repo_id)
);

-- ─── Review rounds (checks + flags + tester verdict after each coder round) ───
CREATE TABLE IF NOT EXISTS task_rounds (
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  round        INTEGER NOT NULL,
  head_sha     TEXT,
  checks_json  TEXT,                      -- CheckResult[]
  flags_json   TEXT,                      -- DiffFlag[]
  verdict_json TEXT,                      -- tester verdict, when the tester ran
  verify_json  TEXT,                      -- the running-service verification: service facts and each tester's report
  outcome      TEXT,                      -- passed | changes_requested | escalated
  feedback     TEXT,                      -- what was sent back to the coder
  self_check_json TEXT,                   -- the coder's self-check on each criterion and how it compared with the tester (review.ts)
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (task_id, round)
);

-- ─── Usage (token accounting) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_events (
  id               TEXT PRIMARY KEY,     -- deduplicate by message_id
  run_id           TEXT REFERENCES runs(id),
  task_id          TEXT REFERENCES tasks(id),
  message_id       TEXT,                 -- from claude stream event
  event_type       TEXT NOT NULL,        -- 'assistant'|'result'
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,
  recorded_at      INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS usage_msgid ON usage_events(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS usage_run ON usage_events(run_id);
CREATE INDEX IF NOT EXISTS usage_task ON usage_events(task_id);

-- ─── Approval tickets ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES tasks(id),
  run_id      TEXT REFERENCES runs(id),
  action      TEXT NOT NULL,             -- 'deploy_stg'|'push_branch'|'send_message'|...
  payload_json TEXT NOT NULL,            -- typed per action
  code        TEXT,                      -- one-time HMAC code (Chat approvals)
  commit_sha  TEXT,                      -- bound commit — a new commit voids this
  state       TEXT NOT NULL DEFAULT 'pending',
  -- pending | approved | rejected | expired | executed
  requested_at INTEGER NOT NULL,
  resolved_at  INTEGER,
  resolved_by  TEXT                      -- 'chat'|'ui'|owner_id
);

CREATE INDEX IF NOT EXISTS approvals_task ON approvals(task_id);
CREATE INDEX IF NOT EXISTS approvals_state ON approvals(state);

-- ─── Releases (a task branch merged into staging, and its revert) ─────────────
CREATE TABLE IF NOT EXISTS releases (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  repo_id        TEXT NOT NULL,
  approval_id    TEXT REFERENCES approvals(id),
  state          TEXT NOT NULL,           -- running | pushed | stopped | reverted
  outcome        TEXT,                    -- pushed | already_merged | conflict | checks_failed | stg_moved | stale | error | interrupted
  stg_branch     TEXT NOT NULL,
  head_sha       TEXT NOT NULL,           -- the approved commit
  strategy       TEXT,                    -- merge | twin
  stg_before_sha TEXT,
  merge_sha      TEXT,                    -- written BEFORE the push, so a restart can look for it on the remote
  twin_branch    TEXT,
  attempts       INTEGER,
  revert_sha     TEXT,
  detail         TEXT,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER
);

CREATE INDEX IF NOT EXISTS releases_task ON releases(task_id);

-- ─── Task thread (what was said and what happened, in order) ─────────────────
CREATE TABLE IF NOT EXISTS task_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  author     TEXT NOT NULL,              -- owner | fryday | analyst | planner | coder | tester
  kind       TEXT NOT NULL,              -- note | question | answer | event
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS task_messages_task ON task_messages(task_id, id);

-- ─── Questions to the owner ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_questions (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  kind         TEXT NOT NULL,            -- clarify | project | branch | split
  question     TEXT NOT NULL,
  why          TEXT,
  options_json TEXT,                     -- [{ value, label }]; empty for a free-text answer
  answer       TEXT,
  asked_by     TEXT NOT NULL,
  asked_at     INTEGER NOT NULL,
  answered_at  INTEGER
);

CREATE INDEX IF NOT EXISTS task_questions_task ON task_questions(task_id);

-- ─── Documents attached to a task ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_attachments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  name        TEXT NOT NULL,             -- sanitised file name
  stored_path TEXT NOT NULL,
  media       TEXT NOT NULL,             -- markdown | text | pdf
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS task_attachments_task ON task_attachments(task_id);

-- ─── Data connections (MCP servers the developer lets tester agents use) ─────
-- Known by name only: how a server starts stays in Claude Code's own settings.
-- Default deny: a server no row enables, a tool no row lists, a project no row grants.
CREATE TABLE IF NOT EXISTS connections (
  name            TEXT PRIMARY KEY,
  definition_hash TEXT NOT NULL,          -- of the server's definition when the developer last reviewed it; a change voids everything below
  env_kind        TEXT NOT NULL DEFAULT 'unknown' CHECK (env_kind IN ('local', 'staging', 'production', 'unknown')),
  access          TEXT NOT NULL DEFAULT 'unknown' CHECK (access IN ('read_only', 'read_write', 'unknown')),
  enabled         INTEGER NOT NULL DEFAULT 0,
  tools_json      TEXT,                   -- the tools the server reported: [{ name, description, suggested, risky }]
  checked_at      INTEGER,
  updated_at      INTEGER NOT NULL,
  -- An agent never gets production, and never a connection that can write.
  CHECK (enabled = 0 OR (env_kind IN ('local', 'staging') AND access = 'read_only'))
);

CREATE TABLE IF NOT EXISTS connection_tools (
  connection TEXT NOT NULL REFERENCES connections(name) ON DELETE CASCADE,
  tool       TEXT NOT NULL,
  check_kind TEXT NOT NULL CHECK (check_kind IN ('sql', 'mongo', 'plain')),
  PRIMARY KEY (connection, tool)
);

CREATE TABLE IF NOT EXISTS role_grants (
  role       TEXT NOT NULL,               -- api_tester
  connection TEXT NOT NULL REFERENCES connections(name) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  PRIMARY KEY (role, connection, project_id)
);

-- ─── Deploys (a staging build started in Jenkins after a release, and followed) ─
CREATE TABLE IF NOT EXISTS deploys (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  repo_id       TEXT NOT NULL,
  release_id    TEXT,                     -- the release whose merge this deploys
  approval_id   TEXT,                     -- the owner's yes that started it
  job           TEXT NOT NULL,
  params_json   TEXT NOT NULL,
  stage         TEXT,                     -- the stage that is the staging deploy, if one was named
  expected_sha  TEXT NOT NULL,            -- the merge on staging that the build must contain
  state         TEXT NOT NULL,            -- queued | running | waiting_input | succeeded | failed | stopped
  queue_path    TEXT,
  build_number  INTEGER,
  build_url     TEXT,
  built_sha     TEXT,
  stages_json   TEXT,                     -- the pipeline's stages when last looked at
  input_id      TEXT,                     -- the prompt waiting for the owner's yes
  outcome       TEXT,                     -- deployed | build_failed | wrong_commit | unconfirmed | cancelled | production_prompt | timeout | error | interrupted
  detail        TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  deadline_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS deploys_task ON deploys(task_id);

-- ─── Which Chat thread belongs to which task ─────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_threads (
  task_id     TEXT PRIMARY KEY,
  thread_name TEXT NOT NULL UNIQUE          -- spaces/X/threads/Y
);

-- ─── Chat message dedup ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_messages (
  name        TEXT PRIMARY KEY,          -- Google Chat message name (spaces/.../messages/...)
  processed_at INTEGER NOT NULL
);

-- ─── Service graph (knowledge/graph.ts): which project calls which ────────────
-- Built by a deterministic scan of each project's production commit; the owner can
-- confirm, rename, add and delete. Rows the owner touched (source = 'owner') are never
-- overwritten by a rescan; an owner deletion stays as a row with deleted = 1.
CREATE TABLE IF NOT EXISTS graph_nodes (
  id          TEXT PRIMARY KEY,           -- project:<id> | endpoint:<project>:<METHOD path> | env:<project>:<KEY> | ext:<name>
  kind        TEXT NOT NULL CHECK (kind IN ('project', 'external_service', 'endpoint', 'env_key')),
  project_id  TEXT,                       -- the project the node belongs to (null: shared, e.g. an outside service)
  label       TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('scan', 'owner')),
  confidence  REAL NOT NULL DEFAULT 1,
  confirmed   INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS graph_nodes_project ON graph_nodes(project_id);

CREATE TABLE IF NOT EXISTS graph_edges (
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('calls', 'exposes', 'served_by')),
  project_id    TEXT,                     -- the project whose scan (or whose owner edit) made it
  evidence_json TEXT,                     -- [{file, line?}] where the scan saw it
  source        TEXT NOT NULL CHECK (source IN ('scan', 'owner')),
  confidence    REAL NOT NULL DEFAULT 1,  -- below 1: a guess (name matching), until the owner confirms it
  confirmed     INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0, -- 1: the owner removed it; a rescan does not bring it back
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS graph_edges_to ON graph_edges(to_id);
CREATE INDEX IF NOT EXISTS graph_edges_project ON graph_edges(project_id);

-- One row per project: the production commit last scanned, what the scan read, and the digest built from it.
CREATE TABLE IF NOT EXISTS graph_scans (
  project_id  TEXT PRIMARY KEY,
  sha         TEXT,
  scanned_at  INTEGER NOT NULL,
  facts_json  TEXT,                       -- knowledge/scan.ts ScanFacts
  digest      TEXT,                       -- knowledge/digest.ts, for this sha
  error       TEXT                        -- why the last scan could not run
);

-- ─── Lessons (learning/) ──────────────────────────────────────────────────────
-- What the agents learned from earlier tasks. Proposed by the Reflector or by core from
-- stored facts; nothing reaches an agent until the owner makes it active.
CREATE TABLE IF NOT EXISTS lessons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT,                      -- NULL: applies in every project
  role            TEXT NOT NULL CHECK (role IN ('analyst', 'planner', 'coder', 'tester')),
  trigger_tags    TEXT NOT NULL DEFAULT '[]', -- JSON string[]: words matched against a task's areas and files
  text            TEXT NOT NULL,
  evidence_json   TEXT NOT NULL DEFAULT '[]', -- JSON [{taskId, round, what}]
  signatures_json TEXT NOT NULL DEFAULT '[]', -- failure signatures it was drawn from (learning/signatures.ts)
  source          TEXT NOT NULL CHECK (source IN ('reflector', 'core')),
  state           TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'active', 'retired', 'rejected')),
  uses            INTEGER NOT NULL DEFAULT 0,
  helped          INTEGER NOT NULL DEFAULT 0,
  hurt            INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER,
  CHECK (state = 'proposed' OR decided_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_lessons_state ON lessons(state, role);

-- Which lessons an agent of a task was given, and what came of it once the task ended.
CREATE TABLE IF NOT EXISTS lesson_uses (
  lesson_id  INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  task_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  outcome    TEXT CHECK (outcome IN ('helped', 'hurt', 'neutral')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (lesson_id, task_id, role)
);
CREATE INDEX IF NOT EXISTS idx_lesson_uses_task ON lesson_uses(task_id);

-- ─── Schema version ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

INSERT OR IGNORE INTO schema_version VALUES (1);
INSERT OR IGNORE INTO schema_version VALUES (2);
INSERT OR IGNORE INTO schema_version VALUES (3);
INSERT OR IGNORE INTO schema_version VALUES (4);
INSERT OR IGNORE INTO schema_version VALUES (5);
INSERT OR IGNORE INTO schema_version VALUES (6);
INSERT OR IGNORE INTO schema_version VALUES (7);
INSERT OR IGNORE INTO schema_version VALUES (8);
INSERT OR IGNORE INTO schema_version VALUES (9);
INSERT OR IGNORE INTO schema_version VALUES (10);
INSERT OR IGNORE INTO schema_version VALUES (11);
INSERT OR IGNORE INTO schema_version VALUES (12);
INSERT OR IGNORE INTO schema_version VALUES (13);
INSERT OR IGNORE INTO schema_version VALUES (14);
INSERT OR IGNORE INTO schema_version VALUES (15);
