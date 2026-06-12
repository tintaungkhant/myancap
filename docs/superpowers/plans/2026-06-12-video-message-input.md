# Video Message Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept Telegram video messages (native `video` and `video/*` documents) as a job source alongside YouTube links, returning English srt + Myanmar srt + Myanmar voice-over mp3 (no video sent back for video-message jobs).

**Architecture:** Add a discriminated-union `source` to the `Job` (`youtube` | `telegram_video`). Pipeline stage 1 (acquisition) branches on `source.kind`; stages 2–6 are shared. The video file is sent back only for the youtube source. The webhook classifies each update into a source or rejects it. The `jobs` table is slimmed to the lock columns it actually uses.

**Tech Stack:** Bun, Elysia, TypeScript (strict), bun:sqlite, `ffprobe` (ships with ffmpeg), Telegram Bot API over `fetch`.

---

## File Structure

- `src/services/audio.ts` (modify) — add `ffprobeArgs` + `probeDuration`.
- `src/services/audio.test.ts` (modify) — add `ffprobeArgs` test.
- `src/services/telegram.ts` (modify) — add `getFile` + `downloadFile`.
- `src/services/telegram.test.ts` (modify) — add `getFile`/`downloadFile` tests.
- `src/pipeline/job.ts` (modify) — `Job.source` union, drop `url`/`youtubeId`.
- `src/lib/db.ts` (modify) — slim `jobs` table.
- `src/services/store.ts` (modify) — slim `NewJob` + `insertJob`.
- `src/services/store.test.ts` (modify) — slim insert calls.
- `src/handlers/telegram-webhook.test.ts` (modify) — update fixtures, busy-user insert.
- `src/pipeline/run.ts` (modify) — branch acquisition, conditional video send, new deps.
- `src/pipeline/run.test.ts` (modify) — new Job/deps shapes + telegram-branch tests.
- `src/handlers/telegram-webhook.ts` (modify) — classify source, enqueue.

Order is bottom-up: leaf services first, then job/db/store, then run, then webhook. Each task ends green and committed.

---

## Task 1: ffprobe duration in `audio.ts`

**Files:**
- Modify: `src/services/audio.ts`
- Test: `src/services/audio.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/services/audio.test.ts` (import line becomes `import { mp3Args, extractAudioArgs, ffprobeArgs } from "./audio";`):

```ts
test("ffprobeArgs asks ffprobe for the format duration only", () => {
  const a = ffprobeArgs("/d/video.mp4");
  expect(a).toContain("/d/video.mp4");
  expect(a.join(" ")).toContain("format=duration");
  expect(a.join(" ")).toContain("-v error");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/audio.test.ts`
Expected: FAIL — `ffprobeArgs` is not exported / not a function.

- [ ] **Step 3: Add `ffprobeArgs` + `probeDuration` to `src/services/audio.ts`**

Add after `extractAudioArgs` (the existing `runFfmpeg` stays as-is; `probeDuration` shells `ffprobe` separately because it needs stdout):

```ts
/** ffprobe args: print only the container duration (seconds), bare number. */
export function ffprobeArgs(path: string): string[] {
  return [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nokey=1:noprint_wrappers=1",
    path,
  ];
}

/** Read a media file's duration in seconds via ffprobe. */
export async function probeDuration(path: string): Promise<number> {
  const proc = Bun.spawn(["ffprobe", ...ffprobeArgs(path)], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ffprobe failed (${code}): ${err}`);
  const seconds = Number(out.trim());
  if (!Number.isFinite(seconds)) {
    throw new Error(`ffprobe: bad duration "${out.trim()}"`);
  }
  return seconds;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/audio.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/audio.ts src/services/audio.test.ts
git commit -m "feat: add ffprobe-based probeDuration to audio service"
```

---

## Task 2: Telegram file download (`getFile` + `downloadFile`)

**Files:**
- Modify: `src/services/telegram.ts`
- Test: `src/services/telegram.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/services/telegram.test.ts`:

```ts
test("getFile returns file_path and file_size", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ ok: true, result: { file_path: "videos/file_1.mp4", file_size: 1234 } }),
      { status: 200 },
    )) as any;

  const { getFile } = await import("./telegram");
  const f = await getFile("FILE_ID");
  expect(f.filePath).toBe("videos/file_1.mp4");
  expect(f.fileSize).toBe(1234);
});

