# MyanCap

Automated **English → Myanmar localization** pipeline. Send a Telegram bot a
YouTube link; get back four files — the original video, the English subtitles,
the Myanmar subtitles, and a timed Myanmar voice-over (mp3). Combine them however
you like (e.g. CapCut).

Transcription uses OpenAI `whisper-1`. Translation uses Google Gemini. Speech
uses Azure Neural TTS. `yt-dlp` + `ffmpeg` handle media. Served by Bun + Elysia,
shipped as a single Docker image.

## Pipeline

```
Telegram (YT link)
  → yt-dlp        download video.mp4 + extract audio.mp3
  → whisper-1     audio.mp3 → English .srt   (OpenAI API, timestamped)
  → Gemini Flash  EN .srt → Myanmar .srt
  → Azure TTS     MY .srt → timed MP3        (per-cue, constant speed)
  → Telegram      send 4 files: video + en.srt + my.srt + dub.mp3
```

## Quick start

```bash
cp .env.example .env       # fill in tokens/keys
docker build -t myancap .
docker run --env-file .env -p 3000:3000 myancap
```

Local dev (needs `bun`, `yt-dlp`, `ffmpeg` on PATH):

```bash
bun install
bun run dev
```

Then register the Telegram webhook → see [docs/SETUP.md](docs/SETUP.md).

## Docs

- [CLAUDE.md](CLAUDE.md) — orientation for contributors (and Claude Code)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design + failure model
- [docs/PIPELINE.md](docs/PIPELINE.md) — the 6 stages in detail
- [docs/STRUCTURE.md](docs/STRUCTURE.md) — project layout + layering rules
- [docs/SETUP.md](docs/SETUP.md) — env vars, webhook registration
- [docs/DOCKER.md](docs/DOCKER.md) — multi-stage image build
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — coding rules
- [docs/TODO.md](docs/TODO.md) — deferred work / accepted v1 limits

## Status

Implemented and running end-to-end. See [CLAUDE.md](CLAUDE.md#status) for the
hardening notes (TTS retries, gap clamp, mp3, resilient uploads) and
[docs/TODO.md](docs/TODO.md) for deferred work.
