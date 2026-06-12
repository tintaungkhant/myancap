import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

process.env.WORK_DIR = "/tmp/myancap-runtest";
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.OPENAI_API_KEY = "o";
process.env.GEMINI_API_KEY = "g";
process.env.AZURE_SPEECH_KEY = "a";
process.env.AWS_ENDPOINT = "https://acc.r2.cloudflarestorage.com";
process.env.AWS_ACCESS_KEY_ID = "rk";
process.env.AWS_SECRET_ACCESS_KEY = "rs";
process.env.AWS_BUCKET = "vids";
process.env.AWS_URL = "https://media.example.com";

import { openDb } from "../lib/db";
import { insertJob, hasActiveJob } from "../services/store";
import { createJobDir, cleanupJobDir, type Job } from "./job";
import { runJob, type RunDeps } from "./run";

afterEach(async () => { await cleanupJobDir("/tmp/myancap-runtest"); });

function makeDeps(sent: string[]): RunDeps {
  return {
    probe: async () => ({ durationSeconds: 100, title: "My Clip" }),
    download: async (_u: string, dir: string) => {
      await Bun.write(`${dir}/video.mp4`, "VIDEODATA");
      return { videoPath: `${dir}/video.mp4` };
    },
    getFile: async () => ({ filePath: "videos/f.mp4", fileSize: 1000 }),
    downloadFile: async (_p: string, dest: string) => { await Bun.write(dest, "VIDEODATA"); },
    probeDuration: async () => 100,
    extractAudio: async (_v: string, o: string) => { await Bun.write(o, "AUDIO"); },
    transcribe: async () => "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
    translateSrt: async () => "1\n00:00:01,000 --> 00:00:02,000\nმინ\n",
    srtToSpeech: async () => new Uint8Array([1, 2, 3]),
    wavToMp3: async (_i: string, o: string) => { await Bun.write(o, "MP3"); },
    uploadVideo: async () => { sent.push("upload"); return "https://media.example.com/v.mp4"; },
    sendDocument: async (_c: number, _b: Uint8Array, fn: string) => {
      sent.push(fn.includes(".en.") ? "en" : "my");
      return "DF";
    },
    sendAudio: async () => { sent.push("audio"); return "AF"; },
    sendMessage: async () => {},
  };
}

const ytSource = { kind: "youtube", url: "u", youtubeId: "ytid" } as const;
const tgSource = { kind: "telegram_video", fileId: "FID" } as const;

test("youtube happy path: uploads video + sends 3 files, clears job, cleans dir", async () => {
  const db = openDb(":memory:");
  await mkdir("/tmp/myancap-runtest", { recursive: true });
  const dir = await createJobDir("run1");
  insertJob(db, { id: "run1", telegramId: 5, now: 1 });

  const sent: string[] = [];
  const job: Job = { id: "run1", telegramId: 5, chatId: 5, dir, source: ytSource };
  await runJob(db, job, makeDeps(sent));

  expect(sent).toEqual(["upload", "my", "en", "audio"]);
  // Ephemeral: job row deleted (lock released), temp dir gone, nothing cached.
  expect(hasActiveJob(db, 5)).toBe(false);
  const jobRows = db.query("SELECT COUNT(*) AS n FROM jobs").get() as any;
  expect(jobRows.n).toBe(0);
  expect(existsSync(dir)).toBe(false);
  db.close();
});

test("telegram_video: sends 3 files (NO video), clears job, cleans dir", async () => {
  const db = openDb(":memory:");
  await mkdir("/tmp/myancap-runtest", { recursive: true });
  const dir = await createJobDir("runtg");
  insertJob(db, { id: "runtg", telegramId: 8, now: 1 });

  const sent: string[] = [];
  const job: Job = { id: "runtg", telegramId: 8, chatId: 8, dir, source: tgSource };
  await runJob(db, job, makeDeps(sent));

  expect(sent).toEqual(["my", "en", "audio"]); // no "video"
  expect(hasActiveJob(db, 8)).toBe(false);
  expect(existsSync(dir)).toBe(false);
  db.close();
});

test("telegram_video oversize: rejects, sends nothing, cleans dir", async () => {
  const db = openDb(":memory:");
  await mkdir("/tmp/myancap-runtest", { recursive: true });
  const dir = await createJobDir("runbig");
  insertJob(db, { id: "runbig", telegramId: 11, now: 1 });

  const sent: string[] = [];
  const msgs: string[] = [];
  const deps = makeDeps(sent);
  deps.getFile = async () => ({ filePath: "videos/f.mp4", fileSize: 21 * 1024 * 1024 });
  deps.sendMessage = async (_c: number, m: string) => { msgs.push(m); };

  const job: Job = { id: "runbig", telegramId: 11, chatId: 11, dir, source: tgSource };
  await runJob(db, job, deps);

  expect(sent).toEqual([]); // failed in stage 1, nothing sent
  expect(msgs.some((m) => m.includes("❌"))).toBe(true);
  expect(hasActiveJob(db, 11)).toBe(false);
  expect(existsSync(dir)).toBe(false);
  db.close();
});

test("youtube upload failure: warns, still sends 3 files", async () => {
  const db = openDb(":memory:");
  await mkdir("/tmp/myancap-runtest", { recursive: true });
  const dir = await createJobDir("run3");
  insertJob(db, { id: "run3", telegramId: 7, now: 1 });

  const sent: string[] = [];
  const msgs: string[] = [];
  const deps = makeDeps(sent);
  deps.uploadVideo = async () => { throw new Error("r2 boom"); };
  deps.sendMessage = async (_c: number, m: string) => { msgs.push(m); };

  const job: Job = { id: "run3", telegramId: 7, chatId: 7, dir, source: ytSource };
  await runJob(db, job, deps);

  expect(sent).toEqual(["my", "en", "audio"]); // no upload success
  expect(msgs.some((m) => m.includes("video link မရပါ"))).toBe(true);
  expect(existsSync(dir)).toBe(false);
  db.close();
});

test("failure path: deletes job row, notifies, still cleans the dir", async () => {
  const db = openDb(":memory:");
  await mkdir("/tmp/myancap-runtest", { recursive: true });
  const dir = await createJobDir("run2");
  insertJob(db, { id: "run2", telegramId: 6, now: 1 });

  const deps = makeDeps([]);
  deps.transcribe = async () => { throw new Error("whisper boom"); };

  const job: Job = { id: "run2", telegramId: 6, chatId: 6, dir, source: ytSource };
  await runJob(db, job, deps);

  expect(hasActiveJob(db, 6)).toBe(false); // row deleted on failure
  const jobRows = db.query("SELECT COUNT(*) AS n FROM jobs").get() as any;
  expect(jobRows.n).toBe(0);
  expect(existsSync(dir)).toBe(false);
  db.close();
});
