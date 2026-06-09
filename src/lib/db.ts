/**
 * SQLite connection + schema bootstrap. The DB is a cache/record, never the
 * control plane (see CONVENTIONS.md). Idempotent: safe to open repeatedly.
 */
import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  url         TEXT NOT NULL,
  youtube_id  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  stage       TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  youtube_id     TEXT NOT NULL,
  voice          TEXT NOT NULL,
  video_file_id  TEXT NOT NULL,
  srt_file_id    TEXT NOT NULL,
  audio_file_id  TEXT NOT NULL,
  title          TEXT,
  duration       INTEGER,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (youtube_id, voice)
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
