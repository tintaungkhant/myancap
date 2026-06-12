/** yt-dlp wrapper: probe metadata, download the video, extract compressed mp3. */
import { getConfig } from "../config";

export type VideoMeta = { durationSeconds: number; title: string };

/**
 * Extra flags applied to every yt-dlp call. Cookies and an explicit player
 * client help get past YouTube's "confirm you're not a bot" / SABR gating.
 */
export function extraArgs(cookies?: string, playerClient?: string): string[] {
  const args: string[] = [];
  if (cookies) args.push("--cookies", cookies);
  if (playerClient) args.push("--extractor-args", `youtube:player_client=${playerClient}`);
  return args;
}

const YT_ID = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/;

/** Extract a YouTube video id from arbitrary text, or null. Also the host guard. */
export function extractYouTubeId(text: string): string | null {
  const m = text.match(YT_ID);
  return m ? m[1] : null;
}

export function probeArgs(url: string): string[] {
  return ["--no-download", "--print", "%(duration)s\n%(title)s", url];
}

export function parseProbe(stdout: string): VideoMeta {
  const lines = stdout.trim().split("\n");
  const durationSeconds = Number(lines[0]);
  if (!Number.isFinite(durationSeconds)) {
    throw new Error(`yt-dlp probe: bad duration "${lines[0]}"`);
  }
  return { durationSeconds, title: (lines[1] ?? "").trim() };
}

export function videoArgs(url: string, dir: string, maxHeight: number): string[] {
  const h = maxHeight;
  return [
    // Prefer H.264 (avc1) + AAC so Telegram can render it (VP9/AV1 = black
    // screen), capped at <=maxHeight to keep files small. Never fall back to
    // audio-only; the final `/b[vcodec!=none]` is a last resort if nothing fits
    // the height cap.
    "-f",
    `bv*[vcodec^=avc1][height<=${h}]+ba[acodec^=mp4a]/b[ext=mp4][vcodec^=avc1][height<=${h}]/bv*[ext=mp4][height<=${h}]+ba/b[height<=${h}][vcodec!=none]/b[vcodec!=none]`,
    "--merge-output-format", "mp4",
    "-o", `${dir}/video.%(ext)s`,
    url,
  ];
}

async function run(args: string[]): Promise<string> {
  const cfg = getConfig();
  const common = extraArgs(cfg.ytdlpCookies, cfg.ytdlpPlayerClient);
  const proc = Bun.spawn(["yt-dlp", ...common, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`yt-dlp failed (${code}): ${err}`);
  return out;
}

/** Probe metadata without downloading. */
export async function probe(url: string): Promise<VideoMeta> {
  return parseProbe(await run(probeArgs(url)));
}

/**
 * Download video.mp4 into `dir`. Returns its path. Audio is NOT fetched
 * separately — the merged mp4 already contains the AAC track, so the caller
 * extracts audio locally with ffmpeg (one network download instead of two,
 * and one fewer YouTube bot-check to trip).
 */
export async function download(
  url: string,
  dir: string,
): Promise<{ videoPath: string }> {
  const cfg = getConfig();
  await run(videoArgs(url, dir, cfg.maxVideoHeight));
  return { videoPath: `${dir}/video.mp4` };
}
