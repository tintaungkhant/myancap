/**
 * Audio conversion helpers. Shells out to ffmpeg.
 */

/** Convert WAV (or any ffmpeg-readable) bytes to MP3 bytes. */
export async function wavToMp3(wav: Uint8Array): Promise<Uint8Array> {
  const proc = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "mp3", "-b:a", "128k", "pipe:1"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );

  proc.stdin.write(wav);
  await proc.stdin.end();

  const [mp3, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    throw new Error(`ffmpeg failed (${code}): ${err}`);
  }

  return new Uint8Array(mp3);
}
