# Phase 2 — Service Wrappers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (this user does not use subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One stateless module per external dependency — yt-dlp, OpenAI whisper-1, Gemini, Azure TTS, ffmpeg, Telegram — each with its command/request logic unit-tested.

**Architecture:** Network calls go through the global `fetch` (overridden in tests). Binary calls go through `Bun.spawn`; the **argument builders and output parsers are pure exported functions tested directly**, while the thin spawn/await wrapper is exercised for real in Phase 4's smoke run. Secrets come from `getConfig()`.

**Tech Stack:** Bun, TypeScript (strict), `fetch`, `Bun.spawn`, `bun test`.

**Depends on:** Phase 1 (`config`, `lib/srt`).

---

## Test approach for I/O

- **Pure parts** (arg builders, URL/id parsers, prompt builder, timing sanitizer,
  SSML builder) → ordinary unit tests.
- **`fetch` callers** (transcribe, translate, telegram) → override
  `globalThis.fetch` with a stub inside the test, set required env first via
  `process.env`, and reset in a `finally`.
- **`Bun.spawn` callers' real execution** (yt-dlp/ffmpeg actually running) → not
  unit-tested here; verified in Phase 4 against a real short video.

---

## Task 1: `services/youtube.ts`

**Files:**
- Create: `src/services/youtube.ts`
- Test: `src/services/youtube.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/services/youtube.test.ts
import { expect, test } from "bun:test";
import {
  extractYouTubeId,
  probeArgs,
  parseProbe,
  videoArgs,
  audioArgs,
} from "./youtube";

test("extractYouTubeId matches the three accepted forms, rejects others", () => {
  expect(extractYouTubeId("watch https://youtube.com/watch?v=dQw4w9WgXcQ now")).toBe("dQw4w9WgXcQ");
  expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractYouTubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractYouTubeId("https://evil.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  expect(extractYouTubeId("just text")).toBeNull();
});

test("parseProbe reads duration + title", () => {
  expect(parseProbe("212\nHow to Cook Rice\n")).toEqual({
    durationSeconds: 212,
    title: "How to Cook Rice",
  });
});

test("parseProbe throws on a bad duration", () => {
  expect(() => parseProbe("notanumber\nTitle")).toThrow(/duration/);
});

test("arg builders include the key flags", () => {
  expect(probeArgs("URL")).toEqual(["--no-download", "--print", "%(duration)s\n%(title)s", "URL"]);
  expect(videoArgs("URL", "/d")).toContain("--merge-output-format");
  expect(videoArgs("URL", "/d")).toContain("/d/video.%(ext)s");
  expect(audioArgs("URL", "/d")).toContain("mp3");
  expect(audioArgs("URL", "/d")).toContain("/d/audio.%(ext)s");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/services/youtube.test.ts`
Expected: FAIL — `Cannot find module './youtube'`.

- [ ] **Step 3: Implement `src/services/youtube.ts`**

```ts
/** yt-dlp wrapper: probe metadata, download the video, extract compressed mp3. */

export type VideoMeta = { durationSeconds: number; title: string };

const YT_ID = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/;

/** Extract a YouTube video id from arbitrary text, or null. Also the host guard. */
export function extractYouTubeId(text: string): string | null {
  const m = text.match(YT_ID);
  return m ? m[1] : null;
}

export function probeArgs(url: string): string[] {
  return ["--no-download", "--print", "%(duration)s\n%(title)s", url];
}

export function parseProbe(stdout: string): VideoMeta {
  const lines = stdout.trim().split("\n");
  const durationSeconds = Number(lines[0]);
  if (!Number.isFinite(durationSeconds)) {
    throw new Error(`yt-dlp probe: bad duration "${lines[0]}"`);
  }
  return { durationSeconds, title: (lines[1] ?? "").trim() };
}

export function videoArgs(url: string, dir: string): string[] {
  return [
    "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
    "--merge-output-format", "mp4",
    "-o", `${dir}/video.%(ext)s`,
    url,
  ];
}

export function audioArgs(url: string, dir: string): string[] {
  return [
    "-f", "bestaudio", "-x",
    "--audio-format", "mp3", "--audio-quality", "5",
    "--postprocessor-args", "-ac 1",
    "-o", `${dir}/audio.%(ext)s`,
    url,
  ];
}

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(["yt-dlp", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`yt-dlp failed (${code}): ${err}`);
  return out;
}

/** Probe metadata without downloading. */
export async function probe(url: string): Promise<VideoMeta> {
  return parseProbe(await run(probeArgs(url)));
}

/** Download video.mp4 and audio.mp3 into `dir`. Returns their paths. */
export async function download(
  url: string,
  dir: string,
): Promise<{ videoPath: string; audioPath: string }> {
  await run(videoArgs(url, dir));
  await run(audioArgs(url, dir));
  return { videoPath: `${dir}/video.mp4`, audioPath: `${dir}/audio.mp3` };
}
```

