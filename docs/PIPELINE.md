# Pipeline stages

One job = one YouTube link → four delivered files (original video, English
subtitles, Myanmar subtitles, Myanmar voice-over mp3). Each stage takes
files/strings from the previous stage and writes into the job's temp directory.
**There is no muxing stage.**

`Job` context (see `pipeline/job.ts`):

```ts
type Job = {
  id: string;          // short random id, used in temp paths + logs
  telegramId: number;  // user — for the per-user active-job check
  chatId: number;      // Telegram chat to reply to
  url: string;         // validated YouTube URL
  youtubeId: string;   // extracted id
  dir: string;         // WORK_DIR/<id> — deleted in finally
};
```

The matching `jobs` row carries only `id`, `telegram_id`, `url`, `youtube_id`,
and `created_at`; its **mere existence is the per-user lock**. No status/stage
is tracked — the pipeline runs in memory and the row is deleted when the job
finishes. The in-memory `Job` threads file paths. There is no result cache.

---

## 1. Ingress — Telegram webhook

**File:** `handlers/telegram-webhook.ts`
**In:** Telegram `Update`  **Out:** enqueued `Job` (or an early reply)

Gates run in this order; the first that fires short-circuits:

1. **Verify** the secret header (`verifySecret`).
2. **Dedup** the update: if `update_id` is already in `processed_updates`, drop
   it (Telegram retry). Otherwise record it.
3. **Parse** the first YouTube URL from `message.text`. Accept `youtube.com/watch`,
   `youtu.be/<id>`, `youtube.com/shorts/<id>`. Anything else — non-URL, or a
   non-YouTube host (also the SSRF guard) — gets a single plain **reject message**
   (`❌ YouTube link ပို့ပါ`) and stops. No commands, no `/start`, no help menu —
   Telegram UX is deliberately minimal.
4. **User busy?** If this `telegram_id` already has a `jobs` row, reject:
   `⏳ ယခင် video ပြီးအောင် စောင့်ပါ`. No job.
5. Otherwise: insert a `jobs` row (its existence is the lock), reply
   `🎬 လုပ်ဆောင်နေသည်`, enqueue, return `200` immediately.

There is **no cache gate** — every accepted link is reprocessed from scratch.

All user-facing replies are in **Burmese**. Progress is reported as **one message
per stage** as the job advances (`⬇️ video download နေသည်`, `📝 စာတန်းထိုးထုတ်နေသည်`,
`🌐 ဘာသာပြန်နေသည်`, `🎙️ မြန်မာသံထုတ်နေသည်`, `📤 file တွေပို့နေသည်`). Failures:
`❌ မအောင်မြင်ပါ — <reason>`.

---

## 2. Download + audio extraction — yt-dlp + ffmpeg

**Files:** `services/youtube.ts` (download), `services/audio.ts` (extract)
**In:** `url`, `job.dir`  **Out:** `video.mp4` (delivered as-is), `audio.mp3`

**One** network fetch — the video — then audio is pulled from it locally:

```bash
# video — prefer H.264 (avc1) + AAC, capped at <=MAX_VIDEO_HEIGHT (default 480p),
# never fall back to audio-only. avc1 because Telegram renders VP9/AV1 as a black
# screen; the height cap keeps files small (vs the 50 MB upload limit).
yt-dlp -f 'bv*[vcodec^=avc1][height<=480]+ba[acodec^=mp4a]/b[ext=mp4][vcodec^=avc1][height<=480]/bv*[ext=mp4][height<=480]+ba/b[height<=480][vcodec!=none]/b[vcodec!=none]' \
       --merge-output-format mp4 -o "<dir>/video.%(ext)s" <url>

# audio for transcription — extracted from the mp4 we just downloaded (the mp4
# already carries the AAC track), transcoded to compressed mono mp3. No second
# yt-dlp fetch: half the bandwidth, one fewer YouTube bot-check to trip.
ffmpeg -i "<dir>/video.mp4" -vn -ac 1 -c:a libmp3lame -q:a 5 "<dir>/audio.mp3"
```

