# Phase 3 — Orchestration + Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (this user does not use subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Phase 2 services into a job pipeline behind the Telegram webhook — temp-dir lifecycle, concurrency cap, the 6-stage orchestrator, the ingress gates, and the Elysia entry point.

**Architecture:** The webhook acks fast and runs work in the background through an in-process semaphore. Each job owns a temp dir cleaned in a `finally`. `run.ts` calls services directly; its happy/sad paths are tested with `mock.module`. The DB is opened once in `index.ts` and threaded into the handler.

**Tech Stack:** Bun, Elysia, TypeScript (strict), `bun test` + `mock.module`.

**Depends on:** Phases 1–2.

---

## Task 1: `pipeline/job.ts`

**Files:**
- Create: `src/pipeline/job.ts`
- Test: `src/pipeline/job.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/pipeline/job.test.ts
import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { newJobId, createJobDir, cleanupJobDir } from "./job";

process.env.WORK_DIR = "/tmp/myancap-test";
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.OPENAI_API_KEY = "o";
process.env.GEMINI_API_KEY = "g";
process.env.AZURE_SPEECH_KEY = "a";

test("newJobId returns a short non-empty id", () => {
  const id = newJobId();
  expect(id.length).toBeGreaterThan(0);
  expect(newJobId()).not.toBe(id);
});

test("createJobDir makes a dir; cleanupJobDir removes it", async () => {
  const dir = await createJobDir("jobtest1");
  expect(existsSync(dir)).toBe(true);
  await cleanupJobDir(dir);
  expect(existsSync(dir)).toBe(false);
});

afterAll(async () => { await cleanupJobDir("/tmp/myancap-test"); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/pipeline/job.test.ts`
Expected: FAIL — `Cannot find module './job'`.

- [ ] **Step 3: Implement `src/pipeline/job.ts`**

```ts
/** Job context + temp-dir lifecycle. */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { getConfig } from "../config";

export type Job = {
  id: string;
  telegramId: number;
  chatId: number;
  url: string;
  youtubeId: string;
  dir: string;
};

export function newJobId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export async function createJobDir(id: string): Promise<string> {
  const dir = join(getConfig().workDir, id);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanupJobDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
```

- [ ] **Step 4: Run to verify green**

Run: `bun test src/pipeline/job.test.ts`
Expected: PASS — 2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/job.ts src/pipeline/job.test.ts
git commit -m "feat: add job context + temp-dir lifecycle"
```

---

## Task 2: `pipeline/queue.ts`

**Files:**
- Create: `src/pipeline/queue.ts`
- Test: `src/pipeline/queue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/pipeline/queue.test.ts
import { expect, test } from "bun:test";
import { Semaphore } from "./queue";

test("max=1 serializes: second task starts only after first releases", async () => {
  const sem = new Semaphore(1);
  const order: string[] = [];
  const slow = sem.run(async () => {
    order.push("a-start");
    await Bun.sleep(20);
    order.push("a-end");
  });
  const fast = sem.run(async () => {
    order.push("b-start");
  });
  await Promise.all([slow, fast]);
  expect(order).toEqual(["a-start", "a-end", "b-start"]);
});

