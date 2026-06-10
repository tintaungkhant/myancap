/** Gemini EN->MY translation with re-timing. Pure helpers + a fetch caller. */
import { getConfig } from "../config";
import { parseSrt, serializeSrt, type Cue } from "../lib/srt";

const MODEL = "gemini-2.5-flash";

export function buildPrompt(enSrt: string): string {
  return [
    "You are translating an English SRT subtitle file into Myanmar (Burmese).",
    "Rules:",
    "- Translate each subtitle line into natural, modern conversational Myanmar (meaning over literal).",
    "- DEFAULT to one Myanmar cue per English cue, keeping the same wording length and pacing as the original. Do not shorten or summarize.",
    "- ONLY split a cue when the English cue is long (roughly two or more full sentences, or more than ~12 words). In that case break it at a natural sentence/clause boundary into 2-3 Myanmar cues — never into tiny fragments.",
    "- When you split one English cue into N Myanmar cues, divide that cue's time window into N consecutive, non-overlapping sub-windows (sequential within the original cue's start/end) — one per new cue. Re-number all cues sequentially from 1 afterwards.",
    "- Do NOT merge separate English cues together, do NOT reorder, do NOT drop or summarize content. Splitting a long cue is allowed; merging is not.",
    "- Keep every cue's time strictly inside the original timeline: never go past the last English cue's end time.",
    "- Return ONLY the raw SRT. No markdown fences, no commentary.",
    "",
    "English SRT:",
    enSrt,
  ].join("\n");
}

export function stripFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/i, "").trim();
}

/** Force chronological, non-overlapping, positive-duration cues. */
export function sanitizeTimings(cues: Cue[]): Cue[] {
  const out = cues.map((c) => ({ ...c }));
  for (let i = 0; i < out.length; i++) {
    if (i > 0 && out[i].start < out[i - 1].end) out[i].start = out[i - 1].end;
    if (out[i].end <= out[i].start) out[i].end = out[i].start + 0.5;
  }
  return out;
}

async function translateOnce(enSrt: string): Promise<string> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent` +
    `?key=${getConfig().geminiApiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(enSrt) }] }],
      generationConfig: { temperature: 0.3 },
    }),
  });
  if (!res.ok) throw new Error(`gemini failed: ${res.status} ${await res.text()}`);

  const data: any = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("gemini returned no text");

  const myCues = parseSrt(stripFences(text));
  if (myCues.length === 0) throw new Error("translation produced no SRT cues");
  // Accept whatever valid cue count Gemini returns — splitting long lines into
  // several short Myanmar cues is expected and fine. Just keep timings sane.
  return serializeSrt(sanitizeTimings(myCues));
}

/** Translate, with one retry for transient failures (rate limits, flaky output). */
export async function translateSrt(enSrt: string): Promise<string> {
  try {
    return await translateOnce(enSrt);
  } catch {
    return await translateOnce(enSrt);
  }
}
