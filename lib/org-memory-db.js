'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const RETICLE_HOME = process.env.RETICLE_HOME || path.join(require('os').homedir(), '.reticle');
const DB_PATH = process.env.ORG_MEMORY_DB_PATH || path.join(RETICLE_HOME, 'data', 'org-memory.db');

let _db = null;

function initDatabase(dbPath) {
  const resolvedPath = dbPath || DB_PATH;

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_messages (
      id            TEXT PRIMARY KEY,
      source        TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      channel_id    TEXT,
      channel_name  TEXT,
      author_id     TEXT,
      author_ext_id TEXT,
      author_name   TEXT,
      content       TEXT NOT NULL,
      thread_id     TEXT,
      occurred_at   INTEGER NOT NULL,
      metadata      TEXT,
      extracted     INTEGER DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_source ON raw_messages(source, source_id);
    CREATE INDEX IF NOT EXISTS idx_raw_pending ON raw_messages(extracted, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_raw_channel ON raw_messages(channel_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_raw_author ON raw_messages(author_id, occurred_at);

    CREATE TABLE IF NOT EXISTS entities (
      id               TEXT PRIMARY KEY,
      entity_type      TEXT NOT NULL,
      canonical_name   TEXT NOT NULL,
      is_active        INTEGER DEFAULT 1,
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type, is_active);
    CREATE INDEX IF NOT EXISTS idx_entities_active ON entities(is_active);

    CREATE TABLE IF NOT EXISTS facts (
      id                    TEXT PRIMARY KEY,
      entity_id             TEXT NOT NULL REFERENCES entities(id),
      attribute             TEXT NOT NULL,
      value                 TEXT,
      fact_type             TEXT NOT NULL DEFAULT 'state'
                              CHECK(fact_type IN ('state', 'event')),
      valid_from            INTEGER NOT NULL,
      valid_to              INTEGER,
      confidence            REAL DEFAULT 1.0,
      source_message_id     TEXT,
      last_confirmed_at     INTEGER,
      last_confirmed_source TEXT,
      resolution            TEXT CHECK(resolution IS NULL OR resolution IN ('open', 'completed', 'abandoned', 'superseded')),
      resolved_at           INTEGER,
      extracted_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id, attribute);
    CREATE INDEX IF NOT EXISTS idx_facts_current ON facts(entity_id, attribute, valid_to);
    CREATE INDEX IF NOT EXISTS idx_facts_date ON facts(valid_from);
    CREATE INDEX IF NOT EXISTS idx_facts_extracted ON facts(extracted_at);

    CREATE TABLE IF NOT EXISTS identity_map (
      entity_id    TEXT NOT NULL REFERENCES entities(id),
      source       TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      display_name TEXT,
      jira_id      TEXT,
      resolved_at  INTEGER,
      metadata     TEXT,
      PRIMARY KEY (source, external_id)
    );
  `);

  // Migration: add author_ext_id for identity re-resolution
  try {
    db.exec('ALTER TABLE raw_messages ADD COLUMN author_ext_id TEXT');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_raw_author_ext ON raw_messages(author_ext_id)');

  return db;
}

function getDatabase() {
  if (!_db) {
    _db = initDatabase();
  }
  return _db;
}

function backupDatabase() {
  const bakPath = DB_PATH + '.bak';
  const db = getDatabase();
  db.exec(`VACUUM INTO '${bakPath.replace(/'/g, "''")}'`);
  return bakPath;
}

module.exports = { initDatabase, getDatabase, backupDatabase, DB_PATH };
