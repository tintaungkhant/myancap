/**
 * All DB queries live here as named functions. State is ephemeral: a job row
 * exists only while processing, and is deleted on completion (success or fail).
 * There is no result cache — every request reprocesses from scratch.
 */
import type { Database } from "bun:sqlite";

export type JobStatus = "queued" | "running" | "done" | "failed";

export type NewJob = {
  id: string;
  telegramId: number;
  url: string;
  youtubeId: string;
  now: number; // unix ms
};

export function insertJob(db: Database, job: NewJob): void {
  db.query(
    `INSERT INTO jobs (id, telegram_id, url, youtube_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
  ).run(job.id, job.telegramId, job.url, job.youtubeId, job.now, job.now);
}

export function setJobStatus(
  db: Database,
  id: string,
  status: JobStatus,
  opts: { stage?: string; error?: string; now: number },
): void {
  db.query(
    `UPDATE jobs SET status = ?, stage = ?, error = ?, updated_at = ? WHERE id = ?`,
  ).run(status, opts.stage ?? null, opts.error ?? null, opts.now, id);
}

/** Remove a job row — called when the job finishes, success or fail. */
export function deleteJob(db: Database, id: string): void {
  db.query(`DELETE FROM jobs WHERE id = ?`).run(id);
}

/**
 * Wipe all job rows. Called once at boot: the in-process queue doesn't survive
 * restart, so any leftover rows are stale locks from a crash — clear them.
 */
export function clearAllJobs(db: Database): void {
  db.query(`DELETE FROM jobs`).run();
}

/** True if this user has a queued or running job (the per-user lock). */
export function hasActiveJob(db: Database, telegramId: number): boolean {
  const row = db
    .query(
      `SELECT 1 FROM jobs WHERE telegram_id = ? AND status IN ('queued','running') LIMIT 1`,
    )
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