The yt-dlp call also gets `--cookies <YTDLP_COOKIES>` and/or
`--extractor-args youtube:player_client=<YTDLP_PLAYER_CLIENT>` when those env vars
are set — to get past YouTube's "confirm you're not a bot" / SABR gating.

- **Metadata pre-check first.** Before downloading anything, probe metadata
  (`yt-dlp --print "%(duration)s\n%(title)s" --no-download <url>`). If duration
  exceeds `MAX_VIDEO_SECONDS` (default **900s = 15 min**), reject immediately with
  a message — don't pull a long file just to discard it. Keep the **title**: it
  becomes the delivered filenames (see *Filenames* below).
- **Why mp3, not WAV:** the OpenAI audio API caps uploads at **25 MB**. Mono mp3
  is ~0.5 MB/min, so a 15-min clip is ~7–8 MB — comfortably under the cap.
  (16 kHz WAV would be ~1.9 MB/min.) whisper-1 accepts mp3 directly.
- **Format fallback** is built into the `-f` selector above: prefer clean mp4,
  else take best available and let the merge/extract sort it out.
- Capture stderr; surface yt-dlp's own message on failure. **Age-gated, private,
  and geo-blocked videos are not supported in v1** — they just fail with that
  message (no cookies/login). See [TODO.md](TODO.md).

---

## 3. Transcription — OpenAI whisper-1

**File:** `services/transcribe.ts`
**In:** `audio.mp3`  **Out:** `en.srt`

`POST https://api.openai.com/v1/audio/transcriptions` (multipart, `Authorization:
Bearer <OPENAI_API_KEY>`):

```
model=whisper-1
language=en
response_format=srt
file=@audio.mp3
```

- `response_format=srt` returns a ready-to-use timestamped SRT in one call — no
  post-processing.
- `language=en` is fixed (input is always English — confirmed), so no
  auto-detect, no translate-mode.
- **Why whisper-1:** it is the only OpenAI model that emits timestamps
  (`srt`/`verbose_json`). `gpt-4o-mini-transcribe` is cheaper but text-only, which
  would break duration-matching. ~$0.006/min.
- **25 MB upload cap** — see stage 2; oversized audio fails here until chunking
  lands ([TODO.md](TODO.md)).
- Check `res.ok`; on failure throw with the response body.

---

## 4. Translation — Gemini 2.5 Flash

**File:** `services/translate.ts`
**In:** `en.srt` content  **Out:** `my.srt` content

`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=<GEMINI_API_KEY>`

The model reads the whole English SRT and returns a Myanmar SRT — translate only,
no re-timing. The prompt contract (`buildPrompt`):

- Translate each line into **natural, modern conversational Myanmar** narration —
  meaning over literal.
- Keep **EXACTLY the same cues**: same number of blocks, same sequence numbers,
  same `-->` timestamps, same order. One Myanmar cue per English cue. **Do NOT
  merge, split, drop, reorder, or re-time.** (Granular cues = good subtitles;
  earlier "you may merge" wording made Gemini collapse 24 cues into 9 giant
  blocks.)
- Return raw SRT only — no markdown fences, no commentary.

Hardening:

- `temperature` low (~0.3) for structural stability.
- Validation is **lenient**: require the result parses as SRT with ≥1 cue, then
  `sanitizeTimings` (force chronological, non-overlapping, positive durations).
  **No hard-fail on cue-count mismatch** — Gemini occasionally deviates, and
  failing the whole job over it was worse than accepting a slightly-merged result.
- One retry on any transient failure (rate limit, empty/garbled output).
- **TODO (long video):** chunking for transcripts that exceed Gemini's token
  limit is **not implemented yet** — the whole SRT goes in one call. See
  [TODO.md](TODO.md).

---

## 5. Neural dubbing — Azure TTS