- [ ] **Step 4: Run to verify green**

Run: `bun test src/services/youtube.test.ts`
Expected: PASS — 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/youtube.ts src/services/youtube.test.ts
git commit -m "feat: add yt-dlp wrapper (probe, download, extract)"
```

---

## Task 2: `services/transcribe.ts`

**Files:**
- Create: `src/services/transcribe.ts`
- Test: `src/services/transcribe.test.ts`

- [ ] **Step 1: Write the failing test (fetch overridden)**

```ts
// src/services/transcribe.test.ts
import { afterEach, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function setEnv() {
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.GEMINI_API_KEY = "g";
  process.env.AZURE_SPEECH_KEY = "a";
}

test("posts to OpenAI with auth header and returns the srt body", async () => {
  setEnv();
  let seenUrl = "";
  let seenAuth = "";
  globalThis.fetch = (async (url: any, init: any) => {
    seenUrl = String(url);
    seenAuth = init.headers.Authorization;
    return new Response("1\n00:00:01,000 --> 00:00:02,000\nHi\n", { status: 200 });
  }) as any;

  // import AFTER env is set so getConfig() (lazy) loads cleanly
  const { transcribe } = await import("./transcribe");
  const srt = await transcribe("/tmp/audio.mp3");

  expect(seenUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect(seenAuth).toBe("Bearer sk-test");
  expect(srt).toContain("--> 00:00:02,000");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/services/transcribe.test.ts`
Expected: FAIL — `Cannot find module './transcribe'`.

- [ ] **Step 3: Implement `src/services/transcribe.ts`**

```ts
/** OpenAI whisper-1 transcription. Returns a timestamped English SRT string. */
import { getConfig } from "../config";

export async function transcribe(mp3Path: string): Promise<string> {
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("language", "en");
  form.append("response_format", "srt");
  form.append("file", Bun.file(mp3Path));

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${getConfig().openaiApiKey}` },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`whisper-1 failed: ${res.status} ${await res.text()}`);
  }
  return res.text();
}
```

- [ ] **Step 4: Run to verify green**

Run: `bun test src/services/transcribe.test.ts`
Expected: PASS — 1 pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/transcribe.ts src/services/transcribe.test.ts
git commit -m "feat: add whisper-1 transcription service"
```

---

## Task 3: `services/translate.ts`

Translate + re-time via Gemini, with a pure validation/sanitization core and a
retry-once on cue-count mismatch.

**Files:**
- Create: `src/services/translate.ts`
- Test: `src/services/translate.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/services/translate.test.ts
import { expect, test } from "bun:test";
import {
  buildPrompt,
  sanitizeTimings,
  validateCueCount,
  stripFences,
} from "./translate";
import type { Cue } from "../lib/srt";

test("buildPrompt states the core rules", () => {
  const p = buildPrompt("SRTHERE");
  expect(p).toContain("Myanmar");
  expect(p).toContain("one Myanmar cue per English cue");
  expect(p).toContain("Return ONLY the raw SRT");
  expect(p).toContain("SRTHERE");
});

test("validateCueCount throws on mismatch", () => {
  expect(() => validateCueCount(5, 4)).toThrow(/cue count/);
  expect(() => validateCueCount(5, 5)).not.toThrow();
});

test("sanitizeTimings fixes overlaps and non-positive durations", () => {
  const cues: Cue[] = [
    { index: 1, start: 0, end: 2, text: "a" },
    { index: 2, start: 1, end: 1, text: "b" }, // starts before prev end, zero-length
  ];
  const fixed = sanitizeTimings(cues);
  expect(fixed[1].start).toBeGreaterThanOrEqual(fixed[0].end);
  expect(fixed[1].end).toBeGreaterThan(fixed[1].start);
});

test("stripFences removes markdown code fences", () => {
  expect(stripFences("```srt\n1\n00:00:01,000 --> 00:00:02,000\nHi\n```")).toContain("--> 00:00:02,000");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/services/translate.test.ts`
Expected: FAIL — `Cannot find module './translate'`.

- [ ] **Step 3: Implement `src/services/translate.ts`**

```ts
/** Gemini EN->MY translation with re-timing. Pure helpers + a fetch caller. */
import { getConfig } from "../config";
import { parseSrt, serializeSrt, type Cue } from "../lib/srt";

const MODEL = "gemini-1.5-flash";

export function buildPrompt(enSrt: string): string {
  return [
    "You are translating an English SRT subtitle file into Myanmar (Burmese).",
    "Rules:",
    "- Translate the spoken text into natural, modern conversational Myanmar narration (meaning over literal).",
    "- Output one Myanmar cue per English cue. Keep the same sequence numbers and order. Do not merge or split cues.",
    "- You MAY adjust each cue's start/end by a few seconds so the Myanmar phrasing lands naturally. Keep cues chronological and non-overlapping, with positive durations.",
    "- Try to keep the final cue's end time close to the original total. Best effort, not strict.",
    "- Return ONLY the raw SRT. No markdown fences, no commentary.",
    "",
    "English SRT:",
    enSrt,
  ].join("\n");
}

export function stripFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/i, "").trim();
}

export function validateCueCount(enCount: number, myCount: number): void {
  if (enCount !== myCount) {
    throw new Error(`translation cue count mismatch: en=${enCount} my=${myCount}`);
  }
}

/** Force chronological, non-overlapping, positive-duration cues. */
export function sanitizeTimings(cues: Cue[]): Cue[] {
  const out = cues.map((c) => ({ ...c }));
  for (let i = 0; i < out.length; i++) {
    if (i > 0 && out[i].start < out[i - 1].end) out[i].start = out[i - 1].end;
    if (out[i].end <= out[i].start) out[i].end = out[i].start + 0.5;
  }
  return out;
}

async function translateOnce(enSrt: string): Promise<string> {
  const enCount = parseSrt(enSrt).length;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
    `?key=${getConfig().geminiApiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(enSrt) }] }],
      generationConfig: { temperature: 0.3 },
    }),
  });
  if (!res.ok) throw new Error(`gemini failed: ${res.status} ${await res.text()}`);

  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("gemini returned no text");

  const myCues = parseSrt(stripFences(text));
  validateCueCount(enCount, myCues.length);
  return serializeSrt(sanitizeTimings(myCues));
}

/** Translate, retrying once if the cue count comes back wrong. */
export async function translateSrt(enSrt: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await translateOnce(enSrt);
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof Error && e.message.includes("cue count");
      if (!retryable) throw e;
    }
  }
  throw lastErr;
}
```

- [ ] **Step 4: Run to verify green**

Run: `bun test src/services/translate.test.ts`
Expected: PASS — 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/translate.ts src/services/translate.test.ts
git commit -m "feat: add gemini translate+retime service"
```

---

## Task 4: `services/tts.ts` — voice + extract SSML builder

**Files:**
- Modify: `src/services/tts.ts` (change `DEFAULT_VOICE`; extract `buildSsml`)
- Test: `src/services/tts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/services/tts.test.ts
import { expect, test } from "bun:test";
import { buildSsml, DEFAULT_VOICE } from "./tts";

test("default voice is Thiha", () => {
  expect(DEFAULT_VOICE).toBe("my-MM-ThihaNeural");
});

test("buildSsml wraps text with voice + locale, no prosody at rate 1", () => {
  const ssml = buildSsml("hello", "my-MM-ThihaNeural");
  expect(ssml).toContain('name="my-MM-ThihaNeural"');
  expect(ssml).toContain('xml:lang="my-MM"');
  expect(ssml).not.toContain("<prosody");
});

test("buildSsml adds prosody rate when > 1", () => {
  const ssml = buildSsml("hello", "my-MM-ThihaNeural", 1.5);
  expect(ssml).toContain('<prosody rate="1.50">');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/services/tts.test.ts`
Expected: FAIL — `DEFAULT_VOICE`/`buildSsml` not exported.

- [ ] **Step 3: Edit `src/services/tts.ts`**

Change the default voice constant:

```ts
export const DEFAULT_VOICE = "my-MM-ThihaNeural";
```

Add an exported `buildSsml` (lift the inline SSML construction out of
`synthesizeSpeech`), keeping `escapeXml` as-is:

```ts
export function buildSsml(text: string, voice: string, rate?: number): string {
  const locale = voice.split("-").slice(0, 2).join("-");
  const inner = escapeXml(text);
  const body =
    rate && rate !== 1
      ? `<prosody rate="${rate.toFixed(2)}">${inner}</prosody>`
      : inner;
  return `<speak version="1.0" xml:lang="${locale}"><voice xml:lang="${locale}" name="${voice}">${body}</voice></speak>`;
}
```

Then in `synthesizeSpeech`, replace the inline `inner`/`body`/`ssml` construction
with: `const ssml = buildSsml(text, voice, options.rate);` (keep the rest —
key/region lookup, format, fetch — unchanged).

- [ ] **Step 4: Run to verify green**

Run: `bun test src/services/tts.test.ts && bun test`
Expected: PASS — tts tests pass; whole suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/services/tts.ts src/services/tts.test.ts
git commit -m "feat: default to Thiha voice; extract buildSsml"
```

---

## Task 5: `services/audio.ts` — WAV→AAC (file-based)

The dubbing core produces WAV bytes; this converts a WAV file to an AAC `.m4a`
file (file-based, since m4a needs a seekable output).

**Files:**
- Modify: `src/services/audio.ts` (replace `wavToMp3` with `wavToAac`)
- Test: `src/services/audio.test.ts`

- [ ] **Step 1: Write the failing test (pure arg builder)**

```ts
// src/services/audio.test.ts
import { expect, test } from "bun:test";
import { aacArgs } from "./audio";

test("aacArgs encodes input to aac at output path", () => {
  const a = aacArgs("/d/dub.wav", "/d/dub.m4a");
  expect(a).toContain("/d/dub.wav");
  expect(a).toContain("/d/dub.m4a");
  expect(a.join(" ")).toContain("-c:a aac");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/services/audio.test.ts`
Expected: FAIL — `aacArgs` not exported.

- [ ] **Step 3: Rewrite `src/services/audio.ts`**

```ts
/** Audio conversion helpers. Shells out to ffmpeg (file in -> file out). */

export function aacArgs(inputPath: string, outputPath: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-c:a", "aac", "-b:a", "160k",
    outputPath,
  ];
}

/** Convert a WAV file to an AAC (.m4a) file. */
export async function wavToAac(inputPath: string, outputPath: string): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", ...aacArgs(inputPath, outputPath)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${err}`);
}
```

> The old `wavToMp3` is removed. The webhook handler in the legacy code that
> imported it will be replaced wholesale in Phase 3, so no other caller remains.

- [ ] **Step 4: Run to verify green**

Run: `bun test src/services/audio.test.ts`
Expected: PASS — 1 pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/audio.ts src/services/audio.test.ts
git commit -m "feat: convert dub to AAC (file-based) instead of MP3"
```

---

## Task 6: `services/telegram.ts` — `sendVideo` + return file ids

The cache needs the `file_id` Telegram returns, so the send helpers now return it.

**Files:**
- Modify: `src/services/telegram.ts` (add `sendVideo`; make `sendAudio`/`sendDocument`/`sendVideo` return the `file_id`)
- Test: `src/services/telegram.test.ts`

- [ ] **Step 1: Write the failing test (fetch overridden)**

```ts
// src/services/telegram.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
beforeEach(() => { process.env.TELEGRAM_BOT_TOKEN = "BOT123"; });
afterEach(() => { globalThis.fetch = realFetch; });

test("sendVideo posts to the bot endpoint and returns the file_id", async () => {
  let seenUrl = "";
  globalThis.fetch = (async (url: any) => {
    seenUrl = String(url);
    return new Response(
      JSON.stringify({ ok: true, result: { video: { file_id: "VID_FILE_ID" } } }),
      { status: 200 },
    );
  }) as any;

  const { sendVideo } = await import("./telegram");
  const id = await sendVideo(7, new Uint8Array([1, 2, 3]), "clip.mp4");

  expect(seenUrl).toBe("https://api.telegram.org/botBOT123/sendVideo");
  expect(id).toBe("VID_FILE_ID");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/services/telegram.test.ts`
Expected: FAIL — `sendVideo` not exported.

- [ ] **Step 3: Edit `src/services/telegram.ts`**

Add a helper to pull the `file_id` out of a Telegram `Message` result, add
`sendVideo`, and have the three upload helpers return the id. Append/adjust:

```ts
/** Extract the file_id from a sendVideo/sendAudio/sendDocument response. */
function fileIdFrom(result: any, key: "video" | "audio" | "document"): string {
  const id = result?.result?.[key]?.file_id;
  if (typeof id !== "string") throw new Error(`Telegram ${key}: no file_id in response`);
  return id;
}

/** Send an MP4 video. Returns its file_id. */
export async function sendVideo(
  chatId: number,
  mp4: Uint8Array,
  filename = "video.mp4",
): Promise<string> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("video", new Blob([mp4.buffer as ArrayBuffer], { type: "video/mp4" }), filename);

  const res = await fetch(apiUrl("sendVideo"), { method: "POST", body: form });
  if (!res.ok) throw new Error(`sendVideo failed: ${res.status} ${await res.text()}`);
  return fileIdFrom(await res.json(), "video");
}
```

Update the existing `sendAudio` and `sendDocument` to return their file_id too —
change each signature to `Promise<string>` and replace their trailing
`if (!res.ok) {...}` tail with:

```ts
  if (!res.ok) throw new Error(`sendAudio failed: ${res.status} ${await res.text()}`);
  return fileIdFrom(await res.json(), "audio");
```

(and the `document` variant for `sendDocument`). `sendMessage` stays `void`.

- [ ] **Step 4: Run to verify green**

Run: `bun test src/services/telegram.test.ts && bun test`
Expected: PASS — telegram test passes; whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/services/telegram.ts src/services/telegram.test.ts
git commit -m "feat: add sendVideo; return file_id from upload helpers"
```

---

## Phase 2 Done When

- `bun test` is green across all services.
- `youtube.ts`, `transcribe.ts`, `translate.ts` exist; `tts.ts`, `audio.ts`,
  `telegram.ts` updated (Thiha voice, AAC output, `sendVideo` + file_ids).
- The legacy `wavToMp3` import is gone (handled when Phase 3 rewrites the webhook).

Next: **Phase 3 — Orchestration + ingress** (`2026-06-09-phase-3-pipeline.md`).
