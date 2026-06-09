# Phase 4 — Containerization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (this user does not use subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the service as a single-stage Docker image (Bun + ffmpeg + yt-dlp) with a persistent data volume, and verify the whole pipeline end-to-end against a real short video.

**Architecture:** No build stage — transcription is a cloud API, so the image just needs the Bun runtime plus the two media binaries. SQLite lives on a mounted volume; `WORK_DIR` is ephemeral scratch.

**Tech Stack:** Docker, Bun, ffmpeg, yt-dlp.

**Depends on:** Phases 1–3 (a booting service with a green test suite).

---

## Task 1: `Dockerfile`

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Write the Dockerfile**

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

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "build: single-stage Dockerfile (bun + ffmpeg + yt-dlp)"
```

---

## Task 2: `.dockerignore`

**Files:**
- Create: `.dockerignore`

- [ ] **Step 1: Write `.dockerignore`**

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

- [ ] **Step 2: Commit**

```bash
git add .dockerignore
git commit -m "build: add .dockerignore"
```

---

## Task 3: Build + boot verification

**Files:** none (verification only)

- [ ] **Step 1: Build the image**

Run: `docker build -t myancap .`
Expected: completes; final line shows the image tagged `myancap`.

- [ ] **Step 2: Confirm the binaries are present in the image**

Run: `docker run --rm myancap sh -c "yt-dlp --version && ffmpeg -version | head -1 && bun --version"`
Expected: three version lines, no "not found".

> If Debian's `yt-dlp` is too old and later fails on real videos, switch the
> install to the standalone binary in the Dockerfile:
> `curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp`

- [ ] **Step 3: Boot the container with env + volume**

Run:
```bash
docker run --rm --env-file .env -p 3000:3000 -v myancap-data:/data myancap
```
Expected: prints `🦊 MyanCap on :3000` and stays up.

- [ ] **Step 4: Health check**

In another terminal: `curl -s localhost:3000/`
Expected: `MyanCap up`. Then Ctrl-C the container.

---

## Task 4: End-to-end smoke (real Telegram + real video)

**Files:** none (manual verification)

This exercises every external dependency for real: yt-dlp, OpenAI, Gemini, Azure,
Telegram. Use a **short (< 2 min) English** YouTube video.

- [ ] **Step 1: Expose the local container**

Start the container (Task 3 Step 3). In another terminal, tunnel it:
Run: `cloudflared tunnel --url http://localhost:3000`
Note the public `https://…` URL it prints.

- [ ] **Step 2: Register the webhook**

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url="https://<public-host>/telegram/webhook" \
  -d secret_token="$TELEGRAM_WEBHOOK_SECRET"
```
Expected: `{"ok":true,...}`. Confirm with `getWebhookInfo` (no `last_error_message`).

- [ ] **Step 3: Send a link and watch the stages**

In Telegram, send your bot a short English YouTube link. Expect, in order:
`🎬 Working on it…` → `⬇️ Downloading…` → `📝 Transcribing…` →
`🌐 Translating…` → `🎙️ Dubbing…` → `📤 Sending…`, then **three files**:
`<title>.mp4`, `<title>.srt`, `<title>.m4a`.

- [ ] **Step 4: Verify the outputs**

- Open the `.srt` — Myanmar text, same cue numbering as the source.
- Play the `.m4a` — Myanmar voice-over (Thiha), roughly aligned to the video.
- Play the `.mp4` alongside the `.m4a` — timing lines up reasonably.

- [ ] **Step 5: Verify the cache**

Send the **same link again**. Expect `✅ Sent (cached)` and the three files
re-sent **immediately** (no stage messages, no reprocessing).

- [ ] **Step 6: Verify the guards**

- Send a non-YouTube message → `Send me a YouTube link.`
- Send a new link, then immediately send another → second gets
  `⏳ You already have a video in progress…`.
- Send a video longer than `MAX_VIDEO_SECONDS` → rejected before download.

- [ ] **Step 7: Confirm cleanup**

Run: `docker exec <container> ls /tmp/myancap`
Expected: empty (or no per-job subdirs) — temp dirs removed after each job.

---

## Phase 4 Done When

- `docker build` succeeds; the image has `yt-dlp`, `ffmpeg`, `bun`.
- The container boots, `/` responds, and the data volume persists the cache.
- A real short English video round-trips to three Myanmar files, the cache
  re-sends instantly, all guards fire, and temp dirs are cleaned.

---

## Project complete

All four phases done = the full spec in [PIPELINE.md](../../PIPELINE.md) is
implemented and verified end-to-end. Remaining deferred items live in
[TODO.md](../../TODO.md) (long-video chunking, duration-overflow policy, auth,
local transcription option).
