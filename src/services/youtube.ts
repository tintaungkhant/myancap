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

export function videoArgs(url: string, dir: string): string[] {
  return [
    // Prefer H.264 (avc1) + AAC so Telegram can actually render the video —
    // VP9/AV1 plays as a black screen there. Never fall back to audio-only
    // (`vcodec!=none` on the last option guards against a blank result).
    "-f",
    "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[ext=mp4][vcodec^=avc1]/bv*[ext=mp4]+ba/b[vcodec!=none]",
    "--merge-output-format", "mp4",
    "-o", `${dir}/video.%(ext)s`,
    url,
  ];
}

export function audioArgs(url: string, dir: string): string[] {
  return [
    "-f", "bestaudio", "-x",
    "--audio-format", "mp3", "--audio-quality", "5",
    "--postprocessor-args", "-ac 1",
    "-o", `${dir}/audio.%(ext)s`,
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

/** Download video.mp4 and audio.mp3 into `dir`. Returns their paths. */
export async function download(
  url: string,
  dir: string,
): Promise<{ videoPath: string; audioPath: string }> {
  await run(videoArgs(url, dir));
  await run(audioArgs(url, dir));
  return { videoPath: `${dir}/video.mp4`, audioPath: `${dir}/audio.mp3` };
}
