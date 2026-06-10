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

// A cue: an index line, a "start --> end" timestamp line, then text running until
// the next index+timestamp pair (or end of input). Tolerant of missing blank-line
// separators between cues — LLM-produced SRT often omits them, which would
// otherwise collapse the whole file into one giant cue.
const CUE_RE =
  /(\d+)[ \t]*\n[ \t]*(\d{2}:\d{2}:\d{2},\d{3})[ \t]*-->[ \t]*(\d{2}:\d{2}:\d{2},\d{3})[ \t]*\n([\s\S]*?)(?=\n[ \t]*\d+[ \t]*\n[ \t]*\d{2}:\d{2}:\d{2},\d{3}[ \t]*-->|\s*$)/g;

/** Parse SRT text into cues. Skips malformed blocks. */
export function parseSrt(srt: string): Cue[] {
  const clean = srt.replace(/\r/g, "");
  const cues: Cue[] = [];

  for (const m of clean.matchAll(CUE_RE)) {
    const index = Number(m[1]);
    const start = parseTimestamp(m[2]);
    const end = parseTimestamp(m[3]);
    // Collapse internal line breaks within a cue's text into single spaces.
    const text = m[4]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ")
      .trim();
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
