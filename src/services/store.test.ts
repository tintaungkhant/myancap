import { expect, test } from "bun:test";
import { openDb } from "../lib/db";
import {
  insertJob,
  setJobStatus,
  hasActiveJob,
  markUpdateProcessed,
  getCachedVideo,
  upsertCachedVideo,
} from "./store";

const now = 1_000_000;

function freshDb() {
  return openDb(":memory:");
}

test("insertJob then hasActiveJob is true; done clears it", () => {
  const db = freshDb();
  insertJob(db, { id: "j1", telegramId: 42, url: "u", youtubeId: "yt", now });
  expect(hasActiveJob(db, 42)).toBe(true);
  setJobStatus(db, "j1", "done", { now });
  expect(hasActiveJob(db, 42)).toBe(false);
  db.close();
});

test("hasActiveJob is per-user", () => {
  const db = freshDb();
  insertJob(db, { id: "j1", telegramId: 42, url: "u", youtubeId: "yt", now });
  expect(hasActiveJob(db, 99)).toBe(false);
  db.close();
});

test("markUpdateProcessed returns true once, false on repeat", () => {
  const db = freshDb();
  expect(markUpdateProcessed(db, 555, now)).toBe(true);
  expect(markUpdateProcessed(db, 555, now)).toBe(false);
  db.close();
});

test("video cache upsert + read", () => {
  const db = freshDb();
  expect(getCachedVideo(db, "yt", "v")).toBeNull();
  upsertCachedVideo(db, {
    youtubeId: "yt",
    voice: "v",
    videoFileId: "vf",
    srtFileId: "sf",
    audioFileId: "af",
    title: "T",
    duration: 120,
    now,
  });
  const got = getCachedVideo(db, "yt", "v");
  expect(got?.videoFileId).toBe("vf");
  expect(got?.srtFileId).toBe("sf");
  expect(got?.audioFileId).toBe("af");
  db.close();
});
