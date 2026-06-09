/** Audio conversion helpers. Shells out to ffmpeg (file in -> file out). */

export function aacArgs(inputPath: string, outputPath: string): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-c:a", "aac", "-b:a", "160k",
    outputPath,
  ];
}

/** Convert a WAV file to an AAC (.m4a) file. */
export async function wavToAac(inputPath: string, outputPath: string): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", ...aacArgs(inputPath, outputPath)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${err}`);
}
