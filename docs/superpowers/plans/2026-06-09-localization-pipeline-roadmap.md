# MyanCap Localization Pipeline — Implementation Roadmap

> Four sequential phase-plans. Each produces working, tested software on its own.
> Execute in order — later phases import modules built in earlier ones.

**Goal:** Telegram bot that turns an English YouTube link into three delivered
files — original video, Myanmar subtitles, Myanmar voice-over.

**Reference docs:** [CLAUDE.md](../../../CLAUDE.md),
[ARCHITECTURE.md](../../ARCHITECTURE.md), [PIPELINE.md](../../PIPELINE.md),
[STRUCTURE.md](../../STRUCTURE.md), [CONVENTIONS.md](../../CONVENTIONS.md).

---

## Phase 1 — Foundations  → `2026-06-09-phase-1-foundations.md`

Pure, fully unit-tested infrastructure. No network, no external binaries.

- T1: Test tooling (`bun test`) + scripts
- T2: `src/config.ts` — fail-fast env loading (`getConfig`/`loadConfig`)
- T3: `src/lib/slug.ts` — title → snake_case filename
- T4: `src/lib/srt.ts` — SRT parse/serialize/timestamp helpers; refactor `srt-tts.ts` to use it
- T5: `src/lib/db.ts` — `bun:sqlite` connection + schema bootstrap (WAL)
- T6: `src/services/store.ts` — jobs / video-cache / dedup queries

**Done when:** `bun test` is green; config, slug, srt, db, store all covered.

## Phase 2 — Service wrappers  → `2026-06-09-phase-2-services.md`

One module per external dependency. Network logic tested with mocked `fetch`;
binary logic tested by parsing captured output.

- T1: `src/services/youtube.ts` — yt-dlp metadata probe + download + mp3 extract
- T2: `src/services/transcribe.ts` — OpenAI `whisper-1` → English SRT
- T3: `src/services/translate.ts` — Gemini EN→MY translate + re-time + validation
- T4: `src/services/tts.ts` — default voice → `my-MM-ThihaNeural` (edit)
- T5: `src/services/audio.ts` — WAV→AAC instead of MP3 (edit)
- T6: `src/services/telegram.ts` — add `sendVideo` (edit)

## Phase 3 — Orchestration + ingress  → `2026-06-09-phase-3-pipeline.md`

Wire the services into a job pipeline behind the webhook.

- T1: `src/pipeline/job.ts` — `Job` type + temp-dir create/cleanup
- T2: `src/pipeline/queue.ts` — in-process concurrency semaphore
- T3: `src/pipeline/run.ts` — the 6-stage orchestrator
- T4: `src/handlers/telegram-webhook.ts` — rework to the 6 ingress gates
- T5: `src/index.ts` — mount webhook, use `getConfig()`, boot the DB

## Phase 4 — Containerization  → `2026-06-09-phase-4-docker.md`

- T1: `Dockerfile` (single-stage Bun + ffmpeg + yt-dlp)
- T2: `.dockerignore`
- T3: Build + smoke-run verification

---

## Implementation note (deviation from the phase plans)

`pipeline/run.ts` and `handlers/telegram-webhook.ts` use **dependency injection**
(a `deps` parameter defaulting to the real services) instead of the `mock.module`
approach sketched in the Phase 2/3 plans. Reason: Bun's `mock.module` is
process-global and leaks across test files, contaminating `transcribe.test` /
`telegram.test`. DI keeps each test hermetic. Also, `transcribe.test` asserts a
`Bearer ` prefix rather than the exact key, because `getConfig()` memoizes and the
exact value isn't stable across the shared test process.

## Conventions every phase follows

- TDD: failing test → minimal code → green → commit. Bite-sized steps.
- TypeScript strict. Services are stateless functions. No upward imports
  (`index → handlers → pipeline → services → lib`).
- Read config via `getConfig()`, never `process.env` (except inside `config.ts`).
- External binaries via `Bun.spawn` (throw with stderr on non-zero exit);
  external APIs via `fetch` (check `res.ok`, include body on error).
- Each job owns a temp dir, removed in a `finally`. Mandatory.
