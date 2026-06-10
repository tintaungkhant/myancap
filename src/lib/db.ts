/**
 * SQLite connection + schema bootstrap. Holds only ephemeral processing state:
 * a `jobs` row exists only while a job runs and acts as that user's lock (no
 * status/result is tracked), and `processed_updates` dedups webhook retries.
 * Idempotent: safe to open repeatedly.
 */
import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  url         TEXT NOT NULL,
  youtube_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id   INTEGER PRIMARY KEY,
  seen_at     INTEGER NOT NULL
);
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}
