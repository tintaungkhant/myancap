# Architecture

## Goal

Turn an English YouTube video into a Myanmar localization kit — the original
video, a Myanmar subtitle file, and a timed Myanmar voice-over — end to end, with
no human in the loop. The only user action is pasting a link into a Telegram chat.
**The three outputs are delivered separately; the bot does not mux them.**

## High-level diagram

```
            ┌──────────────┐
  user ───▶ │ Telegram Bot │  (YouTube link as a text message)
            └──────┬───────┘
                   │ webhook (HTTPS)
            ┌──────▼───────────────────────────────────────────────┐
            │              MyanCap service (Bun + Elysia)           │
            │                                                       │
            │  handlers/telegram-webhook.ts                         │
            │        │ ack fast, enqueue job                        │
            │        ▼                                              │
            │  pipeline/run.ts  (one temp dir per job)              │
            │   1 youtube.ts    yt-dlp ─▶ video.mp4 + audio.mp3     │
            │   2 transcribe.ts whisper-1 ─▶ en.srt                 │
            │   3 translate.ts  Gemini ─▶ my.srt                    │
            │   4 srt-tts.ts    Azure TTS ─▶ dub.wav (timed)        │
            │   5 audio.ts      ffmpeg ─▶ dub.m4a (aac)             │
            │   6 telegram.ts   send video.mp4 + my.srt + dub.m4a   │
            └───────────────────────────────────────────────────────┘
                   │                  │              │
                   ▼                  ▼              ▼
             OpenAI whisper-1    Gemini API    Azure TTS API
             (cloud, paid)       (cloud)       (cloud, paid)
```

There is **no muxing stage**. The video is downloaded and forwarded untouched;
the subtitle and voice-over are produced alongside it and sent as separate files.

## Design principles

1. **Thin glue over proven tools.** yt-dlp and ffmpeg each do one hard media
   thing well; the cloud APIs do ASR/translation/TTS. The service orchestrates;
   it does not reimplement any of it.
2. **No native SDKs.** Cloud services are reached over `fetch`; binaries over
   `Bun.spawn`. This keeps the image small and avoids Bun/Node ABI friction.
3. **Deliver parts, not a master.** Shipping video + subs + voice-over separately
   avoids a lossy/fragile mux step and lets the user assemble in any player. It
   also means the original video stream is never re-encoded.
4. **Cache aggressively.** ASR and TTS cost money; the `videos` table caches the
   per-video result so repeats are free and instant.
5. **Fast ack, background work.** Telegram retries un-acked webhooks; the handler
   returns `200` immediately and processes the job asynchronously, reporting
   progress as one message per stage.

## Components

### Ingress — Telegram webhook
`handlers/telegram-webhook.ts`. Verifies the optional secret header, extracts a
YouTube URL from the message, and enqueues a job. Replies with progress messages
so the user is not staring at silence during a multi-minute job.

### Orchestrator — `pipeline/run.ts`
Runs the six stages in order for a single job, threading file paths through a
`Job` context. Any stage throwing aborts the job; the error is reported to the
chat and the temp dir is cleaned up.

### Concurrency — `pipeline/queue.ts`
ffmpeg is CPU-heavy; the cloud APIs have rate limits. An in-process semaphore
caps concurrent jobs (`MAX_CONCURRENT_JOBS`, default `1`). Jobs beyond the cap
wait. This is deliberately simple — see *Scaling*.

**One active job per user.** Before accepting a new link, the handler checks the
`jobs` table for an existing `queued` or `running` job from the same
`telegram_id`. If one exists, the new request is **rejected with a message**
(e.g. `⏳ You already have a video in progress — wait for it to finish.`) and no
job is created. This bounds load and avoids a user flooding the queue.

### Services
Each is a stateless module wrapping one external dependency. See
[PIPELINE.md](PIPELINE.md) for per-stage contracts.

### Storage — SQLite (`lib/db.ts` + `services/store.ts`)
A single SQLite file (`bun:sqlite`, WAL mode) holds three small tables:

