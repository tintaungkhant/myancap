# Conventions

## Code

- **TypeScript strict.** No `any` in new code unless genuinely unavoidable; if so,
  comment why.
- **Services are stateless functions.** No classes for service wrappers. One
  external dependency per file. Pure helpers go in `lib/`.
- **No upward imports.** `services/` never imports `pipeline/` or `handlers/`.
  Dependencies flow `index → handlers → pipeline → services → lib`.
- **Config in one place.** `config.ts` reads and validates env once at startup
  and exports a typed object. New code reads from it, not `process.env`. Legacy
  files migrate as they are touched. See *Configuration* below.

## Configuration (`src/config.ts`)

One module, read once at boot, **fail-fast**. It exports a single frozen typed
`config` object; everything else imports that, never `process.env`.

- **Required** (boot throws if any is missing — collect them all and throw one
  error listing every missing key, not one at a time):
  `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `AZURE_SPEECH_KEY`,
  `AZURE_SPEECH_REGION`.
- **Optional, with defaults** (matches [SETUP.md](SETUP.md) — that table is the
  source of truth):
  `TELEGRAM_WEBHOOK_SECRET` (none → webhook check skipped), `TTS_VOICE`
  (`my-MM-ThihaNeural`), `DATABASE_PATH` (`/data/myancap.db`), `WORK_DIR`
  (`/tmp/myancap`), `MAX_CONCURRENT_JOBS` (`1`), `MAX_VIDEO_SECONDS` (`900`),
  `PORT` (`3000`).
- **Numerics are parsed and validated** — `MAX_CONCURRENT_JOBS`,
  `MAX_VIDEO_SECONDS`, `PORT` must be positive integers, else boot throws.
- Failing fast at boot beats failing on the first user request hours later.

## External processes (`Bun.spawn`)

- Never assume a binary exists. On non-zero exit, throw with the captured
  **stderr** included in the message.
- Pass file paths, not piped megabytes, between media tools when a stage writes
  to the job temp dir — it is simpler to debug and lets ffmpeg seek.
- Quote nothing by hand; pass args as an array to `Bun.spawn`.

## External APIs (`fetch`)

- Always check `res.ok`. On failure, throw with status + response body.
- Keep secrets in env; never log them or echo them to users.
- Set sensible timeouts/retries for flaky network steps (translation, TTS).

## Jobs and temp files

- Every job creates `WORK_DIR/<job.id>/` and deletes it in a `finally` — success
  or failure. **No orphaned media, ever.** This is non-negotiable: the cleanup
  goes in a `finally` so it runs even when a stage throws.
- Never send absolute server paths back to the user.
- **One active job per user.** Before enqueuing, check `store` for a
  `queued`/`running` job from the same `telegram_id`; if found, reject with a
  message and create nothing.
- **No recovery.** A failed job is marked `failed`, cleaned up, and the user is
  told. There is no retry and no resume-on-boot. Stale `running` rows from a
  crash are ignored.

## Database (`bun:sqlite`)

- `lib/db.ts` owns the connection and runs `CREATE TABLE IF NOT EXISTS` on boot
  (WAL mode). No migration framework — for this scale, idempotent DDL is enough.
- All queries live in `services/store.ts` as named functions; no raw SQL in
  handlers/pipeline/services.
- The DB is a **cache + record**, never the control plane. Don't drive pipeline
  flow off DB polling; the in-memory job does the work and writes status as it goes.
- Timestamps are stored as unix-ms integers.
- The DB file lives at `DATABASE_PATH` on a mounted volume — never under
  `WORK_DIR` (which is wiped).

## Errors to the user

- User-facing failures are short and actionable: `❌ Video is private` beats a
  stack trace. Log the full error server-side.
- The webhook always acks `200` fast; problems are reported as chat messages,
  not HTTP errors (Telegram would just retry).

## Commits

- Conventional Commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`.
- Subject ≤ 50 chars, imperative. Body only when the *why* isn't obvious.
- Written in **normal prose** — see caveman note below.

## Caveman mode

The user runs the **caveman** Claude Code plugin: chat replies are compressed
(drop articles/filler, fragments OK) to save tokens. This is a *conversational*
style only.

**It does not apply to durable artifacts.** Code, comments, commit messages, PR
descriptions, and everything in `docs/` are written in **normal, clear prose**.
Compression is for the chat channel, not for things other people (or future
sessions) must read and trust.

If you are an agent reading this: match the surrounding file's style. These docs
and the source are plain English. Only the live chat is caveman.
