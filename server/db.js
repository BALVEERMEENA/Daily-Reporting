'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'reporting.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Schema. All tables are created if they do not already exist so the app is
 * safe to start repeatedly.
 */
function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,
      head_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      email          TEXT NOT NULL UNIQUE,
      password_hash  TEXT NOT NULL,
      role           TEXT NOT NULL CHECK (role IN ('admin','dept_head','employee')),
      department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS questionnaires (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      description   TEXT,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS questions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      questionnaire_id  INTEGER NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE,
      text              TEXT NOT NULL,
      type              TEXT NOT NULL DEFAULT 'text'
                        CHECK (type IN ('text','textarea','number','date','select','radio','checkbox')),
      options           TEXT,          -- JSON array for select/radio/checkbox
      required          INTEGER NOT NULL DEFAULT 0,
      position          INTEGER NOT NULL DEFAULT 0
    );

    -- Maps a questionnaire to a specific employee, addressable by a unique code.
    CREATE TABLE IF NOT EXISTS assignments (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      questionnaire_id  INTEGER NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code              TEXT NOT NULL UNIQUE,
      active            INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (questionnaire_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id     INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
      questionnaire_id  INTEGER NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      submitted_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS answers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id  INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
      question_id    INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      value          TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      description   TEXT,
      assigned_to   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      due_date      TEXT,
      status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','done')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message     TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'info',
      related_id  INTEGER,
      is_read     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_department ON users(department_id);
    CREATE INDEX IF NOT EXISTS idx_assignments_user ON assignments(user_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  `);
}

migrate();

module.exports = db;
