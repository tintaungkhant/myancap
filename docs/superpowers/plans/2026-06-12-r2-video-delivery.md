# R2 Video Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For YouTube jobs, upload the downloaded video to Cloudflare R2 and reply with the public link instead of sending the file through Telegram — removing the 50 MB cap and lifting quality to 1080p.

**Architecture:** A new stateless `r2.ts` service uploads a local mp4 to R2 via `aws4fetch` (SigV4, streamed PUT) and returns its public URL. The pipeline's YouTube branch uploads after download and sends a link message; the `telegram_video` branch is untouched. Object expiry is an R2 bucket lifecycle rule (ops), so the app tracks nothing.

**Tech Stack:** Bun, TypeScript (strict), `aws4fetch` (SigV4 over `fetch`), Cloudflare R2 (S3 API), bun:sqlite, `yt-dlp`.

---

## File Structure

- `package.json` (modify) — add `aws4fetch`.
- `src/config.ts` (modify) — add R2 vars; `maxVideoHeight` default 480→1080.
- `src/config.test.ts` (modify) — R2 vars + 1080 assertion.
- `src/services/r2.ts` (create) — `objectKey` + `uploadVideo`.
- `src/services/r2.test.ts` (create) — unit tests.
- `src/pipeline/run.ts` (modify) — upload + link instead of `sendVideo`.
- `src/pipeline/run.test.ts` (modify) — link assertions + R2 env.
- `src/handlers/telegram-webhook.test.ts`, `src/pipeline/job.test.ts`, `src/services/transcribe.test.ts` (modify) — add R2 env vars (these boot real config).
- `src/services/youtube.test.ts` (modify) — assert `height<=1080`.
- `src/services/telegram.ts` (modify) — remove dead `sendVideo`.
- `src/services/telegram.test.ts` (modify) — remove its test.
- `CLAUDE.md`, `docs/PIPELINE.md`, `docs/SETUP.md` (modify) — docs.

A shared test env snippet (used in several tasks) — the five required R2 vars:

```ts
process.env.R2_ENDPOINT = "https://acc.r2.cloudflarestorage.com";
process.env.R2_ACCESS_KEY_ID = "rk";
process.env.R2_SECRET_ACCESS_KEY = "rs";
process.env.R2_BUCKET = "vids";
process.env.R2_PUBLIC_BASE_URL = "https://media.example.com";
```

---

## Task 1: Add the `aws4fetch` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

Run: `bun add aws4fetch`
Expected: `package.json` gains `"aws4fetch"` under `dependencies`; `bun.lock` updates.

- [ ] **Step 2: Verify it imports under Bun**

Run: `bun -e "import('aws4fetch').then(m => console.log(typeof m.AwsClient))"`
Expected: prints `function`.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "build: add aws4fetch for R2 SigV4 uploads"
```

---

## Task 2: R2 config + 1080p default

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Update config.test.ts**

Add the R2 vars to `full` and update the height assertion + add R2 + missing-key checks:

```ts
const full = {
  TELEGRAM_BOT_TOKEN: "t",
  OPENAI_API_KEY: "o",
  GEMINI_API_KEY: "g",
  AZURE_SPEECH_KEY: "a",
  R2_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "rk",
  R2_SECRET_ACCESS_KEY: "rs",
  R2_BUCKET: "vids",
  R2_PUBLIC_BASE_URL: "https://media.example.com",
};
```

In "loads required keys and applies defaults", change the height line and add R2:

```ts
  expect(c.maxVideoHeight).toBe(1080);
  expect(c.r2Bucket).toBe("vids");
  expect(c.r2PublicBaseUrl).toBe("https://media.example.com");
  expect(c.r2KeyPrefix).toBe("");
```

Add a test for the new required keys:

```ts
test("throws listing missing R2 keys", () => {
  expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t", OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", AZURE_SPEECH_KEY: "a" }))
    .toThrow(/R2_ENDPOINT.*R2_ACCESS_KEY_ID.*R2_SECRET_ACCESS_KEY.*R2_BUCKET.*R2_PUBLIC_BASE_URL/s);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL — `r2Bucket` undefined, height is 480.

