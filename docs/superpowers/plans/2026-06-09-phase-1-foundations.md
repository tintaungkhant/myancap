# Phase 1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, fully unit-tested foundation layer — config loading, filename slugs, SRT parsing/serialization, the SQLite connection, and the store query layer — that every later phase imports.

**Architecture:** Six small modules under `src/`. No network and no external binaries in this phase, so everything is hermetically unit-testable with `bun test`. `lib/` holds pure helpers and the DB handle; `services/store.ts` wraps the DB in named query functions; `config.ts` is the single typed env reader.

**Tech Stack:** Bun, TypeScript (strict), `bun:sqlite`, `bun test`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/config.ts` | Load + validate env once; export `loadConfig(env)` (pure) and memoized `getConfig()`. |
| `src/lib/slug.ts` | `slugify(title, fallback)` → lowercase snake_case, length-capped. |
| `src/lib/srt.ts` | `Cue` type, `parseTimestamp`, `formatTimestamp`, `parseSrt`, `serializeSrt`. |
| `src/lib/db.ts` | `openDb(path)` → `bun:sqlite` Database with WAL + schema bootstrap. |
| `src/services/store.ts` | Typed query functions over the DB (jobs, video cache, dedup). |
| `src/services/srt-tts.ts` | **Edit:** import parse helpers from `lib/srt.ts` instead of its local copies. |

Tests live next to nothing special — Bun discovers `*.test.ts` anywhere. Put them under `src/**` beside the unit under test.

---

## Task 1: Test tooling

**Files:**
- Modify: `package.json`
- Test: `src/smoke.test.ts`

- [ ] **Step 1: Write a trivial failing test**

Create `src/smoke.test.ts`:

```ts
import { expect, test } from "bun:test";

test("test runner works", () => {
  expect(1 + 1).toBe(3);
});
```

- [ ] **Step 2: Run it to verify the runner reports a failure**

Run: `bun test src/smoke.test.ts`
Expected: FAIL — `expected 2 to be 3`.

- [ ] **Step 3: Fix the assertion**

```ts
import { expect, test } from "bun:test";

test("test runner works", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Wire the `test` script**

In `package.json`, replace the placeholder test script:

```json
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "test": "bun test"
  },
```

- [ ] **Step 5: Run and verify green**

Run: `bun test`
Expected: PASS — 1 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add package.json src/smoke.test.ts
git commit -m "chore: set up bun test runner"
```

---

## Task 2: `config.ts`

Fail-fast env loader. `loadConfig(env)` is pure (testable with a fake env);
`getConfig()` memoizes a real load so importing the module has no side effects.

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/config.test.ts`:

```ts
import { expect, test } from "bun:test";
import { loadConfig } from "./config";

const full = {
  TELEGRAM_BOT_TOKEN: "t",
  OPENAI_API_KEY: "o",
  GEMINI_API_KEY: "g",
  AZURE_SPEECH_KEY: "a",
};

test("loads required keys and applies defaults", () => {
  const c = loadConfig(full);
  expect(c.telegramBotToken).toBe("t");
  expect(c.azureSpeechRegion).toBe("southeastasia");
  expect(c.ttsVoice).toBe("my-MM-ThihaNeural");
  expect(c.maxVideoSeconds).toBe(900);
  expect(c.port).toBe(3000);
  expect(c.telegramWebhookSecret).toBeUndefined();
});

test("throws listing every missing required key", () => {
  expect(() => loadConfig({})).toThrow(
    /TELEGRAM_BOT_TOKEN.*OPENAI_API_KEY.*GEMINI_API_KEY.*AZURE_SPEECH_KEY/s,
  );
});

test("rejects a non-positive-integer numeric", () => {
  expect(() => loadConfig({ ...full, MAX_VIDEO_SECONDS: "0" })).toThrow(
    /MAX_VIDEO_SECONDS/,
  );
  expect(() => loadConfig({ ...full, PORT: "abc" })).toThrow(/PORT/);
});

test("the config object is frozen", () => {
  const c = loadConfig(full);
  expect(Object.isFrozen(c)).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
/**
 * Single source of configuration. `loadConfig` is pure (inject `env` in tests);
 * `getConfig` memoizes a real load so importing this module has no side effects.
 */

