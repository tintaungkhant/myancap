/** Gemini EN->MY translation with re-timing. Pure helpers + a fetch caller. */
import { getConfig } from "../config";
import { parseSrt, serializeSrt, type Cue } from "../lib/srt";

const MODEL = "gemini-2.5-flash";

export function buildPrompt(enSrt: string): string {
  return [
    "You are translating an English SRT subtitle file into Myanmar (Burmese).",
    "Rules:",
    "- Translate the spoken text into natural, modern conversational Myanmar narration (meaning over literal).",
    "- Keep cues in chronological order with valid, non-overlapping `-->` timestamps. You MAY merge adjacent short lines into one natural Myanmar sentence (renumber sequentially) and adjust timings by a few seconds so phrasing lands naturally.",
    "- Cover the same overall time span; try to keep the final cue's end time close to the original total. Best effort, not strict.",
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
  // Accept whatever valid cue count Gemini returns — merging short lines into
  // natural Myanmar is expected and fine. Just keep timings sane.
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
