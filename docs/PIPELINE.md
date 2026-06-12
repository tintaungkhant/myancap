# Pipeline stages

One job has one of two sources:

- a **YouTube link** → three delivered files (English subtitles, Myanmar
  subtitles, Myanmar voice-over mp3) **plus a public R2 link** to the downloaded
  video (uploaded to Cloudflare R2, not pushed through Telegram). The video is
  downloaded at up to **1080p** (the old 480p cap existed only to fit Telegram's
  50 MB upload limit, which R2 removes). The per-job **duration limit still
  applies**; or
- a **Telegram video message** (native `video` or a `video/*` document) → three
  files (English subtitles, Myanmar subtitles, Myanmar voice-over mp3). The
  video itself is **not** sent back and **not** uploaded to R2 — the user already
  has it.

Each stage takes files/strings from the previous stage and writes into the job's
temp directory. **There is no muxing stage.**

`Job` context (see `pipeline/job.ts`):

```ts
type YoutubeSource = { kind: "youtube"; url: string; youtubeId: string };
type TelegramVideoSource = { kind: "telegram_video"; fileId: string };

type Job = {
  id: string;          // short random id, used in temp paths + logs
  telegramId: number;  // user — for the per-user active-job check
  chatId: number;      // Telegram chat to reply to
  dir: string;         // WORK_DIR/<id> — deleted in finally
  source: YoutubeSource | TelegramVideoSource;
};
```

The matching `jobs` row carries only `id`, `telegram_id`, and `created_at`; its
**mere existence is the per-user lock**. No status/stage is tracked — the
pipeline runs in memory and the row is deleted when the job finishes. The
in-memory `Job` threads the source + file paths. There is no result cache.

---

## 1. Ingress — Telegram webhook

**File:** `handlers/telegram-webhook.ts`
**In:** Telegram `Update`  **Out:** enqueued `Job` (or an early reply)

Gates run in this order; the first that fires short-circuits:

1. **Verify** the secret header (`verifySecret`).
2. **Dedup** the update: if `update_id` is already in `processed_updates`, drop
   it (Telegram retry). Otherwise record it.
3. **Classify** the source, first match wins:
   - a YouTube URL in `message.text` (`youtube.com/watch`, `youtu.be/<id>`,
     `youtube.com/shorts/<id>`) → `youtube` source;
   - a native `message.video` → `telegram_video` source;
   - a `message.document` whose `mime_type` starts `video/` → `telegram_video`
     source.
   Anything else gets a single plain **reject message**
   (`❌ YouTube link (သို့) video ပို့ပါ`) and stops. No commands, no `/start`, no
   help menu — Telegram UX is deliberately minimal.
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

## 2. Download + audio extraction

**Files:** `services/youtube.ts` (yt-dlp), `services/telegram.ts`
(`getFile`/`downloadFile`), `services/audio.ts` (extract + `probeDuration`)
**In:** `job.source`, `job.dir`  **Out:** `video.mp4`, `audio.mp3`

Acquisition branches on `source.kind`; both paths land a `video.mp4` in the job
dir, after which audio extraction is identical.

- **youtube:** `probe` reads duration + title (gates `MAX_VIDEO_SECONDS`), then
  yt-dlp downloads `video.mp4`. The video is delivered as-is in stage 6.
- **telegram_video:** `getFile` resolves the `file_id`; if the reported size
  exceeds **20 MB** (Telegram Bot API download cap) the job is rejected.
  `downloadFile` saves `video.mp4`, then `ffprobe` (`probeDuration`) reads its
  duration to gate `MAX_VIDEO_SECONDS`. The video is **not** re-delivered.

For the YouTube path it is **one** network fetch — the video — then audio is
pulled from it locally:

```bash
# video — prefer H.264 (avc1) + AAC, capped at <=MAX_VIDEO_HEIGHT (default 1080p),
# never fall back to audio-only. avc1 for broad player/CapCut compatibility (VP9/
# AV1 choke some players); the height cap bounds file size + download time.
yt-dlp -f 'bv*[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[ext=mp4][vcodec^=avc1][height<=1080]/bv*[ext=mp4][height<=1080]+ba/b[height<=1080][vcodec!=none]/b[vcodec!=none]' \
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

## 6. Video upload — Cloudflare R2 (YouTube jobs only)

**File:** `services/r2.ts`
**In:** `video.mp4`, slug base, `job.id`  **Out:** a public URL

For a **youtube** job, the downloaded `video.mp4` is uploaded to R2 (S3 API,
SigV4 signed with `aws4fetch`) under the key `<prefix><slug>-<jobId>.mp4` and the
public URL `<AWS_URL>/<key>` is returned. A `telegram_video` job skips
this entirely.

- The file is **streamed** (`body: Bun.file(path).stream()`) with
  `x-amz-content-sha256: UNSIGNED-PAYLOAD` and a real `Content-Length`, so a large
  1080p clip is never buffered into memory.
- The upload runs inside the same **3× retry** wrapper as the file deliveries. If
  it gives up, the user gets a warning and still receives the SRTs + mp3.
- **Object expiry is an R2 bucket lifecycle rule** (configured in the Cloudflare
  dashboard, scoped to `AWS_KEY_PREFIX`), not app code — the pipeline stores
  nothing and tracks no objects, consistent with the no-cache design.

---

## 7. Egress — Telegram (link + three files, or three files for video messages)

**File:** `services/telegram.ts`
**In:** R2 link (youtube), `en.srt`, `my.srt`, `dub.mp3`  **Out:** the messages

No mux — the user receives the parts and combines them as they like. The files
share a **base name** (see *Filenames*), so they group in the chat:

- Send, in order:
  1. **youtube only:** a text message `🎬 video: <R2 public link>` (or a warning if
     the upload failed). A `telegram_video` job sends nothing here.
  2. `<slug>.my.srt` via `sendDocument` (mime `application/x-subrip`).
  3. `<slug>.en.srt` via `sendDocument`.
  4. `<slug>.mp3` via `sendAudio` (Telegram's native audio = inline player); on
     rejection, falls back to `sendDocument`.
- **Each step is independent and retried 3×.** Telegram occasionally drops the
  socket mid-upload (`ECONNRESET`); a failure on one must not abort the job or
  block the others. Failures are logged, not fatal.
- The `file_id`s Telegram returns are **not stored** — there is no cache.
- In a `finally` (success or failure), **wipe all state for the job**: delete the
  `jobs` row (releasing the per-user lock) and remove the temp dir. Mandatory.

### Filenames

For a **youtube** job, delivered files share a base name built from the YouTube
**title**, slugified to lowercase snake_case (`lib/slug.ts`). For a
**telegram_video** job there is no title, so the base is always `video_<jobid>`
(the uploaded file_name is ignored).

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
