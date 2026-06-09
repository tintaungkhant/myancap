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
    │   ├── job.ts            Job type + temp-dir create/cleanup
    │   └── queue.ts          in-process concurrency semaphore
    ├── services/             one external dependency per file, stateless
    │   ├── youtube.ts        yt-dlp wrapper (video + mp3)
    │   ├── transcribe.ts     OpenAI whisper-1 REST client
    │   ├── translate.ts      Gemini REST client
    │   ├── tts.ts            Azure TTS single-utterance synth      (exists)
    │   ├── srt-tts.ts        SRT → timed WAV, duration-matched     (exists)
    │   ├── audio.ts          ffmpeg WAV → AAC                      (was MP3)
    │   ├── telegram.ts       Telegram Bot API client              (exists)
    │   └── store.ts          DB queries: jobs, video cache, dedup
    ├── handlers/
    │   └── telegram-webhook.ts   parse update → gates → enqueue job
    └── lib/
        ├── srt.ts            shared SRT parse/serialize (extracted from srt-tts)
        ├── slug.ts           title → lowercase snake_case filename
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

## Refactors implied by this structure

The existing code predates this layout. As stages are built, migrate:

1. **Extract SRT parsing** from `services/srt-tts.ts` into `lib/srt.ts`
   (`translate.ts` needs the same parse/serialize, so it must be shared).
2. **Introduce `config.ts`**; move `process.env` reads out of services as they
   are touched.
3. **Rework `handlers/telegram-webhook.ts`** from "SRT text → audio" to
   "YouTube link → pipeline".
4. **Add `sendVideo`** to `services/telegram.ts` (for the 3-file delivery).
5. **Default voice** in `services/tts.ts`: `my-MM-NilarNeural` → `my-MM-ThihaNeural`.
6. **`audio.ts` WAV→MP3 becomes WAV→AAC** (we ship a standalone AAC track).

These are incremental; the existing dubbing core (`srt-tts` + `tts` + `audio`)
is sound and stays — only the output codec changes.
