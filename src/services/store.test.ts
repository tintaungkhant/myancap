import { expect, test } from "bun:test";
import { openDb } from "../lib/db";
import {
  insertJob,
  setJobStatus,
  deleteJob,
  hasActiveJob,
  markUpdateProcessed,
} from "./store";

const now = 1_000_000;

function freshDb() {
  return openDb(":memory:");
}

test("insertJob then hasActiveJob is true; deleteJob clears it", () => {
  const db = freshDb();
  insertJob(db, { id: "j1", telegramId: 42, url: "u", youtubeId: "yt", now });
  expect(hasActiveJob(db, 42)).toBe(true);
  deleteJob(db, "j1");
  expect(hasActiveJob(db, 42)).toBe(false);
  db.close();
});

test("setJobStatus updates stage without clearing the active lock", () => {
  const db = freshDb();
  insertJob(db, { id: "j1", telegramId: 42, url: "u", youtubeId: "yt", now });
  setJobStatus(db, "j1", "running", { stage: "transcribe", now });
  expect(hasActiveJob(db, 42)).toBe(true);
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