test("run returns the task result and propagates errors", async () => {
  const sem = new Semaphore(2);
  expect(await sem.run(async () => 42)).toBe(42);
  await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/pipeline/queue.test.ts`
Expected: FAIL — `Cannot find module './queue'`.

- [ ] **Step 3: Implement `src/pipeline/queue.ts`**

```ts
/** Minimal in-process counting semaphore. Caps concurrent jobs. */
export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(max: number) {
    this.permits = Math.max(1, max);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the permit directly to a waiter
    else this.permits++;
  }
}
```

- [ ] **Step 4: Run to verify green**

Run: `bun test src/pipeline/queue.test.ts`
Expected: PASS — 2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/queue.ts src/pipeline/queue.test.ts
git commit -m "feat: add in-process concurrency semaphore"
```

---

## Task 3: `pipeline/run.ts`

The 6-stage orchestrator. Calls services directly; tested with `mock.module`.

**Files:**
- Create: `src/pipeline/run.ts`
- Test: `src/pipeline/run.test.ts`

- [ ] **Step 1: Implement `src/pipeline/run.ts`**

```ts
/** Runs the 6 pipeline stages for one job. No recovery: fail → notify → clean. */
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getConfig } from "../config";
import * as youtube from "../services/youtube";
import { transcribe } from "../services/transcribe";
import { translateSrt } from "../services/translate";
import { srtToSpeech } from "../services/srt-tts";
import { wavToAac } from "../services/audio";
import {
  sendVideo,
  sendAudio,
  sendDocument,
  sendMessage,
} from "../services/telegram";
import { slugify } from "../lib/slug";
import { setJobStatus, upsertCachedVideo } from "../services/store";
import { cleanupJobDir, type Job } from "./job";

const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

export async function runJob(db: Database, job: Job): Promise<void> {
  const cfg = getConfig();
  const stage = (s: string, msg: string) => {
    setJobStatus(db, job.id, "running", { stage: s, now: Date.now() });
    void sendMessage(job.chatId, msg).catch(() => {});
  };

  try {
    stage("download", "⬇️ Downloading…");
    const meta = await youtube.probe(job.url);
    if (meta.durationSeconds > cfg.maxVideoSeconds) {
      const max = Math.round(cfg.maxVideoSeconds / 60);
      throw new Error(`Video too long (max ${max} min)`);
    }
    const { videoPath, audioPath } = await youtube.download(job.url, job.dir);

    stage("transcribe", "📝 Transcribing…");
    const enSrt = await transcribe(audioPath);

    stage("translate", "🌐 Translating…");
    const mySrt = await translateSrt(enSrt);

    stage("tts", "🎙️ Dubbing…");
    const wav = await srtToSpeech(mySrt, { voice: cfg.ttsVoice });
    const wavPath = join(job.dir, "dub.wav");
    const aacPath = join(job.dir, "dub.m4a");
    await Bun.write(wavPath, wav);
    await wavToAac(wavPath, aacPath);

    stage("send", "📤 Sending…");
    const base = slugify(meta.title, job.youtubeId);

    const videoBytes = new Uint8Array(await Bun.file(videoPath).arrayBuffer());
    if (videoBytes.byteLength > VIDEO_MAX_BYTES) {
      throw new Error("Video too large (>50 MB)");
    }
    const videoFileId = await sendVideo(job.chatId, videoBytes, `${base}.mp4`);
    const srtFileId = await sendDocument(
      job.chatId,
      new TextEncoder().encode(mySrt),
      `${base}.srt`,
      "application/x-subrip",
    );
    const aacBytes = new Uint8Array(await Bun.file(aacPath).arrayBuffer());
    const audioFileId = await sendAudio(job.chatId, aacBytes, `${base}.m4a`);

    upsertCachedVideo(db, {
      youtubeId: job.youtubeId,
      voice: cfg.ttsVoice,
      videoFileId,
      srtFileId,
      audioFileId,
      title: meta.title,
      duration: Math.round(meta.durationSeconds),
      now: Date.now(),
    });
    setJobStatus(db, job.id, "done", { now: Date.now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setJobStatus(db, job.id, "failed", { error: msg, now: Date.now() });
    await sendMessage(job.chatId, `❌ ${msg}`).catch(() => {});
  } finally {
    await cleanupJobDir(job.dir);
  }
}
```

- [ ] **Step 2: Write the happy-path + failure tests (mock.module)**

```ts
// src/pipeline/run.test.ts
import { afterEach, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

process.env.WORK_DIR = "/tmp/myancap-runtest";
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.OPENAI_API_KEY = "o";
process.env.GEMINI_API_KEY = "g";
process.env.AZURE_SPEECH_KEY = "a";

const sent: string[] = [];
mock.module("../services/youtube", () => ({
  probe: async () => ({ durationSeconds: 100, title: "My Clip" }),
  download: async (_u: string, dir: string) => {
    await Bun.write(`${dir}/video.mp4`, "VIDEODATA");
    return { videoPath: `${dir}/video.mp4`, audioPath: `${dir}/audio.mp3` };
  },
}));
mock.module("../services/transcribe", () => ({ transcribe: async () => "1\n00:00:01,000 --> 00:00:02,000\nHi\n" }));
mock.module("../services/translate", () => ({ translateSrt: async () => "1\n00:00:01,000 --> 00:00:02,000\nမင်္ဂလာ\n" }));
mock.module("../services/srt-tts", () => ({ srtToSpeech: async () => new Uint8Array([1, 2, 3]) }));
mock.module("../services/audio", () => ({ wavToAac: async (_i: string, o: string) => { await Bun.write(o, "AAC"); } }));
mock.module("../services/telegram", () => ({
  sendVideo: async () => { sent.push("video"); return "VF"; },
  sendDocument: async () => { sent.push("doc"); return "SF"; },
  sendAudio: async () => { sent.push("audio"); return "AF"; },
  sendMessage: async () => {},
}));

import { openDb } from "../lib/db";
import { insertJob, getCachedVideo, hasActiveJob } from "../services/store";
import { createJobDir, cleanupJobDir } from "./job";
import { runJob } from "./run";

afterEach(async () => { await cleanupJobDir("/tmp/myancap-runtest"); });

test("happy path: sends 3 files, caches result, clears job, cleans dir", async () => {
  const db = openDb(":memory:");
  await mkdir("/tmp/myancap-runtest", { recursive: true });
  const dir = await createJobDir("run1");
  insertJob(db, { id: "run1", telegramId: 5, url: "u", youtubeId: "ytid", now: 1 });

  await runJob(db, { id: "run1", telegramId: 5, chatId: 5, url: "u", youtubeId: "ytid", dir });

  expect(sent).toEqual(["video", "doc", "audio"]);
  const cached = getCachedVideo(db, "ytid", "my-MM-ThihaNeural");
  expect(cached?.videoFileId).toBe("VF");
  expect(hasActiveJob(db, 5)).toBe(false);
  expect(existsSync(dir)).toBe(false);
  db.close();
});
```

- [ ] **Step 3: Run to verify green**

Run: `bun test src/pipeline/run.test.ts`
Expected: PASS — 1 pass (3 files sent in order, cache written, dir gone).

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/run.ts src/pipeline/run.test.ts
git commit -m "feat: add 6-stage pipeline orchestrator"
```

---

## Task 4: `handlers/telegram-webhook.ts` + cache-resend telegram helpers

Replace the legacy SRT-text handler with the YouTube-link ingress gates. Also add
the by-`file_id` resend helpers the cache path needs.

**Files:**
- Modify: `src/services/telegram.ts` (add `sendVideoById`, `sendAudioById`, `sendDocumentById`)
- Rewrite: `src/handlers/telegram-webhook.ts`
- Test: `src/handlers/telegram-webhook.test.ts`

- [ ] **Step 1: Add by-file-id resend helpers to `src/services/telegram.ts`**

```ts
/** Re-send an already-uploaded file by its file_id (no re-upload). */
async function sendById(
  method: string,
  key: "video" | "audio" | "document",
  chatId: number,
  fileId: string,
): Promise<void> {
  const res = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, [key]: fileId }),
  });
  if (!res.ok) throw new Error(`${method} (by id) failed: ${res.status} ${await res.text()}`);
}