- [ ] **Step 3: Update `src/config.ts`**

Add to the `Config` type (after `ytdlpPlayerClient?`):

```ts
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2Bucket: string;
  r2PublicBaseUrl: string;
  r2KeyPrefix: string;
```

In `loadConfig`'s `cfg` object, add (alongside the other `req(...)` calls):

```ts
    r2Endpoint: req(env, "R2_ENDPOINT", missing),
    r2AccessKeyId: req(env, "R2_ACCESS_KEY_ID", missing),
    r2SecretAccessKey: req(env, "R2_SECRET_ACCESS_KEY", missing),
    r2Bucket: req(env, "R2_BUCKET", missing),
    r2PublicBaseUrl: req(env, "R2_PUBLIC_BASE_URL", missing),
    r2KeyPrefix: env.R2_KEY_PREFIX || "",
```

Change the height default:

```ts
    maxVideoHeight: posInt(env, "MAX_VIDEO_HEIGHT", 1080, errors),
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add R2 config vars; default video height 1080p"
```

---

## Task 3: `r2.ts` service

**Files:**
- Create: `src/services/r2.ts`
- Test: `src/services/r2.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/services/r2.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { objectKey } from "./r2";

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.OPENAI_API_KEY = "o";
  process.env.GEMINI_API_KEY = "g";
  process.env.AZURE_SPEECH_KEY = "a";
  process.env.R2_ENDPOINT = "https://acc.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "rk";
  process.env.R2_SECRET_ACCESS_KEY = "rs";
  process.env.R2_BUCKET = "vids";
  process.env.R2_PUBLIC_BASE_URL = "https://media.example.com";
});
afterEach(() => { globalThis.fetch = realFetch; });

test("objectKey joins prefix, base, jobId, .mp4", () => {
  expect(objectKey("my_clip", "ab12")).toBe("my_clip-ab12.mp4");
  expect(objectKey("my_clip", "ab12", "videos/")).toBe("videos/my_clip-ab12.mp4");
});

test("uploadVideo PUTs a signed, unsigned-payload request and returns the public URL", async () => {
  const dest = "/tmp/myancap-r2-test.mp4";
  await Bun.write(dest, new Uint8Array([1, 2, 3, 4, 5]));

  let seen: { url: string; method: string; headers: Headers } | null = null;
  globalThis.fetch = (async (req: any) => {
    // aws4fetch passes a Request object after signing.
    seen = { url: req.url, method: req.method, headers: req.headers };
    return new Response("", { status: 200 });
  }) as any;

  const { uploadVideo } = await import("./r2");
  const url = await uploadVideo(dest, "videos/clip-ab12.mp4");

  expect(url).toBe("https://media.example.com/videos/clip-ab12.mp4");
  expect(seen!.method).toBe("PUT");
  expect(seen!.url).toBe("https://acc.r2.cloudflarestorage.com/vids/videos/clip-ab12.mp4");
  expect(seen!.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
  expect(seen!.headers.get("content-length")).toBe("5");
  expect(seen!.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
});

test("uploadVideo throws on a non-2xx response", async () => {
  const dest = "/tmp/myancap-r2-test2.mp4";
  await Bun.write(dest, new Uint8Array([9]));
  globalThis.fetch = (async () => new Response("denied", { status: 403 })) as any;

  const { uploadVideo } = await import("./r2");
  await expect(uploadVideo(dest, "k.mp4")).rejects.toThrow(/403/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/services/r2.test.ts`
Expected: FAIL — `./r2` does not exist.

- [ ] **Step 3: Create `src/services/r2.ts`**

