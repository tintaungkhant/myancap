/** Audio conversion helpers. Shells out to ffmpeg (file in -> file out). */

export function mp3Args(inputPath: string, outputPath: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-c:a", "libmp3lame", "-b:a", "160k",
    outputPath,
  ];
}

/**
 * Strip the audio track out of a video file into a mono MP3 for transcription.
 * `-vn` drops video, `-ac 1` downmixes to mono (whisper needs neither stereo
 * nor video), `-q:a 5` is VBR ~mid quality — small file, well under OpenAI's
 * 25 MB cap. Avoids a second yt-dlp network fetch; the mp4 already has the audio.
 */
export function extractAudioArgs(videoPath: string, outputPath: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath,
    "-vn", "-ac", "1",
    "-c:a", "libmp3lame", "-q:a", "5",
    outputPath,
  ];
}

async function runFfmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${err}`);
}

/**
 * Convert a WAV file to an MP3 file. MP3 (unlike raw ADTS .aac) carries real
 * duration metadata, so players don't mis-estimate length and cut off at long
 * silences. Universally supported by CapCut + Telegram's native audio player.
 */
export async function wavToMp3(inputPath: string, outputPath: string): Promise<void> {
  await runFfmpeg(mp3Args(inputPath, outputPath));
}

/** Extract a mono MP3 audio track from a video file (for transcription). */
export async function extractAudio(videoPath: string, outputPath: string): Promise<void> {
  await runFfmpeg(extractAudioArgs(videoPath, outputPath));
}
