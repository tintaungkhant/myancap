/**
 * All DB queries live here as named functions. State is ephemeral: a job row
 * exists only while processing and is deleted on completion (success or fail).
 * The row's mere existence is the per-user lock — there is no status tracking
 * and no result cache. Every request reprocesses from scratch.
 */
import type { Database } from "bun:sqlite";

export type NewJob = {
  id: string;
  telegramId: number;
  url: string;
  youtubeId: string;
  now: number; // unix ms
};

export function insertJob(db: Database, job: NewJob): void {
  db.query(
    `INSERT INTO jobs (id, telegram_id, url, youtube_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(job.id, job.telegramId, job.url, job.youtubeId, job.now);
}

/** Remove a job row — called when the job finishes, success or fail. */
export function deleteJob(db: Database, id: string): void {
  db.query(`DELETE FROM jobs WHERE id = ?`).run(id);
}

/** True if this user has a job in flight (a row exists = the per-user lock). */
export function hasActiveJob(db: Database, telegramId: number): boolean {
  const row = db
    .query(`SELECT 1 FROM jobs WHERE telegram_id = ? LIMIT 1`)
    .get(telegramId);
  return row !== null;
}

/** Record an update_id. Returns false if it was already seen (duplicate). */
export function markUpdateProcessed(
  db: Database,
  updateId: number,
  now: number,
): boolean {
  const res = db
    .query(
      `INSERT OR IGNORE INTO processed_updates (update_id, seen_at) VALUES (?, ?)`,
    )
    .run(updateId, now);
  return res.changes > 0;
}