**Files:** `services/srt-tts.ts` (orchestration), `services/tts.ts` (synthesis),
`services/audio.ts` (encode)
**In:** `my.srt` content  **Out:** `dub.wav` (timed), then `dub.mp3` via `audio.ts`

- **One Azure request per cue** (`my-MM-ThihaNeural`, raw 16 kHz PCM). Per-cue,
  *not* a single batched SSML — Azure's REST endpoint silently truncates long
  single-request synthesis (a batched attempt returned only ~50 s of a 2.5-min
  video). Per-cue requests are tiny and never truncate.
- **Bounded concurrency** (`TTS_CONCURRENCY`, default 3) via `mapLimit` — firing
  all cues at once trips Azure's 429 throttle on longer videos.
- **Constant speed by default** (`TTS_MAX_RATE`, default 1) — no per-cue speed-up,
  so the voice never sounds chipmunky; it just runs longer than the video (the
  user adjusts in their editor). Set `TTS_MAX_RATE > 1` to re-enable fitting each
  cue into its window via SSML `<prosody rate>`.
- **Assemble on the timeline**: place each cue after the preceding silence, **gap
  clamped to 30 s** (`MAX_GAP_SECONDS`) — a hallucinated far-future timestamp once
  produced 59 min of silence → a 74 MB mp3 → Telegram 413.
- **Encode to MP3** (`audio.ts`, `-c:a libmp3lame -b:a 160k`, output `dub.mp3`).
  MP3 carries real duration metadata; raw ADTS `.aac` does not, so players
  mis-estimate length and cut off at silences.

`tts.ts` retries on **429/503 and empty 200s** (Azure silently returns an empty
body under load, which would drop that cue) with backoff, up to 5 attempts.

---

## 6. Egress — Telegram (four files)

**File:** `services/telegram.ts`
**In:** `video.mp4`, `en.srt`, `my.srt`, `dub.mp3`  **Out:** four messages to the user

No mux — the user receives the parts and combines them as they like. All share a
**base name derived from the video title** (see *Filenames*), so they group in the
chat:

- Send, in order:
  1. `<slug>.mp4` via `sendVideo`.
  2. `<slug>.my.srt` via `sendDocument` (mime `application/x-subrip`).
  3. `<slug>.en.srt` via `sendDocument`.
  4. `<slug>.mp3` via `sendAudio` (Telegram's native audio = inline player); on
     rejection, falls back to `sendDocument`.
- **Each upload is independent and retried 3×.** Telegram occasionally drops the
  socket mid-upload (`ECONNRESET`); a failure on one file must not abort the job
  or block the others. Failures are logged, not fatal.
- **Oversized video (>50 MB):** Telegram's per-file bot upload cap. If `video.mp4`
  exceeds it, **skip the video with a warning** and still send the SRTs + mp3 — a
  partial result beats nothing. (The 480p cap from stage 2 makes this rare.)
- The `file_id`s Telegram returns are **not stored** — there is no cache.
- In a `finally` (success or failure), **wipe all state for the job**: delete the
  `jobs` row (releasing the per-user lock) and remove the temp dir. Mandatory.

### Filenames

Delivered files share a base name built from the YouTube **title**, slugified to
lowercase snake_case (`lib/slug.ts`):

```
"How to Cook Rice (2024) — Easy!"  →  how_to_cook_rice_2024_easy
   → how_to_cook_rice_2024_easy.mp4
   → how_to_cook_rice_2024_easy.en.srt
   → how_to_cook_rice_2024_easy.my.srt
   → how_to_cook_rice_2024_easy.mp3
```

Slug rules:
- Lowercase; replace every run of non-`[a-z0-9]` characters with a single `_`.
- Trim leading/trailing `_`.
- Cap length (~80 chars) to stay filesystem/Telegram-safe.
- Non-Latin or emoji-only titles can slugify to empty → **fall back to the
  `youtube_id`** so a file is always named.

Internal temp files keep fixed names (`video.mp4`, `audio.mp3`, `en.srt`,
`my.srt`, `dub.wav`, `dub.mp3`); only the delivered filename uses the slug.