export const sendVideoById = (chatId: number, fileId: string) => sendById("sendVideo", "video", chatId, fileId);
export const sendAudioById = (chatId: number, fileId: string) => sendById("sendAudio", "audio", chatId, fileId);
export const sendDocumentById = (chatId: number, fileId: string) => sendById("sendDocument", "document", chatId, fileId);
```

- [ ] **Step 2: Write the failing tests (in-memory db, stub telegram + run)**

```ts
// src/handlers/telegram-webhook.test.ts
import { afterEach, expect, mock, test } from "bun:test";

process.env.WORK_DIR = "/tmp/myancap-webtest";
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.OPENAI_API_KEY = "o";
process.env.GEMINI_API_KEY = "g";
process.env.AZURE_SPEECH_KEY = "a";

const calls: string[] = [];
mock.module("../services/telegram", () => ({
  sendMessage: async (_c: number, m: string) => { calls.push(`msg:${m}`); },
  sendVideoById: async () => { calls.push("resend:video"); },
  sendAudioById: async () => { calls.push("resend:audio"); },
  sendDocumentById: async () => { calls.push("resend:doc"); },
}));
mock.module("../pipeline/run", () => ({ runJob: async () => { calls.push("runJob"); } }));

import { openDb } from "../lib/db";
import { upsertCachedVideo, hasActiveJob } from "../services/store";
import { Semaphore } from "../pipeline/queue";
import { handleUpdate } from "./telegram-webhook";
import { cleanupJobDir } from "../pipeline/job";

