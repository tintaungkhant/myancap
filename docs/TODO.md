# TODO / backlog

Deferred work, with enough context to pick up later. Nothing here blocks v1.

## Deferred features

### Long videos (audio chunking + translation chunking)
Two separate caps both hit on long videos:
- **OpenAI 25 MB upload cap** (stage 3): mono mp3 is ~0.5 MB/min, so `audio.mp3`
  exceeds 25 MB around ~50 min. Beyond that, split the audio into segments,
  transcribe each, and stitch the SRTs with a running time offset.
- **Gemini token limit** (stage 4): the whole SRT is sent in one request today.
  Long transcripts must be batched — translate cue batches under the token
  budget, preserve global sequence numbers, re-join, and validate the joined cue
  count equals the input.
- **Not done because:** only short videos are being tested right now. `MAX_VIDEO_
  SECONDS` keeps inputs under both caps for v1. See [PIPELINE.md](PIPELINE.md).

### TTS sync drift (accepted, not solved)
- **Behaviour:** at the default constant speed (`TTS_MAX_RATE=1`), Myanmar speech
  is usually longer than the English windows, so the voice-over runs longer than
  the video and drifts out of sync. **Accepted** — the dub is a separate file and
  the user adjusts timing in their editor (CapCut).
- **If tighter sync is wanted later:** set `TTS_MAX_RATE > 1` to compress cues into
  their windows (re-enables the per-cue prosody-rate path), or design a smarter
  policy (borrow from the next gap, redistribute slack, ask Gemini for shorter
  phrasings on overflowing cues). See [PIPELINE.md](PIPELINE.md) stage 5.

### Auth / onboarding
- **Decision:** intentionally **no auth in v1.** Bot is effectively open.
- **When needed:** a small allowlist (`users` table) with code-join or owner
  approval, cap ~10 users. Design was discussed; deferred. Owner commands
  (`/list`, `/kick`, `/ban`) would come with it.

## Known limits accepted for v1

- **50 MB delivery cap:** if `video.mp4` exceeds Telegram's 50 MB per-file bot
  limit it is **skipped with a warning** and the SRTs + mp3 are still sent. No
  splitting/compression. (The 480p cap makes this rare; the SRTs + mp3 are tiny.)
- **No job recovery:** a process crash loses in-flight jobs silently. User
  resends. No durable queue.
- **Single process / in-process queue:** `MAX_CONCURRENT_JOBS` caps concurrency
  in one process. Scaling out needs a real broker — see
  [ARCHITECTURE.md](ARCHITECTURE.md#scaling-future-not-v1).
- **No local/offline transcription:** transcription is a paid cloud call
  (OpenAI `whisper-1`, ~$0.006/min). The original offline whisper.cpp plan was
  dropped for speed. Could be reintroduced as an optional backend later.
- **15-min max input:** `MAX_VIDEO_SECONDS=900`, checked via a metadata probe
  before download. Keeps audio well under OpenAI's 25 MB cap and bounds cost.
- **No age-gated / private / geo-blocked videos:** these fail with yt-dlp's error.
  Supporting them needs a cookies/login file — deferred.

## Nice-to-have (unscheduled)

- Per-user usage/cost log (OpenAI + Azure minutes) — a `usage` table.
- Optional muxed output (`-c:v copy`) as an extra file, if a user wants one
  stitched video instead of assembling the parts themselves.
- `/status` command to report a user's current job stage.
- yt-dlp auto-update step (extractors rot against YouTube changes).
- Cookies file support for age-gated / members-only videos.
