import Database from 'better-sqlite3';
import path from 'node:path';
import { DATA_DIR } from './config.ts';

const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  daily_minutes INTEGER NOT NULL DEFAULT 90,
  target_recall REAL NOT NULL DEFAULT 0.85,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS otps (
  dest TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  username TEXT,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  exam_at INTEGER NOT NULL,
  total_marks INTEGER NOT NULL DEFAULT 100,
  guess_rate REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'pdf',
  title TEXT NOT NULL,
  file_name TEXT,
  pages INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | processing | done | failed
  progress REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  chapter TEXT,
  order_idx INTEGER NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0.5,
  weight REAL NOT NULL DEFAULT 1,
  weight_source TEXT NOT NULL DEFAULT 'manual',
  est_learn_min INTEGER NOT NULL DEFAULT 45,
  page_from INTEGER, page_to INTEGER,
  note_line TEXT, note_compact TEXT, note_detailed TEXT, note_simple TEXT,
  half_life REAL, mastery REAL NOT NULL DEFAULT 0, last_review_at INTEGER,
  n_reviews INTEGER NOT NULL DEFAULT 0, hl_unc REAL NOT NULL DEFAULT 0.6,
  skip INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'formula',
  name TEXT NOT NULL,
  latex TEXT,
  meaning TEXT,
  half_life REAL, mastery REAL NOT NULL DEFAULT 0, last_review_at INTEGER,
  n_reviews INTEGER NOT NULL DEFAULT 0, hl_unc REAL NOT NULL DEFAULT 0.6
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'mcq',          -- mcq | contrast
  prompt TEXT NOT NULL,
  options_json TEXT NOT NULL,
  answer_idx INTEGER NOT NULL,
  explanation TEXT,
  page_ref INTEGER
);

CREATE TABLE IF NOT EXISTS distractors (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  option_idx INTEGER NOT NULL,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, option_idx)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  confidence INTEGER NOT NULL,
  chosen_idx INTEGER,
  correct INTEGER NOT NULL,
  response_ms INTEGER NOT NULL,
  answered_at INTEGER NOT NULL,
  quiz_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_attempts_user_topic ON attempts(user_id, topic_id, answered_at);

CREATE TABLE IF NOT EXISTS study_sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
  topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  kind TEXT NOT NULL DEFAULT 'learn'
);

CREATE TABLE IF NOT EXISTS confusions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_a INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  topic_b INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 0,
  exposures INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER,
  PRIMARY KEY (user_id, topic_a, topic_b)
);

CREATE TABLE IF NOT EXISTS forecasts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  readiness REAL NOT NULL,
  p10 REAL, p50 REAL, p90 REAL,
  PRIMARY KEY (user_id, subject_id, day)
);
`);

CREATE_EXTRA();

function CREATE_EXTRA() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS paper_questions (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    number TEXT,
    text TEXT NOT NULL,
    marks REAL NOT NULL DEFAULT 1,
    year INTEGER,
    topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL,
    match_score REAL
  );
  CREATE TABLE IF NOT EXISTS user_params (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    params_json TEXT NOT NULL,
    fitted_at INTEGER NOT NULL,
    n_attempts INTEGER NOT NULL,
    loss_default REAL,
    loss_fitted REAL
  );
  `);
  // Small column migrations for databases created by the first version.
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
  if (!cols('sources').includes('ocr_pages')) db.exec('ALTER TABLE sources ADD COLUMN ocr_pages INTEGER NOT NULL DEFAULT 0');
  if (!cols('sources').includes('year')) db.exec('ALTER TABLE sources ADD COLUMN year INTEGER');
  if (!cols('sources').includes('note')) db.exec('ALTER TABLE sources ADD COLUMN note TEXT');
  if (!cols('sources').includes('retry_after')) db.exec('ALTER TABLE sources ADD COLUMN retry_after INTEGER');
}

export default db;
