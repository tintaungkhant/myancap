/**
 * All DB queries live here as named functions. The DB is a cache + record;
 * callers never write raw SQL.
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

export type CachedVideo = {
  youtubeId: string;
  voice: string;
  videoFileId: string;
  srtFileId: string;
  audioFileId: string;
  title: string | null;
  duration: number | null;
  createdAt: number;
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

/** True if this user has a queued or running job. */
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

export function getCachedVideo(
  db: Database,
  youtubeId: string,
  voice: string,
): CachedVideo | null {
  const row = db
    .query(`SELECT * FROM videos WHERE youtube_id = ? AND voice = ?`)
    .get(youtubeId, voice) as any;
  if (!row) return null;
  return {
    youtubeId: row.youtube_id,
    voice: row.voice,
    videoFileId: row.video_file_id,
    srtFileId: row.srt_file_id,
    audioFileId: row.audio_file_id,
    title: row.title,
    duration: row.duration,
    createdAt: row.created_at,
  };
}

export type CacheUpsert = {
  youtubeId: string;
  voice: string;
  videoFileId: string;
  srtFileId: string;
  audioFileId: string;
  title: string | null;
  duration: number | null;
  now: number;
};

export function upsertCachedVideo(db: Database, v: CacheUpsert): void {
  db.query(
    `INSERT INTO videos
       (youtube_id, voice, video_file_id, srt_file_id, audio_file_id, title, duration, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (youtube_id, voice) DO UPDATE SET
       video_file_id = excluded.video_file_id,
       srt_file_id   = excluded.srt_file_id,
       audio_file_id = excluded.audio_file_id,
       title         = excluded.title,
       duration      = excluded.duration,
       created_at    = excluded.created_at`,
  ).run(
    v.youtubeId,
    v.voice,
    v.videoFileId,
    v.srtFileId,
    v.audioFileId,
    v.title,
    v.duration,
    v.now,
  );
}
