/** Gemini EN->MY translation with re-timing. Pure helpers + a fetch caller. */
import { getConfig } from "../config";
import { parseSrt, serializeSrt, type Cue } from "../lib/srt";

const MODEL = "gemini-2.5-flash";

export function buildPrompt(enSrt: string): string {
  return [
    "You are translating an English SRT subtitle file into Myanmar (Burmese).",
    "Rules:",
    "- Translate the spoken text into natural, modern conversational Myanmar narration (meaning over literal).",
    "- Output one Myanmar cue per English cue. Keep the same sequence numbers and order. Do not merge or split cues.",
    "- You MAY adjust each cue's start/end by a few seconds so the Myanmar phrasing lands naturally. Keep cues chronological and non-overlapping, with positive durations.",
    "- Try to keep the final cue's end time close to the original total. Best effort, not strict.",
    "- Return ONLY the raw SRT. No markdown fences, no commentary.",
    "",
    "English SRT:",
    enSrt,
  ].join("\n");
}

export function stripFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/i, "").trim();
}

export function validateCueCount(enCount: number, myCount: number): void {
  if (enCount !== myCount) {
    throw new Error(`translation cue count mismatch: en=${enCount} my=${myCount}`);
  }
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
  const enCount = parseSrt(enSrt).length;
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
  validateCueCount(enCount, myCues.length);
  return serializeSrt(sanitizeTimings(myCues));
}

/** Translate, retrying once if the cue count comes back wrong. */
export async function translateSrt(enSrt: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await translateOnce(enSrt);
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof Error && e.message.includes("cue count");
      if (!retryable) throw e;
    }
  }
  throw lastErr;
}
