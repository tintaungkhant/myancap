# Pipeline stages

One job = one YouTube link → three delivered files (original video, Myanmar
subtitles, Myanmar voice-over). Each stage takes files/strings from the previous
stage and writes into the job's temp directory. **There is no muxing stage.**

`Job` context (see `pipeline/job.ts`):

```ts
type Job = {
  id: string;          // short random id, used in temp paths + logs
  telegramId: number;  // user — for the per-user active-job check + cache log
  chatId: number;      // Telegram chat to reply to
  url: string;         // validated YouTube URL
  youtubeId: string;   // extracted id — cache key
  dir: string;         // WORK_DIR/<id> — deleted in finally
};
```

The matching `jobs` row carries `status` (`queued|running|done|failed`),
`stage`, and `error`; the in-memory `Job` only threads file paths. Result
`file_id`s are stored in the `videos` cache, not on the job.

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
   (e.g. `Send me a YouTube link.`) and stops. No commands, no `/start`, no help
   menu in v1 — Telegram UX is deliberately minimal.
4. **Cache hit?** If `videos` already has this `youtube_id (+ voice)`, re-send the
   three stored `file_id`s immediately (`✅ Sent (cached)`). No job created.
5. **User busy?** If this `telegram_id` has a `queued`/`running` job, reject:
   `⏳ You already have a video in progress — wait for it to finish.` No job.
6. Otherwise: insert a `jobs` row (`status='queued'`), reply `🎬 Working on it…`,
   enqueue, return `200` immediately.

Progress is reported as **one message per stage** as the job advances
(`⬇️ Downloading…`, `📝 Transcribing…`, `🌐 Translating…`, `🎙️ Dubbing…`,
`📤 Sending…`).

---

## 2. Download + audio extraction — yt-dlp

**File:** `services/youtube.ts`
**In:** `url`, `job.dir`  **Out:** `video.mp4` (delivered as-is), `audio.mp3`

Two outputs from the one source:

```bash
# video — best mp4, delivered to the user untouched (never re-encoded)
yt-dlp -f 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b' \
       --merge-output-format mp4 -o "<dir>/video.%(ext)s" <url>

# audio for transcription — compressed mono mp3, kept small for the API upload
yt-dlp -f bestaudio -x --audio-format mp3 --audio-quality 5 \
       --postprocessor-args "-ac 1" \
       -o "<dir>/audio.%(ext)s" <url>
```

- **Metadata pre-check first.** Before downloading anything, probe metadata
  (`yt-dlp --print "%(duration)s\n%(title)s" --no-download <url>`). If duration
  exceeds `MAX_VIDEO_SECONDS` (default **900s = 15 min**), reject immediately with
  a message — don't pull a long file just to discard it. Keep the **title**: it
  becomes the delivered filenames (see *Filenames* below) and is cached in
  `videos.title`.
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

## 4. Translation — Gemini 1.5 Flash

**File:** `services/translate.ts`
**In:** `en.srt` content  **Out:** `my.srt` content

`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=<GEMINI_API_KEY>`

The model reads the whole English SRT and returns a Myanmar SRT. It is allowed to
**re-time** as well as translate. No exact prompt is fixed here — this is the
behavioural contract the prompt must encode:

- Translate the spoken text into **natural, modern conversational Myanmar**
  narration — meaning over literal word-for-word.
- **One Myanmar cue per English cue**, same sequence numbers, same order (1:1, no
  merging or splitting). This keeps the mapping simple for the dubbing stage.
- **Timestamps may be adjusted** by a few seconds per cue when it helps the
  Myanmar line land naturally (Myanmar phrasing is often longer or shorter than
  English). Cues must stay chronological and non-overlapping, with positive
  durations.
- **Soft goal: preserve the overall end time.** Try to keep the last cue's end
  near the original total so the voice-over stays roughly aligned with the
  original video (delivered alongside). This is best-effort, *not* a hard rule —
  drifting a little is fine; drifting a lot is not.
- Return raw SRT only — no markdown fences, no commentary.

Why allow re-timing: the dubbing stage (5) fits speech into each cue's window. If
Gemini pre-widens a window that English made too tight, Azure TTS speeds up less
and the result sounds more natural. Gemini does the coarse re-timing; TTS does
the fine fit.

Hardening:

- `temperature` low (~0.3) for structural stability.
- Validate: result parses as SRT, **same cue count** as input, timestamps
  monotonic and non-overlapping (clamp small overlaps rather than fail). On a
  count mismatch, retry once, then fail the job with a clear message.
- End-time drift is **logged, not failed** — it's a soft target.
- **TODO (long video):** chunking for transcripts that exceed Gemini's token
  limit is **not implemented yet** — current code sends the whole SRT in one
  call. Only tested on short videos. See [TODO.md](TODO.md).

---

## 5. Neural dubbing — Azure TTS (duration-matched)

**Files:** `services/srt-tts.ts` (orchestration), `services/tts.ts` (synthesis)
**In:** `my.srt` content  **Out:** `dub.wav` (timed), then `dub.m4a` (aac) via `audio.ts`

Already implemented; the dubbing logic stays:

- Synthesize each cue as raw 16 kHz PCM with `my-MM-ThihaNeural`.
- If a cue's speech overruns its `end - start` window, re-synthesize with SSML
  `<prosody rate>` = `speechDuration / window`, capped at `MAX_RATE` (2.5×).
- Lay each cue onto the original timeline; fill gaps with silence so the
  voice-over lines up with the source video's timing.
- Assemble one WAV, then transcode to **AAC** (`services/audio.ts`, `-c:a aac`,
  output `dub.m4a`). Was MP3 — changed because we deliver a standalone AAC track.

Changes needed: default voice `my-MM-NilarNeural` → `my-MM-ThihaNeural`;
`audio.ts` WAV→MP3 becomes WAV→AAC.

- Windows come from the Myanmar SRT, which Gemini may already have re-timed to fit
  (stage 4) — so the speed-up here is usually gentler than English timing alone
  would force.
- **TODO (overflow policy):** when Myanmar speech is *still* far longer than its
  window even at `MAX_RATE`, the current code accepts overflow — later cues drift.
  A proper policy (trim, borrow from the next gap, or re-balance) is **deferred**.
  Gemini's re-timing reduces how often this bites, but doesn't eliminate it. See
  [TODO.md](TODO.md).

---

## 6. Egress — Telegram (three files)

**File:** `services/telegram.ts`
**In:** `video.mp4`, `my.srt`, `dub.m4a`  **Out:** three messages to the user

No mux — the user receives the parts and combines them as they like.

All three are delivered under a **shared base name derived from the video title**
(see *Filenames*), so they group together in the chat:

- Send, in order:
  1. `<slug>.mp4` via `sendVideo` (falls back to `sendDocument` if oversized).
  2. `<slug>.srt` via `sendDocument` (mime `application/x-subrip`).
  3. `<slug>.m4a` via `sendAudio` (the Myanmar voice-over).
- New client method: `sendVideo(chatId, bytes, filename)` (multipart, like the
  existing `sendAudio`).
- **50 MB cap (v1).** Telegram's bot upload limit is 50 MB **per file**. The
  original `video.mp4` is the one most likely to exceed it; if it does, send it as
  a document, or if still too large, fail with `❌ Video too large (>50 MB)`. The
  SRT and AAC are tiny and never hit the cap. Splitting/compression is out of
  scope for now.
- On success: capture the three `file_id`s Telegram returns and **upsert them into
  the `videos` cache** (`youtube_id (+ voice) → video_file_id, srt_file_id,
  audio_file_id`) so repeats are instant.
- Mark the `jobs` row `done` (or `failed`), then **always remove the temp dir**
  in a `finally` — success or failure. Mandatory.

### Filenames

Delivered files share a base name built from the YouTube **title**, slugified to
lowercase snake_case (`lib/slug.ts`):

```
"How to Cook Rice (2024) — Easy!"  →  how_to_cook_rice_2024_easy
   → how_to_cook_rice_2024_easy.mp4
   → how_to_cook_rice_2024_easy.srt
   → how_to_cook_rice_2024_easy.m4a
```

Slug rules:
- Lowercase; replace every run of non-`[a-z0-9]` characters with a single `_`.
- Trim leading/trailing `_`.
- Cap length (~80 chars) to stay filesystem/Telegram-safe.
- Non-Latin or emoji-only titles can slugify to empty → **fall back to the
  `youtube_id`** so a file is always named.

Internal temp files keep fixed names (`video.mp4`, `audio.mp3`, `en.srt`,
`my.srt`, `dub.m4a`); only the delivered filename uses the slug.
