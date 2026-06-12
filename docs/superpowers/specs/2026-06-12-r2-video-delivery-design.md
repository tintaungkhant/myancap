# R2 Video Delivery — Design

**Date:** 2026-06-12
**Status:** Approved (pre-implementation)
**Builds on:** the video-message-input change (Job source union).

## Goal

Stop sending the downloaded YouTube video back through Telegram. Instead, upload
it to a Cloudflare R2 bucket and reply with the **public R2 link**. This removes
the 50 MB Telegram upload cap and the 480p quality limit — YouTube jobs can now
download higher-quality video (capped at 1080p). The per-job **duration limit
(`MAX_VIDEO_SECONDS`) stays.**

## Scope decisions

- **YouTube source only.** A `telegram_video` job still returns three files
  (en.srt, my.srt, dub.mp3) and uploads nothing — the user already has the video.
- **Signing:** `aws4fetch` (a ~5 KB fetch-based SigV4 signer), not the AWS SDK,
  to keep the no-SDK ethos and small image.
- **Quality:** raise the height cap 480 → **1080p**, still preferring H.264
  (avc1) + AAC in an mp4 container (best CapCut compatibility).
- **Object lifecycle:** the app only uploads (under an optional key prefix);
  auto-deletion is an **R2 bucket lifecycle rule** configured in the Cloudflare
  dashboard, not in app code. The pipeline stays stateless — no object tracking,
  no result cache (consistent with the rest of the system).
- **Streaming upload:** a 1080p clip can be hundreds of MB. The upload streams
  the file (`x-amz-content-sha256: UNSIGNED-PAYLOAD` + `Content-Length`) rather
  than buffering it in memory.

## New service: `src/services/r2.ts`

```ts
/** Build the object key for a job's video. */
export function objectKey(base: string, jobId: string, prefix = ""): string {
  return `${prefix}${base}-${jobId}.mp4`;
}

/** Upload a local mp4 to R2, returning its public URL. */
export async function uploadVideo(filePath: string, key: string): Promise<string>;
```

`uploadVideo`:
1. Reads `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_PUBLIC_BASE_URL` from `getConfig()`.
2. Builds an `AwsClient` (`{ accessKeyId, secretAccessKey }`; region `auto`,
   service `s3`).
3. `PUT ${endpoint}/${bucket}/${key}` with:
   - body = `Bun.file(filePath).stream()`,
   - headers: `Content-Type: video/mp4`, `Content-Length: <file size>`,
     `x-amz-content-sha256: UNSIGNED-PAYLOAD`.
4. On non-2xx, throw with status + body. On success, return
   `${R2_PUBLIC_BASE_URL}/${key}`.

The `AwsClient` is created inside `uploadVideo` from config; tests exercise the
real signer against an injected `fetch` (the pipeline injects `uploadVideo`
itself as a `RunDeps` stub, so most run-path tests never sign at all).

`objectKey` is pure and unit-tested without network.

## Config: `src/config.ts`

Add to `Config` and `loadConfig` (all **required** except the prefix):

| Env var                 | Field               | Notes                                    |
|-------------------------|---------------------|------------------------------------------|
| `R2_ENDPOINT`           | `r2Endpoint`        | `https://<account>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID`      | `r2AccessKeyId`     | required                                 |
| `R2_SECRET_ACCESS_KEY`  | `r2SecretAccessKey` | required                                 |
| `R2_BUCKET`             | `r2Bucket`          | required                                 |
| `R2_PUBLIC_BASE_URL`    | `r2PublicBaseUrl`   | e.g. `https://media.example.com` or `https://pub-xxx.r2.dev` (no trailing slash) |
| `R2_KEY_PREFIX`         | `r2KeyPrefix`       | optional, default `""` (e.g. `videos/`)  |

These join the existing required vars (`req(...)`). Every test file that boots
config via its `process.env.*` block gains the five required R2 vars (dummy
values are fine — the run-path tests inject `uploadVideo`).

Also change `maxVideoHeight` default **480 → 1080**.

## Pipeline: `src/pipeline/run.ts`

`RunDeps`: remove `sendVideo`, add `uploadVideo: typeof uploadVideo`.

