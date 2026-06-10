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
 * Convert a WAV file to an MP3 file. MP3 (unlike raw ADTS .aac) carries real
 * duration metadata, so players don't mis-estimate length and cut off at long
 * silences. Universally supported by CapCut + Telegram's native audio player.
 */
export async function wavToMp3(inputPath: string, outputPath: string): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", ...mp3Args(inputPath, outputPath)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${err}`);
}