```ts
/** Cloudflare R2 upload (S3 API) via aws4fetch SigV4. Stateless. */
import { AwsClient } from "aws4fetch";
import { getConfig } from "../config";

/** Build the object key for a job's video: `<prefix><base>-<jobId>.mp4`. */
export function objectKey(base: string, jobId: string, prefix = ""): string {
  return `${prefix}${base}-${jobId}.mp4`;
}

/**
 * Upload a local mp4 to R2 and return its public URL. Streams the file with an
 * UNSIGNED-PAYLOAD hash so large videos are not buffered in memory; R2 still
 * gets a real Content-Length so players see the right duration/size.
 */
export async function uploadVideo(filePath: string, key: string): Promise<string> {
  const cfg = getConfig();
  const client = new AwsClient({
    accessKeyId: cfg.r2AccessKeyId,
    secretAccessKey: cfg.r2SecretAccessKey,
    region: "auto",
    service: "s3",
  });

  const file = Bun.file(filePath);
  const url = `${cfg.r2Endpoint}/${cfg.r2Bucket}/${key}`;
  const res = await client.fetch(url, {
    method: "PUT",
    body: file.stream(),
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(file.size),
      "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    },
  });
  if (!res.ok) {
    throw new Error(`R2 upload failed: ${res.status} ${await res.text()}`);
  }
  return `${cfg.r2PublicBaseUrl}/${key}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/services/r2.test.ts`
Expected: PASS (3 tests).

Note: if Bun rejects a streamed body without `duplex: "half"`, add `duplex: "half"` to the `client.fetch` options object and re-run. (aws4fetch forwards unknown init fields to `fetch`.)

- [ ] **Step 5: Commit**

```bash
git add src/services/r2.ts src/services/r2.test.ts
git commit -m "feat: add R2 uploadVideo service (streamed SigV4 PUT)"
```

---

## Task 4: Pipeline — upload + link instead of `sendVideo`

**Files:**
- Modify: `src/pipeline/run.ts`
- Test: `src/pipeline/run.test.ts`

- [ ] **Step 1: Update run.test.ts (env + deps + assertions)**

Add the R2 env vars to the top env block (after the existing four):

```ts
process.env.R2_ENDPOINT = "https://acc.r2.cloudflarestorage.com";
process.env.R2_ACCESS_KEY_ID = "rk";
process.env.R2_SECRET_ACCESS_KEY = "rs";
process.env.R2_BUCKET = "vids";
process.env.R2_PUBLIC_BASE_URL = "https://media.example.com";
```

In `makeDeps`, remove the `sendVideo` line and add `uploadVideo`. Also track the
link message. Replace the `sendVideo`/`sendMessage` lines:

```ts
    uploadVideo: async () => { sent.push("upload"); return "https://media.example.com/v.mp4"; },
    sendDocument: async (_c: number, _b: Uint8Array, fn: string) => {
      sent.push(fn.includes(".en.") ? "en" : "my");
      return "DF";
    },
    sendAudio: async () => { sent.push("audio"); return "AF"; },
    sendMessage: async () => {},
```

(Remove the old `sendVideo: async () => {...}` entry entirely.)

Rewrite the youtube happy-path expectation (no `"video"`, now `"upload"`):

```ts
test("youtube happy path: uploads video + sends 3 files, clears job, cleans dir", async () => {
  const db = openDb(":memory:");
  await mkdir("/tmp/myancap-runtest", { recursive: true });
  const dir = await createJobDir("run1");
  insertJob(db, { id: "run1", telegramId: 5, now: 1 });

  const sent: string[] = [];
  const job: Job = { id: "run1", telegramId: 5, chatId: 5, dir, source: ytSource };
  await runJob(db, job, makeDeps(sent));

  expect(sent).toEqual(["upload", "my", "en", "audio"]);
  expect(hasActiveJob(db, 5)).toBe(false);
  expect(existsSync(dir)).toBe(false);
  db.close();
});
```

Replace the old "youtube oversized video file" test (the 50 MB skip path is
gone) with an upload-failure test:

```ts
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
```

The `telegram_video`, oversize-telegram, and failure-path tests stay as written
(telegram_video must still NOT call upload — its `sent` stays `["my","en","audio"]`).

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/pipeline/run.test.ts`
Expected: FAIL — `RunDeps` has no `uploadVideo`; `runJob` still references `sendVideo`.

- [ ] **Step 3: Update `src/pipeline/run.ts` imports + deps**

Replace the telegram import block to drop `sendVideo` and add the r2 import:

```ts
import {
  sendDocument,
  sendAudio,
  sendMessage,
  getFile,
  downloadFile,
} from "../services/telegram";
import { uploadVideo, objectKey } from "../services/r2";
```

In `RunDeps`, remove `sendVideo: typeof sendVideo;` and add `uploadVideo: typeof uploadVideo;`.
In `defaultDeps`, remove `sendVideo,` and add `uploadVideo,`.

Delete the `const VIDEO_MAX_BYTES = ...` line (no longer used).

- [ ] **Step 4: Replace the video delivery block in `runJob`**

Find the block that starts with `const videoFile = Bun.file(videoPath);` and ends
at the closing brace before the `await send("sendMy", ...)` call. Replace it with:

```ts
    if (sendVideoBack) {
      let videoUrl: string | null = null;
      await send("uploadVideo", async () => {
        videoUrl = await deps.uploadVideo(videoPath, objectKey(base, job.id, cfg.r2KeyPrefix));
      });
      await deps
        .sendMessage(
          job.chatId,
          videoUrl
            ? `🎬 video: ${videoUrl}`
            : "⚠️ video link မရပါ — စာတန်းနဲ့ မြန်မာသံ ဖိုင်တွေပဲ ပို့ပါမယ်",
        )
        .catch(() => {});
    }
```

(The `send` helper is defined just above this block; it retries 3× and swallows a
final failure, so `videoUrl` stays `null` on give-up. `my.srt`/`en.srt`/`mp3`
sends below are unchanged.)

- [ ] **Step 5: Run to verify it passes**

Run: `bun test src/pipeline/run.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/run.ts src/pipeline/run.test.ts
git commit -m "feat: upload youtube video to R2 and send public link"
```

---

## Task 5: Add R2 env to the other config-booting test files

**Files:**
- Modify: `src/handlers/telegram-webhook.test.ts`
- Modify: `src/pipeline/job.test.ts`
- Modify: `src/services/transcribe.test.ts`

These three set `process.env.OPENAI_API_KEY = ...` etc. and import modules that
call `getConfig()`, which now requires the R2 vars.

- [ ] **Step 1: Add the R2 env block to each**

In each file, immediately after the existing `process.env.AZURE_SPEECH_KEY = "a";`
line, add:

```ts
process.env.R2_ENDPOINT = "https://acc.r2.cloudflarestorage.com";
process.env.R2_ACCESS_KEY_ID = "rk";
process.env.R2_SECRET_ACCESS_KEY = "rs";
process.env.R2_BUCKET = "vids";
process.env.R2_PUBLIC_BASE_URL = "https://media.example.com";
```

- [ ] **Step 2: Run the three suites**

Run: `bun test src/handlers/telegram-webhook.test.ts src/pipeline/job.test.ts src/services/transcribe.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/handlers/telegram-webhook.test.ts src/pipeline/job.test.ts src/services/transcribe.test.ts
git commit -m "test: provide R2 env vars to config-booting suites"
```

---

## Task 6: 1080p assertion for `videoArgs`

**Files:**
- Test: `src/services/youtube.test.ts`

`videoArgs` already interpolates the height parameter, so no source change — just
prove it renders 1080.

- [ ] **Step 1: Add the assertion**

In the "arg builders include the key flags" test, add:

```ts
  expect(videoArgs("URL", "/d", 1080).join(" ")).toContain("height<=1080");
```

- [ ] **Step 2: Run to verify it passes**

Run: `bun test src/services/youtube.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/services/youtube.test.ts
git commit -m "test: assert videoArgs honors a 1080p height cap"
```

---

## Task 7: Remove the dead `sendVideo`

**Files:**
- Modify: `src/services/telegram.ts`
- Test: `src/services/telegram.test.ts`

After Task 4, nothing imports `sendVideo`.

- [ ] **Step 1: Remove its test**

Delete the whole `test("sendVideo posts to the bot endpoint and returns the file_id", ...)` block from `src/services/telegram.test.ts`.

- [ ] **Step 2: Remove the function**

