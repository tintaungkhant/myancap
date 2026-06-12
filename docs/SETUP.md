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
| `TTS_MAX_RATE`            | no       | `1`                     | Max TTS speed-up; 1 = constant speed |
| `TTS_CONCURRENCY`         | no       | `3`                     | Max parallel TTS calls (lower if 429)|
| `TTS_GROUP_SECONDS`       | no       | `0`                     | Batch cues per ~N s/call; 0 = per-cue|
| `AZURE_TTS_MAX_CONCURRENCY`| no      | `8`                     | Global cap on concurrent Azure calls |
| `MAX_VIDEO_HEIGHT`        | no       | `1080`                  | Cap downloaded video resolution      |
| `YTDLP_COOKIES`           | no       | —                       | Path to cookies.txt (bot-check)      |
| `YTDLP_PLAYER_CLIENT`     | no       | —                       | yt-dlp player client (e.g. `tv`)     |
| `AWS_ENDPOINT`            | yes      | —                       | `https://<account>.r2.cloudflarestorage.com` |
| `AWS_ACCESS_KEY_ID`       | yes      | —                       | R2 S3 API access key id              |
| `AWS_SECRET_ACCESS_KEY`   | yes      | —                       | R2 S3 API secret                     |
| `AWS_BUCKET`              | yes      | —                       | R2 bucket for uploaded videos        |
| `AWS_URL`                 | yes      | —                       | Public base URL, no trailing slash (r2.dev or custom domain) |
| `AWS_KEY_PREFIX`          | no       | `` (empty)              | Key prefix for uploads (e.g. `videos/`) |
| `DATABASE_PATH`           | no       | `/data/myancap.db`      | SQLite file (volume optional)        |
| `WORK_DIR`                | no       | `/tmp/myancap`          | Per-job temp directory root          |
| `MAX_CONCURRENT_JOBS`     | no       | `1`                     | In-process job concurrency cap       |
| `MAX_VIDEO_SECONDS`       | no       | `900`                   | Reject videos longer than this (15m) |
| `PORT`                    | no       | `3000`                  | HTTP listen port                     |

> `DATABASE_PATH` holds only the webhook dedup set + in-flight job locks (no
> result cache), so a mounted volume is **optional**. See
> [DOCKER.md](DOCKER.md#data-volume).

### Cloudflare R2

YouTube videos are uploaded to R2 and delivered as a public link (video-message
jobs never touch R2). To set it up:

1. **Create a bucket** in the Cloudflare dashboard → R2. Use its name for
   `AWS_BUCKET`.
2. **Create an S3 API token** (R2 → Manage R2 API Tokens → Create, "Object Read &
   Write"). The token gives an Access Key ID and Secret → `AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY`. The token page also shows the S3 endpoint
   `https://<account_id>.r2.cloudflarestorage.com` → `AWS_ENDPOINT`.
3. **Enable public access** so the returned links resolve: either turn on the
   bucket's **r2.dev public URL**, or connect a **custom domain**. Use that origin
   (no trailing slash) for `AWS_URL` — e.g. `https://pub-xxxx.r2.dev`
   or `https://media.example.com`.
4. **Add a lifecycle rule** to auto-delete old objects (the app never deletes):
   bucket → Settings → Object lifecycle rules → e.g. "delete objects N days after
   upload", scoped to `AWS_KEY_PREFIX` if set. This is the only cleanup mechanism.

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
2. Expect: `🎬 လုပ်ဆောင်နေသည်`, then per-stage Burmese progress, then four files
   back — the original video, `.en.srt`, `.my.srt`, and the voice-over (`.mp3`).
3. The only HTTP routes are `GET /` (health → `MyanCap up`) and
   `POST /telegram/webhook`. On failure the bot replies `❌ မအောင်မြင်ပါ — <reason>`;
   the full error is logged server-side (`job <id> failed: …`).
