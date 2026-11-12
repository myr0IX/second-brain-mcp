import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  DB_PATH,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  SCHEMA_VERSION,
} from "../utils/config.js";

export type Db = Database.Database;

export function createDb(dbPath: string = DB_PATH): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS history_docs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      kind         TEXT    NOT NULL CHECK (kind IN ('exchange', 'vault')),
      source_path  TEXT    NOT NULL,
      session_id   TEXT,
      exchange_idx INTEGER,
      repo         TEXT,
      branch       TEXT,
      tickets      TEXT    NOT NULL DEFAULT '',
      ts           TEXT,
      vault_note   TEXT,
      text         TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_history_source ON history_docs(source_path);
    CREATE INDEX IF NOT EXISTS idx_history_session ON history_docs(session_id, exchange_idx);

    CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
      text, tickets, tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS history_vec USING vec0(
      embedding float[${EMBEDDING_DIM}]
    );

    CREATE TABLE IF NOT EXISTS history_sources (
      path       TEXT PRIMARY KEY,
      signature  TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
  `);

  assertCompatibleMeta(db);
  return db;
}

function assertCompatibleMeta(db: Db): void {
  const read = db.prepare<[string], { value: string }>(
    `SELECT value FROM meta WHERE key = ?`,
  );
  const write = db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const storedDim = read.get("embedding_dim")?.value;
  if (storedDim !== undefined && storedDim !== String(EMBEDDING_DIM)) {
    throw new Error(
      `Database was built with embeddings of ${storedDim} dimensions but the server ` +
        `now uses ${EMBEDDING_DIM}. Set SECOND_BRAIN_DB to another file to build a new index.`,
    );
  }

  write.run("schema_version", String(SCHEMA_VERSION));
  write.run("embedding_model", EMBEDDING_MODEL);
  write.run("embedding_dim", String(EMBEDDING_DIM));
}
