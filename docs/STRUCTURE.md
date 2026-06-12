# Project structure

Why the tree looks the way it does, and where new code goes.

```
myancap-server/
├── CLAUDE.md                 entry point for anyone (incl. Claude) working here
├── README.md                 quick start
├── Dockerfile                single-stage Bun runtime (ffmpeg + yt-dlp)
├── .dockerignore
├── .env.example              every config key, documented
├── package.json
├── tsconfig.json
├── docs/
│   ├── ARCHITECTURE.md       system design, principles, failure model
│   ├── PIPELINE.md           the 6 stages, per-stage contracts
│   ├── STRUCTURE.md          this file
│   ├── SETUP.md              local + prod setup, webhook registration
│   ├── DOCKER.md             image build, stages, model baking
│   ├── CONVENTIONS.md        coding rules, caveman-mode note
│   └── TODO.md               deferred work / backlog
└── src/
    ├── index.ts              Elysia app: routes + webhook mount
    ├── config.ts             load + validate env once; typed config object
    ├── pipeline/
    │   ├── run.ts            orchestrate the 6 stages for one job
    │   └── job.ts            Job type + temp-dir create/cleanup
    ├── services/             one external dependency per file, stateless
    │   ├── youtube.ts        yt-dlp wrapper: probe + download video.mp4 (no audio fetch)
    │   ├── transcribe.ts     OpenAI whisper-1 REST client
    │   ├── translate.ts      Gemini REST client
    │   ├── tts.ts            Azure TTS synth (SSML, retry, global limiter)
    │   ├── srt-tts.ts        SRT → timed WAV (per-cue or grouped)
    │   ├── audio.ts          ffmpeg: extractAudio (mp4→mp3) + wavToMp3
    │   ├── telegram.ts       Telegram Bot API client
    │   └── store.ts          DB queries: job lifecycle + webhook dedup
    ├── handlers/
    │   └── telegram-webhook.ts   parse update → gates → enqueue job
    └── lib/
        ├── srt.ts            shared SRT parse/serialize (extracted from srt-tts)
        ├── slug.ts           title → lowercase snake_case filename
        ├── semaphore.ts      in-process counting semaphore (queue + TTS limiter)
        └── db.ts             bun:sqlite connection + schema bootstrap (WAL)
```

## Layering rules

```
index.ts ─▶ handlers ─▶ pipeline ─▶ services ─▶ lib
```

- **handlers** know about HTTP/Telegram shapes; they do not do media work.
- **pipeline** orchestrates services; it owns job lifecycle and temp files.
- **services** wrap exactly one external dependency and expose plain functions.
  They never import from `pipeline` or `handlers` (no upward imports).
- **lib** is low-level shared infrastructure (SRT parsing, the DB connection).
  `lib/db.ts` owns the `bun:sqlite` handle + schema; `services/store.ts` wraps it
  in named query functions. Services/pipeline call `store`, not raw SQL.
- **config** is imported anywhere; it imports nothing of ours.

## Where things go

| You are adding…                     | Put it in…                          |
|-------------------------------------|-------------------------------------|
| A new external API/binary wrapper   | `services/<name>.ts`                |
| A new pipeline stage                | a service + a call in `pipeline/run.ts` |
| A new HTTP route or webhook         | `index.ts` (+ `handlers/` if heavy) |
| A new config key                    | `config.ts` and `.env.example`      |
| Pure data helpers (no I/O)          | `lib/`                              |
| A new SQL query / table             | `lib/db.ts` (schema) + `services/store.ts` (query) |

## Status

This layout is **fully implemented**. The original starter only had the dubbing
core (`srt-tts` + `tts` + `audio` + `telegram`) wired to an SRT-text webhook; the
YouTube ingress, `youtube`/`transcribe`/`translate` services, `pipeline/`,
`lib/`, `config.ts`, and the SQLite store were all added, and the webhook was
reworked from "SRT text → audio" to "YouTube link → pipeline".