afterEach(async () => { calls.length = 0; await cleanupJobDir("/tmp/myancap-webtest"); });

function upd(text: string, opts: { id?: number; from?: number } = {}) {
  return { update_id: opts.id ?? Math.floor(Math.random() * 1e9), message: { chat: { id: 9 }, from: { id: opts.from ?? 9 }, text } };
}

test("non-YouTube text → reject message, no job", async () => {
  const db = openDb(":memory:");
  await handleUpdate(db, new Semaphore(1), upd("hello there"));
  expect(calls.some((c) => c.startsWith("msg:") && c.includes("YouTube"))).toBe(true);
  expect(calls).not.toContain("runJob");
  db.close();
});

test("duplicate update_id → dropped silently", async () => {
  const db = openDb(":memory:");
  const u = upd("https://youtu.be/dQw4w9WgXcQ", { id: 1234 });
  await handleUpdate(db, new Semaphore(1), u);
  calls.length = 0;
  await handleUpdate(db, new Semaphore(1), u); // same update_id
  expect(calls).toEqual([]);
  db.close();
});

test("cache hit → resends 3 files, no job", async () => {
  const db = openDb(":memory:");
  upsertCachedVideo(db, {
    youtubeId: "dQw4w9WgXcQ", voice: "my-MM-ThihaNeural",
    videoFileId: "VF", srtFileId: "SF", audioFileId: "AF",
    title: "t", duration: 10, now: 1,
  });
  await handleUpdate(db, new Semaphore(1), upd("https://youtu.be/dQw4w9WgXcQ"));
  expect(calls).toContain("resend:video");
  expect(calls).toContain("resend:doc");
  expect(calls).toContain("resend:audio");
  expect(calls).not.toContain("runJob");
  db.close();
});

test("busy user → reject, no second job", async () => {
  const db = openDb(":memory:");
  // seed an active job for user 9
  db.query("INSERT INTO jobs (id, telegram_id, url, youtube_id, status, created_at, updated_at) VALUES ('x',9,'u','y','running',1,1)").run();
  await handleUpdate(db, new Semaphore(1), upd("https://youtu.be/dQw4w9WgXcQ", { from: 9 }));
  expect(calls.some((c) => c.includes("in progress"))).toBe(true);
  expect(calls).not.toContain("runJob");
  db.close();
});