- **`jobs`** — one row per request: status, current stage, error. Used for
  status replies and debugging. *Not* used to drive or recover work.
- **`videos`** — result cache: `youtube_id (+ voice)` → the **three** Telegram
  `file_id`s (video, subtitle, voice-over). On a repeat request the bot re-sends
  the cached files instantly — no download, no transcription, no TTS, no cost.
- **`processed_updates`** — `update_id` dedup so Telegram webhook retries don't
  spawn duplicate jobs.

The DB is a **cache and audit record**, never the control plane. The pipeline
runs in memory; if the process dies, in-flight jobs are simply lost (see *Failure
model*). The file lives on a mounted volume (`DATABASE_PATH`) so it survives
container restarts — otherwise the cache would reset every deploy.

Schema (created on boot by `lib/db.ts`, `IF NOT EXISTS`):

```sql
CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,                -- short random id
  telegram_id INTEGER NOT NULL,               -- requesting user
  url         TEXT NOT NULL,
  youtube_id  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed
  stage       TEXT,                            -- download|transcribe|translate|tts|send
  error       TEXT,
  created_at  INTEGER NOT NULL,                -- unix ms
  updated_at  INTEGER NOT NULL
);

CREATE TABLE videos (                          -- result cache (3 files per video)
  youtube_id     TEXT NOT NULL,
  voice          TEXT NOT NULL,                -- cache key includes voice
  video_file_id  TEXT NOT NULL,               -- original video
  srt_file_id    TEXT NOT NULL,               -- Myanmar subtitles
  audio_file_id  TEXT NOT NULL,               -- Myanmar voice-over (aac)
  title          TEXT,
  duration       INTEGER,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (youtube_id, voice)
);

CREATE TABLE processed_updates (               -- webhook idempotency
  update_id   INTEGER PRIMARY KEY,
  seen_at     INTEGER NOT NULL
);
```

> No `users` table in v1 — auth/onboarding is deferred ([TODO.md](TODO.md)). The
> per-user active-job check reads `jobs` by `telegram_id`.

## Failure model

- **A stage fails** → job marked `failed`, user gets `❌ <reason>`, temp dir
  cleaned (mandatory). No retry, no recovery — the user resends the link.
- **Service crashes mid-job** → in-flight jobs are lost, no notification (the
  process is dead). Acceptable by design; no durable queue, no resume on boot.
  Any rows left `running` are stale and ignored — only a fresh request matters.
- **Telegram redelivers a webhook** → deduplicated via the `processed_updates`
  table (`update_id` primary key); the duplicate is dropped.
- **Same video requested again** → all three files served from the `videos`
  cache (cached `file_id`s), skipping the whole pipeline.
- **User already has a job in flight** → new request rejected with a message; no
  second job is created.
- **ffmpeg / yt-dlp missing** → startup or first-use error with the captured
  stderr. The Docker image guarantees their presence.
- **A cloud API errors** (OpenAI/Gemini/Azure) → that stage throws with the
  response body, the job fails, and the user is told which step failed.

## Scaling (future, not v1)

The in-process queue is the seam. To scale out: replace `queue.ts` with a real
broker (Redis / BullMQ), move `pipeline/run.ts` into a worker process, and make
jobs durable. The service interface (webhook → enqueue) does not change.

## Security notes

- Webhook authenticity: Telegram `X-Telegram-Bot-Api-Secret-Token` header,
  checked in `verifySecret`. Set `TELEGRAM_WEBHOOK_SECRET` in production.
- Secrets (`OPENAI_API_KEY`, `AZURE_SPEECH_KEY`, `GEMINI_API_KEY`,
  `TELEGRAM_BOT_TOKEN`) come from env only, never committed. `.env` is git-ignored.
- yt-dlp fetches arbitrary user-supplied URLs. Restrict to `youtube.com` /
  `youtu.be` hosts before download to avoid SSRF-style abuse.
- Output and temp files live under `WORK_DIR`; never echo absolute paths to users.
