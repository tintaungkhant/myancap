/** Shared SRT parsing/serialization. Pure, no I/O. */

export type Cue = {
  index: number;
  start: number; // seconds
  end: number; // seconds
  text: string;
};

/** Parse an SRT timestamp "HH:MM:SS,mmm" into seconds. */
export function parseTimestamp(ts: string): number {
  const [hms, ms] = ts.trim().split(",");
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s + Number(ms) / 1000;
}

/** Format seconds as an SRT timestamp "HH:MM:SS,mmm". */
export function formatTimestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(milli, 3)}`;
}

/** Parse SRT text into cues. Skips malformed blocks. */
export function parseSrt(srt: string): Cue[] {
  const blocks = srt.replace(/\r/g, "").trim().split(/\n\s*\n/);
  const cues: Cue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 2) continue;

    const index = Number(lines[0].trim());
    const timeMatch = lines[1].match(
      /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/,
    );
    if (!timeMatch) continue;

    const start = parseTimestamp(timeMatch[1]);
    const end = parseTimestamp(timeMatch[2]);
    const text = lines.slice(2).join(" ").trim();
    if (!text) continue;

    cues.push({ index, start, end, text });
  }

  return cues;
}

/** Serialize cues back into a standard SRT string (trailing newline). */
export function serializeSrt(cues: Cue[]): string {
  return (
    cues
      .map(
        (c) =>
          `${c.index}\n${formatTimestamp(c.start)} --> ${formatTimestamp(
            c.end,
          )}\n${c.text}`,
      )
      .join("\n\n") + "\n"
  );
}
