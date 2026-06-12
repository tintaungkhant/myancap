# Video Message Input — Design

**Date:** 2026-06-12
**Status:** Approved (pre-implementation)

## Goal

Accept Telegram **video messages** as a job source, in addition to YouTube
links. For a video message the bot returns three files — English `.srt`,
Myanmar `.srt`, and the timed Myanmar voice-over `.mp3`. **No video file is sent
back** (the user already has it). YouTube links keep their current behavior
(four files, including the downloaded `video.mp4`).

## Scope decisions

- **Accepted incoming types:** native `video` messages, and `document` messages
  whose mime type is `video/*` (a video sent "without compression"). `video_note`
  (round bubbles) is **not** accepted.
- **Size cap:** Telegram's Bot API `getFile` download limit is **20 MB**. A video
  whose `getFile`-reported `file_size` exceeds 20 MB is rejected with a user
  message; the job stops. No self-hosted Bot API server.
- **Output filename base for video jobs:** always generic `video_<jobid>` — any
  uploaded `file_name` is ignored.

## Approach

Approach A (chosen): a discriminated-union `source` on the `Job`. Stage 1
(acquisition) branches on `source.kind`; stages 2–6 are shared. Video is sent
back only for the YouTube source. Rejected alternatives: two parallel run
functions (duplicated send/cleanup), and a source-provider object (over-
abstraction; leans class-ish, against the "stateless functions" convention).

## Changes by file

### `src/pipeline/job.ts`
`Job` gains a `source` field and drops top-level `url`/`youtubeId`:

```ts
export type YoutubeSource = { kind: "youtube"; url: string; youtubeId: string };
export type TelegramVideoSource = { kind: "telegram_video"; fileId: string };

export type Job = {
  id: string;
  telegramId: number;
  chatId: number;
  dir: string;
  source: YoutubeSource | TelegramVideoSource;
};
```

### `src/lib/db.ts` + `src/services/store.ts`
The `jobs` table holds only the per-user lock; `url`/`youtube_id` were
write-only (never `SELECT`ed). Drop them:

```sql
CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
```

`NewJob` becomes `{ id, telegramId, now }`; `insertJob` writes three columns.
`hasActiveJob`, `deleteJob`, `markUpdateProcessed` unchanged. (The table is
DROP+recreated at boot, so no data migration concern.)

### `src/services/telegram.ts`
Add two functions:

- `getFile(fileId: string): Promise<{ filePath: string; fileSize?: number }>` —
  calls the `getFile` Bot API method, returns `result.file_path` and
  `result.file_size` (Telegram may omit `file_size`; treat absent as unknown).
- `downloadFile(filePath: string, destPath: string): Promise<void>` — GETs
  `https://api.telegram.org/file/bot<token>/<filePath>` and writes the bytes to
  `destPath`. Checks `res.ok`, includes the body in thrown errors.

### `src/services/audio.ts`
Add a duration probe (ffprobe ships with ffmpeg, already in the Docker image):

- pure `ffprobeArgs(path: string): string[]` and a parse helper, plus
- `probeDuration(path: string): Promise<number>` returning seconds.

Args: `["-v","error","-show_entries","format=duration","-of","default=nokey=1:noprint_wrappers=1", path]`.
Parse: `Number(stdout.trim())`; throw if not finite.

### `src/pipeline/run.ts`
Stage 1 branches on `job.source.kind`:

- **youtube:** `probe(url)` → `{ durationSeconds, title }`; gate
  `durationSeconds > maxVideoSeconds`; `download(url, dir)` → `video.mp4`.
  `sendVideoBack = true`, slug base = `slugify(title, youtubeId)`.
- **telegram_video:** `getFile(fileId)`; if `fileSize > 20 MB` throw
  `"Video too big (max 20 MB)"`; `downloadFile(filePath, dir/video.mp4)`;
  `probeDuration(video.mp4)` → gate `> maxVideoSeconds`; slug base =
  `video_<jobid>`. `sendVideoBack = false`.

Shared tail (unchanged logic): `extractAudio` → `transcribe` → `translateSrt` →
`srtToSpeech` → `wavToMp3` → send. The send block gates the `sendVideo` call on
`sendVideoBack`; `my.srt`, `en.srt`, `mp3` always sent. The existing >50 MB
video-skip check stays (only reachable on the youtube path now).

`RunDeps` gains `getFile`, `downloadFile`, `probeDuration`.

### `src/handlers/telegram-webhook.ts`
Widen `Update.message` to carry `video?: { file_id: string; file_size?: number }`
and `document?: { file_id: string; file_size?: number; mime_type?: string }`.

Classification (after the dedup gate, replacing the YouTube-only gate):
1. If `text` contains a YouTube id → `youtube` source.
2. Else if `message.video` present → `telegram_video` source (`fileId =
   video.file_id`).
3. Else if `message.document` with `mime_type` starting `video/` →
   `telegram_video` source.
4. Else → reject with a message listing both accepted inputs; return.

Then the active-job gate and enqueue (build the matching `source`, call
`insertJob` with the slimmed `NewJob`).

The early `if (!msg?.text) return;` guard is removed (a video message has no
`text`); guard on `msg` only.

## Error handling

- Oversized incoming video (`file_size > 20 MB`): thrown in stage 1, caught by
  the existing `runJob` catch → user notified, temp dir cleaned.
- `getFile`/`downloadFile`/`ffprobe` failures: standard throw → caught → notify +
  cleanup. No retry (matches existing "no recovery" stance).
- Per-user lock, temp-dir cleanup, and per-upload retry are unchanged.

## Testing

New / updated tests (colocated `*.test.ts`, dependency-injection pattern):

- **webhook:** classifies YouTube link, native `video`, `video/*` `document`;
  rejects `video_note`/non-video document/plain text; enqueues correct `source`.
- **run.ts:** telegram branch downloads via injected `getFile`/`downloadFile`,
  rejects on oversize, does **not** call `sendVideo`, still sends the 3 files;
  youtube branch unchanged (still sends video).
- **audio:** `ffprobeArgs` shape + duration parse (valid / non-finite throw).
- **telegram:** `getFile` parses `file_path`/`file_size`; `downloadFile` writes
  bytes / throws on non-ok.
- **store/db:** insert + lock against the slimmed schema.
- Update existing `run`/`webhook`/`store`/`job` tests for the new `Job`/`NewJob`
  shapes.

## Out of scope

- Muxing (unchanged: bot never muxes).
- Self-hosted Bot API server for >20 MB downloads.
- `video_note` support.
- Language detection (input still assumed English speech).