test("downloadFile writes the response bytes to dest", async () => {
  globalThis.fetch = (async (url: any) => {
    expect(String(url)).toBe("https://api.telegram.org/file/botBOT123/videos/file_1.mp4");
    return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
  }) as any;

  const { downloadFile } = await import("./telegram");
  const dest = "/tmp/myancap-dl-test.bin";
  await downloadFile("videos/file_1.mp4", dest);
  const bytes = new Uint8Array(await Bun.file(dest).arrayBuffer());
  expect(Array.from(bytes)).toEqual([9, 8, 7]);
});

test("downloadFile throws on non-ok", async () => {
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as any;
  const { downloadFile } = await import("./telegram");
  await expect(downloadFile("x/y.mp4", "/tmp/myancap-dl-test2.bin")).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/telegram.test.ts`
Expected: FAIL — `getFile`/`downloadFile` not exported.

- [ ] **Step 3: Add `getFile` + `downloadFile` to `src/services/telegram.ts`**

Add after `sendDocument` (reuse the existing `token()` and `apiUrl()` helpers; add a `fileUrl` helper for the download host):

```ts
/** Build the file-download URL (different host path than the API methods). */
function fileUrl(filePath: string): string {
  return `https://api.telegram.org/file/bot${token()}/${filePath}`;
}

/** Resolve a file_id to a downloadable file_path (+ size if Telegram reports it). */
export async function getFile(fileId: string): Promise<{ filePath: string; fileSize?: number }> {
  const res = await fetch(apiUrl("getFile"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) {
    throw new Error(`getFile failed: ${res.status} ${await res.text()}`);
  }
  const body: any = await res.json();
  const filePath = body?.result?.file_path;
  if (typeof filePath !== "string") {
    throw new Error("getFile: no file_path in response");
  }
  const fileSize = body?.result?.file_size;
  return { filePath, fileSize: typeof fileSize === "number" ? fileSize : undefined };
}

/** Download a Telegram file (by file_path from getFile) to a local path. */
export async function downloadFile(filePath: string, destPath: string): Promise<void> {
  const res = await fetch(fileUrl(filePath));
  if (!res.ok) {
    throw new Error(`downloadFile failed: ${res.status} ${await res.text()}`);
  }
  await Bun.write(destPath, await res.arrayBuffer());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/telegram.ts src/services/telegram.test.ts
git commit -m "feat: add getFile + downloadFile to telegram client"
```

---

## Task 3: Slim the `jobs` table (db + store)

**Files:**
- Modify: `src/lib/db.ts`
- Modify: `src/services/store.ts`
- Test: `src/services/store.test.ts`

The `url`/`youtube_id` columns are write-only (never `SELECT`ed; only `telegram_id` drives the lock). Remove them.

- [ ] **Step 1: Update the failing test first**

In `src/services/store.test.ts`, change the two `insertJob` calls to the slim shape (drop `url`/`youtubeId`):

```ts
insertJob(db, { id: "j1", telegramId: 42, now });
```

(both occurrences — lines in "insertJob then hasActiveJob..." and "hasActiveJob is per-user").

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/store.test.ts`
Expected: FAIL — TS error: object missing `url`/`youtubeId` (current `NewJob` still requires them).

- [ ] **Step 3: Slim `NewJob` + `insertJob` in `src/services/store.ts`**

```ts
export type NewJob = {
  id: string;
  telegramId: number;
  now: number; // unix ms
};

export function insertJob(db: Database, job: NewJob): void {
  db.query(
    `INSERT INTO jobs (id, telegram_id, created_at) VALUES (?, ?, ?)`,
  ).run(job.id, job.telegramId, job.now);
}
```

- [ ] **Step 4: Slim the schema in `src/lib/db.ts`**

Replace the `CREATE TABLE jobs (...)` block with:

```sql
CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
```

(Keep the `DROP TABLE IF EXISTS jobs;` line above it and the `processed_updates` table unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/services/store.test.ts src/lib/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db.ts src/services/store.ts src/services/store.test.ts
git commit -m "refactor: drop write-only url/youtube_id from jobs table"
```

---

## Task 4: `Job.source` discriminated union

**Files:**
- Modify: `src/pipeline/job.ts`

This is a type change consumed by Tasks 5–6; its tests live there. `job.test.ts` only touches `newJobId`/`createJobDir`/`cleanupJobDir`, so it needs no change.

- [ ] **Step 1: Update `Job` in `src/pipeline/job.ts`**

Replace the `Job` type:

```ts
export type YoutubeSource = { kind: "youtube"; url: string; youtubeId: string };
export type TelegramVideoSource = { kind: "telegram_video"; fileId: string };

export type Job = {
  id: string;
  telegramId: number;
  chatId: number;
  dir: string;
  source: YoutubeSource | TelegramVideoSource;
};
```

- [ ] **Step 2: Verify it type-checks in isolation**

Run: `bun test src/pipeline/job.test.ts`
Expected: PASS (job.test.ts does not reference the removed fields).

Note: `run.ts`, `run.test.ts`, and `telegram-webhook.ts` will now have type errors — they are fixed in Tasks 5–6. Do not run the full suite yet.

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/job.ts
git commit -m "feat: add source discriminated union to Job type"
```

---

## Task 5: Branch acquisition in `run.ts`

**Files:**
- Modify: `src/pipeline/run.ts`
- Test: `src/pipeline/run.test.ts`

- [ ] **Step 1: Rewrite the run.test.ts fixtures + tests**

Replace the whole body of `src/pipeline/run.test.ts` below the env lines with:

```ts
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
    sendVideo: async () => { sent.push("video"); return "VF"; },
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

test("youtube happy path: sends 4 files, clears job, cleans dir", async () => {
  const db = openDb(":memory:");
  await mkdir("/tmp/myancap-runtest", { recursive: true });
  const dir = await createJobDir("run1");
  insertJob(db, { id: "run1", telegramId: 5, now: 1 });

  const sent: string[] = [];
  const job: Job = { id: "run1", telegramId: 5, chatId: 5, dir, source: ytSource };
  await runJob(db, job, makeDeps(sent));

  expect(sent).toEqual(["video", "my", "en", "audio"]);
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

test("youtube oversized video file: skips video, warns, still sends srt + audio", async () => {
  const db = openDb(":memory:");
  await mkdir("/tmp/myancap-runtest", { recursive: true });
  const dir = await createJobDir("run3");
  insertJob(db, { id: "run3", telegramId: 7, now: 1 });

  const sent: string[] = [];
  const msgs: string[] = [];
  const deps = makeDeps(sent);
  deps.download = async (_u: string, d: string) => {
    await Bun.write(`${d}/video.mp4`, new Uint8Array(51 * 1024 * 1024)); // >50 MB
    return { videoPath: `${d}/video.mp4` };
  };
  deps.sendMessage = async (_c: number, m: string) => { msgs.push(m); };

  const job: Job = { id: "run3", telegramId: 7, chatId: 7, dir, source: ytSource };
  await runJob(db, job, deps);

  expect(sent).toEqual(["my", "en", "audio"]); // video skipped
  expect(msgs.some((m) => m.includes("ကြီးလွန်း"))).toBe(true);
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

  expect(hasActiveJob(db, 6)).toBe(false);
  const jobRows = db.query("SELECT COUNT(*) AS n FROM jobs").get() as any;
  expect(jobRows.n).toBe(0);
  expect(existsSync(dir)).toBe(false);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/pipeline/run.test.ts`
Expected: FAIL — `RunDeps` has no `getFile`/`downloadFile`/`probeDuration`; `runJob` still reads `job.url`.

- [ ] **Step 3: Rewrite `src/pipeline/run.ts`**

Update imports, `RunDeps`, `defaultDeps`, and the acquisition stage. Add the telegram client + probeDuration to deps:

Imports — add to the existing import lines:
```ts
import { getFile, downloadFile } from "../services/telegram";
import { wavToMp3, extractAudio, probeDuration } from "../services/audio";
```
(Replace the existing `import { wavToMp3, extractAudio } from "../services/audio";` line with the one above.)

Add a constant near `VIDEO_MAX_BYTES`:
```ts
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024; // Telegram Bot API getFile cap
```

Extend `RunDeps` and `defaultDeps`:
```ts
export type RunDeps = {
  probe: typeof youtube.probe;
  download: typeof youtube.download;
  getFile: typeof getFile;
  downloadFile: typeof downloadFile;
  probeDuration: typeof probeDuration;
  extractAudio: typeof extractAudio;
  transcribe: typeof transcribe;
  translateSrt: typeof translateSrt;
  srtToSpeech: typeof srtToSpeech;
  wavToMp3: typeof wavToMp3;
  sendVideo: typeof sendVideo;
  sendDocument: typeof sendDocument;
  sendAudio: typeof sendAudio;
  sendMessage: typeof sendMessage;
};

const defaultDeps: RunDeps = {
  probe: youtube.probe,
  download: youtube.download,
  getFile,
  downloadFile,
  probeDuration,
  extractAudio,
  transcribe,
  translateSrt,
  srtToSpeech,
  wavToMp3,
  sendVideo,
  sendDocument,
  sendAudio,
  sendMessage,
};
```

Replace the acquisition block (the current lines from `stage("⬇️ video download နေသည်");` through `await deps.extractAudio(videoPath, audioPath);`) with a branch that yields `videoPath`, `base` (slug), and `sendVideoBack`:

```ts
    const videoPath = join(job.dir, "video.mp4");
    let base: string;
    let sendVideoBack: boolean;

    if (job.source.kind === "youtube") {
      stage("⬇️ video download နေသည်");
      const meta = await deps.probe(job.source.url);
      if (meta.durationSeconds > cfg.maxVideoSeconds) {
        const max = Math.round(cfg.maxVideoSeconds / 60);
        throw new Error(`Video too long (max ${max} min)`);
      }
      await deps.download(job.source.url, job.dir);
      base = slugify(meta.title, job.source.youtubeId);
      sendVideoBack = true;
    } else {
      stage("⬇️ video download နေသည်");
      const file = await deps.getFile(job.source.fileId);
      if (file.fileSize !== undefined && file.fileSize > DOWNLOAD_MAX_BYTES) {
        throw new Error("Video too big (max 20 MB)");
      }
      await deps.downloadFile(file.filePath, videoPath);
      const durationSeconds = await deps.probeDuration(videoPath);
      if (durationSeconds > cfg.maxVideoSeconds) {
        const max = Math.round(cfg.maxVideoSeconds / 60);
        throw new Error(`Video too long (max ${max} min)`);
      }
      base = `video_${job.id}`;
      sendVideoBack = false;
    }

    const audioPath = join(job.dir, "audio.mp3");
    await deps.extractAudio(videoPath, audioPath);
```

Then in the send section, remove the old `const base = slugify(meta.title, job.youtubeId);` line (now computed above), and gate the video upload on `sendVideoBack`. Replace the video block:

```ts
    const videoFile = Bun.file(videoPath);
    if (!sendVideoBack) {
      // video-message job: user already has the video; nothing to send back.
    } else if (videoFile.size > VIDEO_MAX_BYTES) {
      await deps
        .sendMessage(job.chatId, "⚠️ video ကြီးလွန်းလို့ မပို့နိုင်ပါ — စာတန်းနဲ့ မြန်မာသံ ဖိုင်တွေပဲ ပို့ပါမယ်")
        .catch(() => {});
    } else {
      const videoBytes = new Uint8Array(await videoFile.arrayBuffer());
      await send("sendVideo", () => deps.sendVideo(job.chatId, videoBytes, `${base}.mp4`));
    }
```

(The `my.srt`, `en.srt`, and `mp3` sends below stay exactly as they are.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/pipeline/run.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/run.ts src/pipeline/run.test.ts
git commit -m "feat: branch pipeline acquisition on job source (youtube vs telegram video)"
```

---

## Task 6: Webhook classification

**Files:**
- Modify: `src/handlers/telegram-webhook.ts`
- Test: `src/handlers/telegram-webhook.test.ts`

- [ ] **Step 1: Update + add webhook tests**

In `src/handlers/telegram-webhook.test.ts`:

(a) Fix the busy-user `INSERT` (slim schema) — change the line to:
```ts
db.query("INSERT INTO jobs (id, telegram_id, created_at) VALUES ('x',9,1)").run();
```

(b) Add a helper for non-text updates and new tests (place after the existing `upd` helper):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/handlers/telegram-webhook.test.ts`
Expected: FAIL — video/document updates currently hit `if (!msg?.text) return;` (silently dropped, no `runJob`); also TS may flag the `Update` type lacking `video`/`document`.

- [ ] **Step 3: Rewrite the classification in `src/handlers/telegram-webhook.ts`**

Update imports (add `Job`/source types are inferred via the `source` object literal; no new import needed beyond `type Job`). Replace the `Update` type:

```ts
type Update = {
  update_id?: number;
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
    video?: { file_id: string; file_size?: number };
    document?: { file_id: string; file_size?: number; mime_type?: string };
  };
};
```

Replace the body from `if (!msg?.text) return;` down through the enqueue, with:

```ts
  if (!msg) return;

  const chatId = msg.chat.id;
  const telegramId = msg.from?.id ?? chatId;
  const now = Date.now();

  // Gate 1: dedup Telegram retries.
  if (update.update_id !== undefined && !markUpdateProcessed(db, update.update_id, now)) {
    return;
  }

  // Gate 2: classify the source. YouTube link, native video, or a video/* document.
  let source: Job["source"] | null = null;
  const youtubeId = msg.text ? extractYouTubeId(msg.text) : null;
  if (youtubeId) {
    source = { kind: "youtube", url: `https://www.youtube.com/watch?v=${youtubeId}`, youtubeId };
  } else if (msg.video) {
    source = { kind: "telegram_video", fileId: msg.video.file_id };
  } else if (msg.document?.mime_type?.startsWith("video/")) {
    source = { kind: "telegram_video", fileId: msg.document.file_id };
  }
  if (!source) {
    await deps.sendMessage(chatId, "❌ YouTube link (သို့) video ပို့ပါ").catch(() => {});
    return;
  }

  // Gate 3: one active job per user.
  if (hasActiveJob(db, telegramId)) {
    await deps.sendMessage(chatId, "⏳ ယခင် video ပြီးအောင် စောင့်ပါ").catch(() => {});
    return;
  }

  // Enqueue.
  const id = newJobId();
  insertJob(db, { id, telegramId, now });
  const dir = await createJobDir(id);
  await deps.sendMessage(chatId, "🎬 လုပ်ဆောင်နေသည်").catch(() => {});

  const job: Job = { id, telegramId, chatId, dir, source };
  void sem.run(() => deps.runJob(db, job));
```

Note the existing reject test asserts the message contains `"YouTube"` — the new reject string still contains "YouTube", so that test stays green.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/handlers/telegram-webhook.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `bun test && bunx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/telegram-webhook.ts src/handlers/telegram-webhook.test.ts
git commit -m "feat: accept video messages (native + video document) as a job source"
```

---

## Task 7: Update docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/PIPELINE.md` (if it enumerates inputs/outputs)

- [ ] **Step 1: Update the "What this is" + pipeline summary**

In `CLAUDE.md`, note the two input types: a YouTube link returns four files; a video message returns three (en.srt, my.srt, dub.mp3 — no video back, 20 MB Bot-API download cap). Adjust the pipeline diagram intro to mention the two sources. Keep prose normal (not caveman).

- [ ] **Step 2: Sync `docs/PIPELINE.md`** if it lists the ingress/inputs or the "4 files" output — add the video-message source and its 3-file output + 20 MB cap.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/PIPELINE.md
git commit -m "docs: document video-message input source"
```

---

## Self-Review Notes

- **Spec coverage:** accepted types (Task 6: video + video/* document, video_note excluded) ✓; 20 MB reject (Task 5 oversize test + run.ts `DOWNLOAD_MAX_BYTES`) ✓; generic `video_<jobid>` filename (Task 5 run.ts `base`) ✓; discriminated union (Task 4) ✓; slim jobs table (Task 3) ✓; getFile/downloadFile (Task 2) ✓; probeDuration (Task 1) ✓; conditional video send-back (Task 5) ✓; webhook classification + reject (Task 6) ✓; tests (every task) ✓; docs (Task 7) ✓.
- **Type consistency:** `RunDeps` keys (`getFile`, `downloadFile`, `probeDuration`) match the telegram/audio exports; `Job["source"]` union (`youtube`/`telegram_video`) used identically in job.ts, run.ts, webhook; `NewJob` slim shape (`id`/`telegramId`/`now`) consistent in store.ts + all `insertJob` callers; `sendVideoBack` boolean naming consistent.
- **No placeholders:** every code/test step shows full content.