export type Config = {
  telegramBotToken: string;
  telegramWebhookSecret?: string;
  openaiApiKey: string;
  geminiApiKey: string;
  azureSpeechKey: string;
  azureSpeechRegion: string;
  ttsVoice: string;
  databasePath: string;
  workDir: string;
  maxConcurrentJobs: number;
  maxVideoSeconds: number;
  port: number;
};

type Env = Record<string, string | undefined>;

function req(env: Env, key: string, missing: string[]): string {
  const v = env[key];
  if (!v) {
    missing.push(key);
    return "";
  }
  return v;
}

function posInt(env: Env, key: string, def: number, errors: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${key} must be a positive integer (got "${raw}")`);
    return def;
  }
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  const missing: string[] = [];
  const errors: string[] = [];

  const cfg: Config = {
    telegramBotToken: req(env, "TELEGRAM_BOT_TOKEN", missing),
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    openaiApiKey: req(env, "OPENAI_API_KEY", missing),
    geminiApiKey: req(env, "GEMINI_API_KEY", missing),
    azureSpeechKey: req(env, "AZURE_SPEECH_KEY", missing),
    azureSpeechRegion: env.AZURE_SPEECH_REGION || "southeastasia",
    ttsVoice: env.TTS_VOICE || "my-MM-ThihaNeural",
    databasePath: env.DATABASE_PATH || "/data/myancap.db",
    workDir: env.WORK_DIR || "/tmp/myancap",
    maxConcurrentJobs: posInt(env, "MAX_CONCURRENT_JOBS", 1, errors),
    maxVideoSeconds: posInt(env, "MAX_VIDEO_SECONDS", 900, errors),
    port: posInt(env, "PORT", 3000, errors),
  };

  if (missing.length) {
    errors.unshift(`Missing required env vars: ${missing.join(", ")}`);
  }
  if (errors.length) {
    throw new Error(`Invalid configuration:\n  ${errors.join("\n  ")}`);
  }

  return Object.freeze(cfg);
}

let cached: Config | undefined;

/** Memoized real config. Throws on first call if env is invalid. */
export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
```

- [ ] **Step 4: Run to verify green**

Run: `bun test src/config.test.ts`
Expected: PASS — 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add fail-fast config loader"
```

---

## Task 3: `lib/slug.ts`

**Files:**
- Create: `src/lib/slug.ts`
- Test: `src/lib/slug.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/slug.test.ts`:

```ts
import { expect, test } from "bun:test";
import { slugify } from "./slug";

test("lowercases and snake-cases a title", () => {
  expect(slugify("How to Cook Rice", "x")).toBe("how_to_cook_rice");
});

test("collapses punctuation runs and trims underscores", () => {
  expect(slugify("How to Cook Rice (2024) — Easy!", "x")).toBe(
    "how_to_cook_rice_2024_easy",
  );
});

test("falls back when the title slugifies to empty", () => {
  expect(slugify("???", "dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(slugify("", "dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

test("caps length at 80 chars without a trailing underscore", () => {
  const s = slugify("a ".repeat(100), "x");
  expect(s.length).toBeLessThanOrEqual(80);
  expect(s.endsWith("_")).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/lib/slug.test.ts`
Expected: FAIL — `Cannot find module './slug'`.

- [ ] **Step 3: Implement `src/lib/slug.ts`**

```ts
/**
 * Turn a video title into a safe lowercase snake_case filename base.
 * Falls back to `fallback` (e.g. the YouTube id) when the title has no
 * usable [a-z0-9] characters.
 */
const MAX_LEN = 80;

export function slugify(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_") // any run of non-alphanumerics -> one underscore
    .replace(/^_+|_+$/g, "") // trim leading/trailing underscores
    .slice(0, MAX_LEN)
    .replace(/_+$/g, ""); // re-trim if the slice cut mid-underscore

  return slug.length > 0 ? slug : fallback;
}
```

- [ ] **Step 4: Run to verify green**

Run: `bun test src/lib/slug.test.ts`
Expected: PASS — 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/slug.ts src/lib/slug.test.ts
git commit -m "feat: add title slugify helper"
```

---

## Task 4: `lib/srt.ts` + refactor `srt-tts.ts`

Extract SRT parsing into a shared lib (Phase 2's `translate.ts` needs the same
parse/serialize), add `formatTimestamp` + `serializeSrt`, then point the existing
`srt-tts.ts` at the shared helpers.

**Files:**
- Create: `src/lib/srt.ts`
- Test: `src/lib/srt.test.ts`
- Modify: `src/services/srt-tts.ts:11-61` (remove local `Cue`, `parseTimestamp`, `parseSrt`; import from `lib/srt`)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/srt.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parseSrt, serializeSrt, parseTimestamp, formatTimestamp } from "./srt";

const SAMPLE =
  "1\n00:00:01,000 --> 00:00:03,500\nHello world\n\n" +
  "2\n00:00:04,000 --> 00:00:06,000\nSecond line\n";

test("parseTimestamp reads HH:MM:SS,mmm into seconds", () => {
  expect(parseTimestamp("00:00:01,000")).toBe(1);
  expect(parseTimestamp("01:02:03,500")).toBeCloseTo(3723.5, 3);
});

test("formatTimestamp is the inverse of parseTimestamp", () => {
  expect(formatTimestamp(1)).toBe("00:00:01,000");
  expect(formatTimestamp(3723.5)).toBe("01:02:03,500");
});

test("parseSrt extracts ordered cues", () => {
  const cues = parseSrt(SAMPLE);
  expect(cues.length).toBe(2);
  expect(cues[0]).toEqual({ index: 1, start: 1, end: 3.5, text: "Hello world" });
  expect(cues[1].text).toBe("Second line");
});

test("serializeSrt round-trips a parsed SRT", () => {
  const again = parseSrt(serializeSrt(parseSrt(SAMPLE)));
  expect(again).toEqual(parseSrt(SAMPLE));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/lib/srt.test.ts`
Expected: FAIL — `Cannot find module './srt'`.

- [ ] **Step 3: Implement `src/lib/srt.ts`**

```ts
/** Shared SRT parsing/serialization. Pure, no I/O. */

export type Cue = {
  index: number;
  start: number; // seconds
  end: number; // seconds
  text: string;
};

/** Parse an SRT timestamp "HH:MM:SS,mmm" into seconds. */
export function parseTimestamp(ts: string): number {
  const [hms, ms] = ts.trim().split(",");
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s + Number(ms) / 1000;
}

/** Format seconds as an SRT timestamp "HH:MM:SS,mmm". */
export function formatTimestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(milli, 3)}`;
}

/** Parse SRT text into cues. Skips malformed blocks. */
export function parseSrt(srt: string): Cue[] {
  const blocks = srt.replace(/\r/g, "").trim().split(/\n\s*\n/);
  const cues: Cue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 2) continue;

    const index = Number(lines[0].trim());
    const timeMatch = lines[1].match(
      /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/,
    );
    if (!timeMatch) continue;

    const start = parseTimestamp(timeMatch[1]);
    const end = parseTimestamp(timeMatch[2]);
    const text = lines.slice(2).join(" ").trim();
    if (!text) continue;

    cues.push({ index, start, end, text });
  }

  return cues;
}

/** Serialize cues back into a standard SRT string (trailing newline). */
export function serializeSrt(cues: Cue[]): string {
  return (
    cues
      .map(
        (c) =>
          `${c.index}\n${formatTimestamp(c.start)} --> ${formatTimestamp(
            c.end,
          )}\n${c.text}`,
      )
      .join("\n\n") + "\n"
  );
}
```

- [ ] **Step 4: Run to verify green**

Run: `bun test src/lib/srt.test.ts`
Expected: PASS — 4 pass.

- [ ] **Step 5: Refactor `srt-tts.ts` to use the shared lib**

In `src/services/srt-tts.ts`, delete the local `Cue` type, `parseTimestamp`, and
`parseSrt` (the block spanning roughly lines 18-61) and replace the import area at
the top so it reads:

```ts
import { synthesizeSpeech } from "./tts";
import { parseSrt, type Cue } from "../lib/srt";
```

Keep everything else (`pcmDuration`, `silence`, `pcmToWav`, `synthCue`,
`srtToSpeech`, and the `SAMPLE_RATE`/`BYTES_PER_SAMPLE` constants) unchanged. The
local `export function parseSrt` becomes the imported one; if any other module
imported `parseSrt` from `srt-tts`, leave a re-export for now:

```ts
export { parseSrt } from "../lib/srt";
```

- [ ] **Step 6: Verify nothing broke**

Run: `bun test`
Expected: PASS — all prior tests still green.
Run: `bun build src/services/srt-tts.ts --target bun > /dev/null && echo OK`
Expected: `OK` (compiles; no missing-symbol errors).

- [ ] **Step 7: Commit**

```bash
git add src/lib/srt.ts src/lib/srt.test.ts src/services/srt-tts.ts
git commit -m "refactor: extract shared SRT lib from srt-tts"
```

---

## Task 5: `lib/db.ts`

**Files:**
- Create: `src/lib/db.ts`
- Test: `src/lib/db.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/db.test.ts`:

```ts
import { expect, test } from "bun:test";
import { openDb } from "./db";

test("creates the three tables", () => {
  const db = openDb(":memory:");
  const names = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
  expect(names).toContain("jobs");
  expect(names).toContain("videos");
  expect(names).toContain("processed_updates");
  db.close();
});

test("is idempotent — opening twice does not throw", () => {
  const db = openDb(":memory:");
  expect(() => openDb(":memory:")).not.toThrow();
  db.close();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/lib/db.test.ts`
Expected: FAIL — `Cannot find module './db'`.

- [ ] **Step 3: Implement `src/lib/db.ts`**

```ts
/**
 * SQLite connection + schema bootstrap. The DB is a cache/record, never the
 * control plane (see CONVENTIONS.md). Idempotent: safe to open repeatedly.
 */
import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  url         TEXT NOT NULL,
  youtube_id  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  stage       TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS videos (
  youtube_id     TEXT NOT NULL,
  voice          TEXT NOT NULL,
  video_file_id  TEXT NOT NULL,
  srt_file_id    TEXT NOT NULL,
  audio_file_id  TEXT NOT NULL,
  title          TEXT,
  duration       INTEGER,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (youtube_id, voice)
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id   INTEGER PRIMARY KEY,
  seen_at     INTEGER NOT NULL
);
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: Run to verify green**

Run: `bun test src/lib/db.test.ts`
Expected: PASS — 2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db.ts src/lib/db.test.ts
git commit -m "feat: add sqlite connection + schema bootstrap"
```

---

## Task 6: `services/store.ts`

Typed query functions over the DB. Every caller uses these — no raw SQL escapes
this file.

**Files:**
- Create: `src/services/store.ts`
- Test: `src/services/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/services/store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/services/store.test.ts`
Expected: FAIL — `Cannot find module './store'`.

- [ ] **Step 3: Implement `src/services/store.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify green**

Run: `bun test src/services/store.test.ts`
Expected: PASS — 4 pass.

- [ ] **Step 5: Run the whole suite**

Run: `bun test`
Expected: PASS — all of Phase 1 green (config, slug, srt, db, store, smoke).

- [ ] **Step 6: Commit**

```bash
git add src/services/store.ts src/services/store.test.ts
git commit -m "feat: add store query layer over sqlite"
```

---

## Phase 1 Done When

- `bun test` is fully green.
- `src/config.ts`, `src/lib/{slug,srt,db}.ts`, `src/services/store.ts` exist and are tested.
- `src/services/srt-tts.ts` imports SRT helpers from `lib/srt.ts` (no duplicate parser).

Next: **Phase 2 — Service wrappers** (`2026-06-09-phase-2-services.md`).