Delivery section — replace the whole `videoFile`/`VIDEO_MAX_BYTES`/`sendVideo`
block. The `send(label, fn)` 3×-retry helper stays. `uploadVideo` itself returns
the URL or throws; the `null` outcome comes from `send` swallowing a give-up (it
never re-throws), leaving `videoUrl` unset. New behavior:

- **youtube:** upload the video inside the `send` wrapper. On success, send a link
  message: `await deps.sendMessage(job.chatId, "🎬 video: " + videoUrl)`. If the
  upload gives up after retries, send a warning
  (`⚠️ video link မရပါ — စာတန်းနဲ့ မြန်မာသံ ဖိုင်တွေပဲ ပို့ပါမယ်`) and continue.
- **telegram_video:** no upload, no link (unchanged).
- Then send `my.srt`, `en.srt`, `mp3` exactly as today.

Concretely, the upload is performed as a `send`-wrapped step that sets a
`videoUrl: string | null`; the link/warning message is chosen on the result:

```ts
let videoUrl: string | null = null;
if (sendVideoBack) {
  await send("uploadVideo", async () => {
    videoUrl = await deps.uploadVideo(videoPath, objectKey(base, job.id, cfg.r2KeyPrefix));
  });
  await deps.sendMessage(
    job.chatId,
    videoUrl ? `🎬 video: ${videoUrl}` : "⚠️ video link မရပါ — စာတန်းနဲ့ မြန်မာသံ ဖိုင်တွေပဲ ပို့ပါမယ်",
  ).catch(() => {});
}
```

(`sendVideoBack` is the existing youtube/telegram discriminator from the prior
change. `VIDEO_MAX_BYTES` and the `Bun.file(videoPath)` size check are deleted.)

The `stage("☁️ video upload နေသည်")` ping is emitted once before the send block on
the youtube path.

## Quality: `src/services/youtube.ts`

No code change to `videoArgs` itself — it already interpolates `maxHeight`. The
default bump lives in `config.ts` (`maxVideoHeight` 480 → 1080). `videoArgs`
keeps the avc1/mp4 selector. A test asserts the rendered selector contains
`height<=1080` when called with `1080`.

## Cleanup: remove dead `sendVideo`

`sendVideo` in `src/services/telegram.ts` is only used by `run.ts`; after this
change nothing calls it. Remove the function and its test
(`"sendVideo posts to the bot endpoint..."`). `sendAudio`/`sendDocument`/
`sendMessage`/`getFile`/`downloadFile` stay. `fileIdFrom` keeps its `"video"`
union arm removed only if unused elsewhere — it is shared, so leave the helper
as-is but drop the `"video"` key from its type (it's now only `"audio" |
"document"`).

## Dependencies

Add `aws4fetch` to `package.json` dependencies. Bun installs it; it is
fetch-based and works under Bun.

## Error handling

- **Upload failure** (network / non-2xx): retried 3× by `send`; on give-up the
  user gets the warning message and still receives the 3 files. The job does not
  fail. (Mirrors the previous oversized-video behavior.)
- Duration gate, per-user lock, temp-dir cleanup: unchanged.

## Testing

- **`r2.ts`:** `objectKey` shape (with/without prefix); `uploadVideo` issues a
  signed `PUT` to `${endpoint}/${bucket}/${key}` via an injected `fetch`, sets
  the `UNSIGNED-PAYLOAD` + `Content-Length` headers, returns
  `${publicBase}/${key}`, and throws on a non-2xx response.
- **`run.ts`:** youtube path calls `uploadVideo` and sends a link message (no
  `sendVideo`); upload-failure path sends the warning and still sends 3 files;
  telegram_video path uploads nothing. Update the existing `sent`-array
  assertions (no `"video"`).
- **`config.ts`:** loads the R2 vars; missing ones land in the `missing` list.
- **`youtube.ts`:** `videoArgs(url, dir, 1080)` selector contains `height<=1080`.
- **`telegram.ts`:** remove the `sendVideo` test.

## Out of scope

- Object expiry in app code (handled by an R2 lifecycle rule).
- R2 for `telegram_video` jobs.
- Signed/expiring download URLs (links are public).
- Muxing (unchanged).
- Resumable/multipart uploads (single streamed PUT; 1080p clips under the time
  cap stay within a single-PUT size).
