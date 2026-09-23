import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { dbPath, nowIso } from './config.js';

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  session_id TEXT,
  raw_text TEXT NOT NULL,
  filtered_text TEXT,
  skip_reason TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  latency_ms INTEGER
);

CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_job_id INTEGER REFERENCES analysis_jobs(id),
  original_text TEXT NOT NULL,
  rewrite_text TEXT,
  reason TEXT,
  issue_class TEXT,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,
  message_id TEXT,
  session_id TEXT,
  model TEXT,
  model_version TEXT,
  filter_version TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  canonical_form TEXT NOT NULL,
  match_key TEXT NOT NULL UNIQUE,
  rule_key TEXT,
  explanation TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_instance_id INTEGER REFERENCES instances(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instance_knowledge_points (
  instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  knowledge_point_id INTEGER NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, knowledge_point_id, role)
);

CREATE TABLE IF NOT EXISTS review_states (
  knowledge_point_id INTEGER PRIMARY KEY REFERENCES knowledge_points(id) ON DELETE CASCADE,
  due_at TEXT NOT NULL,
  state TEXT NOT NULL,
  stability REAL,
  difficulty REAL,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  last_review_at TEXT,
  last_rating INTEGER,
  scheduler TEXT NOT NULL DEFAULT 'fsrs-5',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_point_id INTEGER NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  expected TEXT,
  context_instance_id INTEGER REFERENCES instances(id),
  generated_at TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS review_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES review_questions(id) ON DELETE CASCADE,
  answer_text TEXT NOT NULL,
  verdict TEXT NOT NULL,
  issue_class TEXT,
  feedback_rewrite TEXT,
  feedback_reason TEXT,
  instance_id INTEGER REFERENCES instances(id),
  rating INTEGER,
  created_at TEXT NOT NULL,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_knowledge_points_kind ON knowledge_points(kind);
CREATE INDEX IF NOT EXISTS idx_knowledge_points_rule_key ON knowledge_points(rule_key);
CREATE INDEX IF NOT EXISTS idx_review_states_due_at ON review_states(due_at);
CREATE INDEX IF NOT EXISTS idx_instances_created_at ON instances(created_at);
CREATE INDEX IF NOT EXISTS idx_instances_issue_class ON instances(issue_class);
CREATE INDEX IF NOT EXISTS idx_ikp_knowledge_point ON instance_knowledge_points(knowledge_point_id);
CREATE INDEX IF NOT EXISTS idx_review_questions_kp_status ON review_questions(knowledge_point_id, status);
CREATE INDEX IF NOT EXISTS idx_review_answers_question ON review_answers(question_id);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status ON analysis_jobs(status);
`;

export const SETTING_DEFAULTS: Readonly<Record<string, string>> = {
  'capture-enabled': 'on',
  'statusline-suggestion': 'on',
  'statusline-original': 'auto',
  'session-start-review': 'on',
  'quiet-mode': 'off',
  'reminder-channel': 'terminal',
  hook_installed: 'false',
  hook_seen_at: '',
  endpoint_status: 'not_configured',
  endpoint_checked_at: '',
  endpoint_error: '',
  last_analysis_result: '',
};

/** Opens (and migrates) the local SQLite store. `:memory:` is allowed for tests. */
export function openDatabase(file: string = dbPath()): DatabaseType {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  migrate(db);
  seedSettings(db);
  return db;
}

export function migrate(db: DatabaseType): void {
  db.exec(SCHEMA_SQL);
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    | { version: number | null }
    | undefined;
  if (!row || row.version === null) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION,
      nowIso(),
    );
  }
}

function seedSettings(db: DatabaseType): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
  );
  const at = nowIso();
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    insert.run(key, value, at);
  }
}

export type { DatabaseType };