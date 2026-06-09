# Setup

## Prerequisites

**Local (without Docker):** Bun ≥ 1.1, plus `yt-dlp` and `ffmpeg` on `PATH`.
That's it — transcription is a cloud API now, so there is no whisper.cpp binary or
model to build. If you don't want to install yt-dlp/ffmpeg by hand, use Docker —
the image bundles both (see [DOCKER.md](DOCKER.md)).

**Cloud accounts / keys:**
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- OpenAI API key — for `whisper-1` transcription
- Google Gemini API key — for translation
- Azure Speech resource (key + region) — for Neural TTS

## Environment variables

Copy and fill:

```bash
cp .env.example .env
```

| Var                       | Required | Default                 | Purpose                              |
|---------------------------|----------|-------------------------|--------------------------------------|
| `TELEGRAM_BOT_TOKEN`      | yes      | —                       | Bot token from BotFather             |
| `TELEGRAM_WEBHOOK_SECRET` | prod     | —                       | Verifies inbound webhooks            |
| `OPENAI_API_KEY`          | yes      | —                       | OpenAI key for `whisper-1`           |
| `GEMINI_API_KEY`          | yes      | —                       | Google Gemini API key                |
| `AZURE_SPEECH_KEY`        | yes      | —                       | Azure Speech subscription key        |
| `AZURE_SPEECH_REGION`     | yes      | `southeastasia`         | Azure region                         |
| `TTS_VOICE`               | no       | `my-MM-ThihaNeural`     | Azure Neural voice                   |
| `DATABASE_PATH`           | no       | `/data/myancap.db`      | SQLite file (put on a volume!)       |
| `WORK_DIR`                | no       | `/tmp/myancap`          | Per-job temp directory root          |
| `MAX_CONCURRENT_JOBS`     | no       | `1`                     | In-process job concurrency cap       |
| `MAX_VIDEO_SECONDS`       | no       | `900`                   | Reject videos longer than this (15m) |
| `PORT`                    | no       | `3000`                  | HTTP listen port                     |

> `DATABASE_PATH` holds only the webhook dedup set + in-flight job locks (no
> result cache), so a mounted volume is **optional**. See
> [DOCKER.md](DOCKER.md#data-volume).

## Run

```bash
# dev (watch mode)
bun run dev

# Docker (volume optional — DB holds no cache, only dedup/locks)
docker build -t myancap .
docker run --env-file .env -p 3000:3000 -v myancap-data:/data myancap

# Or with Compose (handles the volume + restart policy for you)
docker compose up --build -d     # start
docker compose logs -f           # tail logs
docker compose down              # stop
```

Compose reads `.env`, forces the container's internal `PORT`/`DATABASE_PATH`/
`WORK_DIR`, and keeps the SQLite file in the `myancap-data` named volume (which
now holds only dedup/locks). Override the published host port with
`HOST_PORT=8080 docker compose up -d`.

## Expose + register the Telegram webhook

Telegram needs a public HTTPS URL. For local dev, tunnel it
(e.g. `cloudflared tunnel --url http://localhost:3000` or ngrok).

Register the webhook (point it at `/telegram/webhook`):

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d url="https://<your-public-host>/telegram/webhook" \
  -d secret_token="$TELEGRAM_WEBHOOK_SECRET"
```

Verify:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

## Smoke test

1. Send your bot a YouTube link.
2. Expect: `🎬 Working on it…`, then per-stage progress, then three files back —
   the original video, the Myanmar `.srt`, and the Myanmar voice-over (`.m4a`).
3. Tail logs for the per-stage timings (`job <id> stage …`).

The legacy `/tts` and `/tts/srt` HTTP routes remain useful for testing the
dubbing core in isolation without going through YouTube.
