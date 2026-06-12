import { afterEach, expect, test } from "bun:test";

process.env.WORK_DIR = "/tmp/myancap-webtest";
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
import { Semaphore } from "../lib/semaphore";
import { handleUpdate, type WebhookDeps } from "./telegram-webhook";
import { cleanupJobDir } from "../pipeline/job";

afterEach(async () => { await cleanupJobDir("/tmp/myancap-webtest"); });

function makeDeps(calls: string[]): WebhookDeps {
  return {
    runJob: async () => { calls.push("runJob"); },
    sendMessage: async (_c: number, m: string) => { calls.push(`msg:${m}`); },
  };
}

let seq = 0;
function upd(text: string, opts: { id?: number; from?: number } = {}) {
  return {
    update_id: opts.id ?? ++seq + 100000,
    message: { chat: { id: 9 }, from: { id: opts.from ?? 9 }, text },
  };
}

function updVideo(opts: { id?: number; from?: number; fileId?: string } = {}) {
  return {
    update_id: opts.id ?? ++seq + 100000,
    message: { chat: { id: 9 }, from: { id: opts.from ?? 9 }, video: { file_id: opts.fileId ?? "VID1" } },
  };
}

function updDoc(mime: string, opts: { id?: number; from?: number } = {}) {
  return {
    update_id: opts.id ?? ++seq + 100000,
    message: { chat: { id: 9 }, from: { id: opts.from ?? 9 }, document: { file_id: "DOC1", mime_type: mime } },
  };
}

test("non-YouTube text → reject message, no job", async () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  await handleUpdate(db, new Semaphore(1), upd("hello there"), makeDeps(calls));
  expect(calls.some((c) => c.startsWith("msg:") && c.includes("YouTube"))).toBe(true);
  expect(calls).not.toContain("runJob");
  db.close();
});

test("duplicate update_id → dropped silently", async () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  const u = upd("https://youtu.be/dQw4w9WgXcQ", { id: 1234 });
  await handleUpdate(db, new Semaphore(1), u, makeDeps(calls));
  calls.length = 0;
  await handleUpdate(db, new Semaphore(1), u, makeDeps(calls)); // same update_id
  expect(calls).toEqual([]);
  db.close();
});

test("repeat link → reprocesses (no cache), enqueues a fresh job", async () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  await handleUpdate(db, new Semaphore(1), upd("https://youtu.be/dQw4w9WgXcQ", { from: 77 }), makeDeps(calls));
  await Bun.sleep(5);
  expect(calls).toContain("runJob"); // no cache short-circuit
  db.close();
});

test("busy user → reject, no second job", async () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  db.query("INSERT INTO jobs (id, telegram_id, created_at) VALUES ('x',9,1)").run();
  await handleUpdate(db, new Semaphore(1), upd("https://youtu.be/dQw4w9WgXcQ", { from: 9 }), makeDeps(calls));
  expect(calls.some((c) => c.includes("⏳"))).toBe(true);
  expect(calls).not.toContain("runJob");
  db.close();
});

test("new link → inserts job, enqueues runJob", async () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  await handleUpdate(db, new Semaphore(1), upd("https://youtu.be/dQw4w9WgXcQ", { from: 50 }), makeDeps(calls));
  await Bun.sleep(5); // let the fire-and-forget sem.run microtask flush
  expect(calls).toContain("runJob");
  db.close();
});

test("native video → enqueues runJob", async () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  await handleUpdate(db, new Semaphore(1), updVideo({ from: 60 }), makeDeps(calls));
  await Bun.sleep(5);
  expect(calls).toContain("runJob");
  db.close();
});

test("video/* document → enqueues runJob", async () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  await handleUpdate(db, new Semaphore(1), updDoc("video/mp4", { from: 61 }), makeDeps(calls));
  await Bun.sleep(5);
  expect(calls).toContain("runJob");
  db.close();
});

test("non-video document → reject, no job", async () => {
  const db = openDb(":memory:");
  const calls: string[] = [];
  await handleUpdate(db, new Semaphore(1), updDoc("application/pdf", { from: 62 }), makeDeps(calls));
  expect(calls).not.toContain("runJob");
  expect(calls.some((c) => c.startsWith("msg:"))).toBe(true);
  db.close();
});
