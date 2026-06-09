# Docker

The image is **single-stage**. Transcription moved to the OpenAI `whisper-1`
cloud API, so there is no whisper.cpp to compile and no model to bake — the
runtime just needs Bun, `yt-dlp`, and `ffmpeg`.

> Earlier drafts used a multi-stage build to compile whisper.cpp with AVX2 and
> bundle `ggml-base.bin`. That is gone: CPU transcription was too slow on the
> target hardware. See [TODO.md](TODO.md) and [CLAUDE.md](../CLAUDE.md) for the
> rationale.

## Runtime image

- Base: official Bun image (slim).
- Install `ffmpeg` and `yt-dlp` (plus `python3`/`ca-certificates` as yt-dlp needs).
- Copy the app source, `bun install --production`.
- Set env defaults: `DATABASE_PATH`, `WORK_DIR`, `PORT`.
- `EXPOSE 3000`, `CMD ["bun", "run", "src/index.ts"]`.

## Skeleton

```dockerfile
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg yt-dlp ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY . .
RUN mkdir -p /data

ENV DATABASE_PATH=/data/myancap.db \
    WORK_DIR=/tmp/myancap \
    PORT=3000

VOLUME ["/data"]
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
```

> If Debian's `yt-dlp` package lags behind YouTube changes, install the latest
> standalone binary instead (download to `/usr/local/bin/yt-dlp`, `chmod +x`).
> yt-dlp's extractors rot quickly — keep it current.

## Data volume

The SQLite file (`DATABASE_PATH`, default `/data/myancap.db`) holds the result
cache, job history, and webhook dedup state. **It must persist across restarts** —
mount a named volume:

```bash
docker run --env-file .env -p 3000:3000 -v myancap-data:/data myancap
```

Without the volume, every restart starts with an empty cache: previously
processed videos get re-downloaded, re-transcribed (OpenAI), and re-synthesized
(Azure) — wasting money — instead of being re-sent instantly from cached
`file_id`s. `WORK_DIR` (`/tmp/myancap`) is the opposite: purely scratch, cleaned
per job, and does **not** need a volume.

## .dockerignore

Keep the build context small and secrets out:

```
node_modules
.git
.env
*.log
*.db
*.db-wal
*.db-shm
docs
**/*.mp4
**/*.wav
**/*.mp3
**/*.m4a
```

## Notes

- `yt-dlp` ages fast against YouTube changes. Rebuild periodically (or
  auto-update the binary) to avoid extractor breakage.
- `ffmpeg` is used for yt-dlp's audio extraction and for the WAV→AAC voice-over
  transcode — keep it installed even though there's no muxing step.
- Mount `WORK_DIR` on a tmpfs or fast disk; jobs do real media I/O there.
- The image is now arch-agnostic — no AVX2/NEON concern, since nothing is
  compiled. Build for amd64 or arm64 freely.
