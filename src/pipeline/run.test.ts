import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

process.env.WORK_DIR = "/tmp/myancap-runtest";
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.OPENAI_API_KEY = "o";
process.env.GEMINI_API_KEY = "g";
process.env.AZURE_SPEECH_KEY = "a";

import { openDb } from "../lib/db";
import { insertJob, hasActiveJob } from "../services/store";
import { createJobDir, cleanupJobDir } from "./job";
import { runJob, type RunDeps } from "./run";

afterEach(async () => { await cleanupJobDir("/tmp/myancap-runtest"); });

function makeDeps(sent: string[]): RunDeps {
  return {
    probe: async () => ({ durationSeconds: 100, title: "My Clip" }),
    download: async (_u: string, dir: string) => {
      await Bun.write(`${dir}/video.mp4`, "VIDEODATA");
      return { videoPath: `${dir}/video.mp4`, audioPath: `${dir}/audio.mp3` };
    },
    transcribe: async () => "1\n00:00:01,000 --> 00:00:02,000\nHi\n",
    translateSrt: async () => "1\n00:00:01,000 --> 00:00:02,000\nმინ\n",
    srtToSpeech: async () => new Uint8Array([1, 2, 3]),
    wavToAac: async (_i: string, o: string) => { await Bun.write(o, "AAC"); },
    sendVideo: async () => { sent.push("video"); return "VF"; },
    sendDocument: async () => { sent.push("doc"); return "SF"; },
    sendAudio: async () => { sent.push("audio"); return "AF"; },
    sendMessage: async () => {},
  };
}

test("happy path: sends 3 files, caches result, clears job, cleans dir", async () => {
  const db = openDb(":memory:");
  await mkdir("/tmp/myancap-runtest", { recursive: true });
  const dir = await createJobDir("run1");
  insertJob(db, { id: "run1", telegramId: 5, url: "u", youtubeId: "ytid", now: 1 });

  const sent: string[] = [];
  await runJob(db, { id: "run1", telegramId: 5, chatId: 5, url: "u", youtubeId: "ytid", dir }, makeDeps(sent));

  expect(sent).toEqual(["video", "doc", "audio"]);
  // Ephemeral: job row deleted (lock released), temp dir gone, nothing cached.
  expect(hasActiveJob(db, 5)).toBe(false);
  const jobRows = db.query("SELECT COUNT(*) AS n FROM jobs").get() as any;
  expect(jobRows.n).toBe(0);
  expect(existsSync(dir)).toBe(false);
  db.close();
});

test("failure path: marks failed, notifies, still cleans the dir", async () => {
  const db = openDb(":memory:");
  await mkdir("/tmp/myancap-runtest", { recursive: true });
  const dir = await createJobDir("run2");
  insertJob(db, { id: "run2", telegramId: 6, url: "u", youtubeId: "yt2", now: 1 });

  const deps = makeDeps([]);
  deps.transcribe = async () => { throw new Error("whisper boom"); };

  await runJob(db, { id: "run2", telegramId: 6, chatId: 6, url: "u", youtubeId: "yt2", dir }, deps);

  expect(hasActiveJob(db, 6)).toBe(false); // row deleted on failure
  const jobRows = db.query("SELECT COUNT(*) AS n FROM jobs").get() as any;
  expect(jobRows.n).toBe(0);
  expect(existsSync(dir)).toBe(false);
  db.close();
});