test("new link → inserts job, enqueues runJob", async () => {
  const db = openDb(":memory:");
  await handleUpdate(db, new Semaphore(1), upd("https://youtu.be/dQw4w9WgXcQ", { from: 50 }));
  // allow the fire-and-forget sem.run microtask to flush
  await Bun.sleep(5);
  expect(calls).toContain("runJob");
  db.close();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test src/handlers/telegram-webhook.test.ts`
Expected: FAIL — current handler exports the old `handleUpdate(update)` shape.

- [ ] **Step 4: Rewrite `src/handlers/telegram-webhook.ts`**

```ts
/** Telegram webhook ingress: gate the update, then enqueue a pipeline job. */
import type { Database } from "bun:sqlite";
import { getConfig } from "../config";
import { extractYouTubeId } from "../services/youtube";
import {
  sendMessage,
  sendVideoById,
  sendAudioById,
  sendDocumentById,
} from "../services/telegram";
import {
  markUpdateProcessed,
  getCachedVideo,
  hasActiveJob,
  insertJob,
} from "../services/store";
import { newJobId, createJobDir, type Job } from "../pipeline/job";
import type { Semaphore } from "../pipeline/queue";
import { runJob } from "../pipeline/run";

type Update = {
  update_id?: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
};

/** Verify the optional Telegram secret-token header. */
export function verifySecret(header: string | undefined): boolean {
  const secret = getConfig().telegramWebhookSecret;
  if (!secret) return true;
  return header === secret;
}

/** Handle one webhook update. Acks fast; heavy work runs in the background. */
export async function handleUpdate(
  db: Database,
  sem: Semaphore,
  update: Update,
): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const telegramId = msg.from?.id ?? chatId;
  const now = Date.now();

  // Gate 2: dedup Telegram retries.
  if (update.update_id !== undefined && !markUpdateProcessed(db, update.update_id, now)) {
    return;
  }

  // Gate 3: must be a YouTube link.
  const youtubeId = extractYouTubeId(msg.text);
  if (!youtubeId) {
    await sendMessage(chatId, "Send me a YouTube link.").catch(() => {});
    return;
  }

  const cfg = getConfig();

  // Gate 4: cache hit → resend the three files, no job.
  const cached = getCachedVideo(db, youtubeId, cfg.ttsVoice);
  if (cached) {
    await sendMessage(chatId, "✅ Sent (cached)").catch(() => {});
    await sendVideoById(chatId, cached.videoFileId).catch(() => {});
    await sendDocumentById(chatId, cached.srtFileId).catch(() => {});
    await sendAudioById(chatId, cached.audioFileId).catch(() => {});
    return;
  }

  // Gate 5: one active job per user.
  if (hasActiveJob(db, telegramId)) {
    await sendMessage(chatId, "⏳ You already have a video in progress — wait for it to finish.").catch(() => {});
    return;
  }

  // Gate 6: enqueue.
  const id = newJobId();
  const url = `https://www.youtube.com/watch?v=${youtubeId}`;
  insertJob(db, { id, telegramId, url, youtubeId, now });
  const dir = await createJobDir(id);
  await sendMessage(chatId, "🎬 Working on it…").catch(() => {});

  const job: Job = { id, telegramId, chatId, url, youtubeId, dir };
  void sem.run(() => runJob(db, job));
}
```

- [ ] **Step 5: Run to verify green**

Run: `bun test src/handlers/telegram-webhook.test.ts && bun test`
Expected: PASS — 5 webhook tests pass; whole suite green.

- [ ] **Step 6: Commit**

```bash
git add src/services/telegram.ts src/handlers/telegram-webhook.ts src/handlers/telegram-webhook.test.ts
git commit -m "feat: rework webhook to youtube-link ingress gates"
```

---

## Task 5: `index.ts`

**Files:**
- Rewrite: `src/index.ts`

- [ ] **Step 1: Rewrite `src/index.ts`**

```ts
import { Elysia } from "elysia";
import { getConfig } from "./config";
import { openDb } from "./lib/db";
import { Semaphore } from "./pipeline/queue";
import { handleUpdate, verifySecret } from "./handlers/telegram-webhook";

const cfg = getConfig();
const db = openDb(cfg.databasePath);
const sem = new Semaphore(cfg.maxConcurrentJobs);

const app = new Elysia()
  .get("/", () => "MyanCap up")
  .post("/telegram/webhook", ({ body, headers, set }) => {
    if (!verifySecret(headers["x-telegram-bot-api-secret-token"])) {
      set.status = 401;
      return { ok: false };
    }
    // Fire-and-forget: ack immediately, process in the background.
    void handleUpdate(db, sem, body as any);
    return { ok: true };
  })
  .listen(cfg.port);

console.log(`🦊 MyanCap on :${app.server?.port}`);
```

- [ ] **Step 2: Boot it (requires a real `.env`)**

For a local (non-Docker) boot, point the DB at a writable local path — the
default `/data/myancap.db` only exists inside the container. In `.env` set:
`DATABASE_PATH=./myancap.db`. Also add `*.db*` to `.gitignore` so the local DB
isn't committed.

Run: `bun run src/index.ts`
Expected: prints `🦊 MyanCap on :3000` and stays up. (If env is missing, it
fail-fasts with a clear "Invalid configuration" error — that is correct.)
Stop with Ctrl-C.

- [ ] **Step 3: Verify the health route**

In another terminal: `curl -s localhost:3000/`
Expected: `MyanCap up`.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire webhook + db + queue into the entrypoint"
```

---

## Phase 3 Done When

- `bun test` is green (job, queue, run, webhook, plus Phases 1–2).
- `bun run src/index.ts` boots and `/` responds `MyanCap up`.
- The old `/tts` SRT-text flow is gone; the entrypoint serves the webhook.

Next: **Phase 4 — Containerization** (`2026-06-09-phase-4-docker.md`).
