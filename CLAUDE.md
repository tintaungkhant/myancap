# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## What this is

**MyanCap** — an automated video localization / dubbing pipeline. A user sends
an English YouTube link to a Telegram bot and gets back three files: the original
video, a Myanmar subtitle track, and a timed Myanmar voice-over. **The bot does
not mux them** — the user combines what they want, in whatever player.

Single service, Bun + Elysia, fully Dockerized. Transcription uses the OpenAI
`whisper-1` API. Translation uses Google Gemini. Speech uses Azure Neural TTS.
`yt-dlp` and `ffmpeg` do the media work.

## The pipeline (6 stages)

```
Telegram (YT link)
  → yt-dlp        download video.mp4 + extract compressed audio.mp3
  → whisper-1     audio.mp3 → English .srt        (OpenAI API, timestamped)
  → Gemini 2.5 Flash  EN .srt → Myanmar .srt       (translate + soft re-time)
  → Azure TTS     MY .srt → timed AAC voice-over    (prosody-rate duration match)
  → Telegram      send 3 files: video.mp4 + my.srt + dub.m4a
```

No muxing step. Full detail: [docs/PIPELINE.md](docs/PIPELINE.md).

## Tech stack

| Concern        | Choice                                    |
|----------------|-------------------------------------------|
| Runtime        | Bun                                       |
| HTTP framework | Elysia                                    |
| Language       | TypeScript (strict)                       |
| Download       | `yt-dlp` (CLI, shelled out)               |
| Transcription  | OpenAI `whisper-1` (REST, returns SRT)    |
| Translation    | Google Gemini `gemini-2.5-flash` (REST)   |
| TTS            | Azure Neural TTS `my-MM-ThihaNeural` (REST)|
| Media          | `ffmpeg` (CLI — extract + WAV→AAC)        |
| Delivery       | Telegram Bot API (REST)                    |
| Storage        | SQLite via `bun:sqlite` (built-in)        |
| Packaging      | Single-stage Dockerfile                    |

No native SDKs — every external service is hit over plain `fetch`, every binary
is shelled out via `Bun.spawn`. Keeps the runtime image small and Bun-friendly.

**Note:** transcription was originally local whisper.cpp (offline/free), dropped
because CPU transcription is too slow on the target hardware. `whisper-1` is
~$0.006/min and the only OpenAI model that returns timestamped SRT — and the
timestamps drive duration-matching, so they are not optional.

## Layout

```
src/
  index.ts                 Elysia app — HTTP routes + webhook entry
  config.ts                env loading + validation (single source of truth)
  pipeline/
    run.ts                 orchestrates the 6 stages for one job
    job.ts                 Job type, temp-dir lifecycle, cleanup
    queue.ts               in-process concurrency guard
  services/
    youtube.ts             yt-dlp: downloadVideo() + extractAudio() (mp3)
    transcribe.ts          OpenAI whisper-1: transcribe() → English srt
    translate.ts           Gemini: translateSrt() EN → MY
    tts.ts                 Azure TTS single-utterance synth (exists)
    srt-tts.ts             SRT → timed WAV, duration-matched (exists)
    audio.ts               ffmpeg WAV → AAC (was MP3)
    telegram.ts            Telegram Bot API client (exists)
    store.ts               DB queries: job lifecycle + webhook dedup
  handlers/
    telegram-webhook.ts    parse update, route YT link → pipeline
  lib/
    srt.ts                 shared SRT parse/serialize helpers
    slug.ts                video title → snake_case delivery filename
    db.ts                  bun:sqlite connection + schema bootstrap (WAL)
docs/                      architecture, pipeline, setup, docker, conventions, todo
Dockerfile                 single-stage Bun runtime (ffmpeg + yt-dlp)
```

SQLite holds **only ephemeral processing state** — there is **no result cache**.
A `jobs` row exists *only while a job is processing* (it is the per-user lock) and
is deleted the moment the job finishes, success or fail. `processed_updates`
deduplicates Telegram webhook retries. Every request reprocesses from scratch.
**No durable queue, no crash recovery** — in-flight jobs are lost on restart by
design, and all leftover job rows are cleared at boot. The DB file lives on a
mounted volume (`DATABASE_PATH`), though it now carries no cache worth persisting.

Full rationale: [docs/STRUCTURE.md](docs/STRUCTURE.md).

## Current state vs target

What already exists (the **downstream half** — SRT → dubbed audio):

- `services/telegram.ts` — sendMessage / sendAudio / sendDocument ✅
- `services/tts.ts` — Azure TTS over REST, SSML prosody rate ✅
- `services/srt-tts.ts` — SRT → timed WAV, silence gap-fill, rate-fit ✅
- `services/audio.ts` — WAV → MP3 via ffmpeg ✅
- `handlers/telegram-webhook.ts` — currently accepts **SRT text only** ⚠️

What is **missing** and must be built (the **upstream half** + delivery):

1. YouTube-link ingress (replace the `looksLikeSrt` gate)
2. `services/youtube.ts` — yt-dlp download video + extract compressed mp3
3. `services/transcribe.ts` — OpenAI whisper-1 transcription → English SRT
4. `services/translate.ts` — Gemini EN→MY
5. Default TTS voice swap `my-MM-NilarNeural` → `my-MM-ThihaNeural`
6. `services/audio.ts` — change WAV→MP3 to WAV→AAC
7. `sendVideo()` + `sendDocument` use for the 3-file delivery
8. `pipeline/` orchestration + job temp-dir lifecycle
9. `lib/db.ts` + `services/store.ts` — SQLite schema, job-lifecycle/dedup queries
10. `Dockerfile` (single-stage) + a data volume for the SQLite file

## Conventions

- **Services are stateless functions**, not classes. One concern per file.
- **External binaries** go through `Bun.spawn`; never assume a binary exists —
  fail loudly with the captured stderr.
- **External APIs** go through `fetch`; check `res.ok`, include the response
  body in thrown errors.
- **Config** is read once in `config.ts` and validated at startup. Services read
  from there, not from `process.env` directly (existing files still read env —
  migrate them as you touch them).
- **Each job gets its own temp directory** under `WORK_DIR`; clean it up in a
  `finally`, success or fail. **This is mandatory** — no orphaned media, ever.
- **The webhook acks fast.** Long work runs in the background through an
  in-process queue (`MAX_CONCURRENT_JOBS`); progress is reported to the chat as
  **one message per stage**. On failure: clean up + notify the user, then stop.
  No retry, no recovery.
- **SQLite holds ephemeral state only, not control flow.** The pipeline runs in
  memory; the DB just holds the per-user lock while processing and the webhook
  dedup set. State is wiped when a job finishes. No result cache.
- TypeScript strict mode. No `any` in new code unless unavoidable.

More: [docs/CONVENTIONS.md](docs/CONVENTIONS.md).

## Commands

```bash
bun run dev          # watch-mode dev server on :3000
docker build -t myancap .
docker run --env-file .env -p 3000:3000 myancap
```

Setup, env vars, Telegram webhook registration: [docs/SETUP.md](docs/SETUP.md).
Docker build details: [docs/DOCKER.md](docs/DOCKER.md).

## A note on caveman mode

The user runs the **caveman** Claude Code plugin (compressed chat style). That
affects *chat replies only* — drop articles/filler, fragments OK. It does **not**
affect committed artifacts: **code, commits, PRs, and these docs are written in
normal, clear prose.** See [docs/CONVENTIONS.md](docs/CONVENTIONS.md#caveman-mode).