Delete the entire `export async function sendVideo(...) { ... }` block from
`src/services/telegram.ts`. In `fileIdFrom`, narrow the `key` param type from
`"video" | "audio" | "document"` to `"audio" | "document"`.

- [ ] **Step 3: Run telegram suite + grep for stragglers**

Run: `bun test src/services/telegram.test.ts && grep -rn "sendVideo" src/`
Expected: PASS; grep prints nothing.

- [ ] **Step 4: Commit**

```bash
git add src/services/telegram.ts src/services/telegram.test.ts
git commit -m "refactor: remove dead sendVideo (delivery moved to R2 link)"
```

---

## Task 8: Full suite + typecheck

**Files:** none (verification gate).

- [ ] **Step 1: Run everything**

Run: `bun test && bunx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 2: Commit** — nothing to commit (verification only).

---

## Task 9: Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/PIPELINE.md`
- Modify: `docs/SETUP.md`

- [ ] **Step 1: `CLAUDE.md`**

- "What this is": YouTube jobs now return three files **plus a public R2 link** to
  the (now up-to-1080p) video, not the video file itself.
- Pipeline diagram: after download, add an `→ R2  upload video.mp4 → public link`
  step; the Telegram egress sends the link + en.srt + my.srt + dub.mp3 for YT jobs.
- Tech-stack table: add a "Video hosting — Cloudflare R2 (S3 API via aws4fetch)" row.
- Layout: add `services/r2.ts  R2 upload (aws4fetch SigV4) → public URL`.

- [ ] **Step 2: `docs/PIPELINE.md`**

- Header: YouTube → 4 deliverables become *3 files + 1 link*; mention the 1080p
  cap replacing 480p and that the duration limit stays.
- Stage 2: video is downloaded up to 1080p avc1/mp4.
- New stage between download and egress (or a sub-section of egress): "Upload to
  R2 — stream the mp4 with a signed PUT (UNSIGNED-PAYLOAD), return the public URL.
  On failure, warn and still deliver the SRTs + mp3. Object expiry is an R2
  lifecycle rule, not app state."
- Egress: for youtube, send the link message instead of `sendVideo`; the 50 MB
  skip is removed.

- [ ] **Step 3: `docs/SETUP.md`**

Add an R2 section: the five required env vars (`R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`) + optional
`R2_KEY_PREFIX`; how to get S3 API credentials in the Cloudflare dashboard; how to
enable public access (r2.dev or a custom domain) for `R2_PUBLIC_BASE_URL`; and a
note to add a bucket **lifecycle rule** (e.g. delete objects after N days, scoped
to `R2_KEY_PREFIX`) since the app never deletes.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/PIPELINE.md docs/SETUP.md
git commit -m "docs: document R2 video link delivery + 1080p"
```

---

## Self-Review Notes

- **Spec coverage:** aws4fetch dep (Task 1) ✓; R2 config vars + 1080 default
  (Task 2) ✓; `objectKey`/`uploadVideo` streamed signed PUT + public URL (Task 3)
  ✓; YouTube-only upload + link message + failure warning, 50 MB skip removed
  (Task 4) ✓; `telegram_video` untouched (Task 4 assertion) ✓; config-booting test
  env (Tasks 2,4,5) ✓; 1080p quality (Tasks 2,6) ✓; dead `sendVideo` removal
  (Task 7) ✓; R2 lifecycle = ops note (Task 9 SETUP) ✓; docs (Task 9) ✓.
- **Type consistency:** `uploadVideo(filePath, key)` and `objectKey(base, jobId,
  prefix)` signatures match between r2.ts (Task 3), the `RunDeps` entry and call
  site (Task 4), and the test stubs. Config field names (`r2Endpoint`,
  `r2AccessKeyId`, `r2SecretAccessKey`, `r2Bucket`, `r2PublicBaseUrl`,
  `r2KeyPrefix`) identical in config.ts, r2.ts, and config.test.ts.
- **No placeholders:** every code/test step shows full content.
- **Note:** R2 vars are now *required* config — real deploys must set them before
  this ships (called out in Task 9 SETUP).
