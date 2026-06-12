/**
 * Microsoft Cognitive Services (Azure) Text-to-Speech.
 *
 * Uses the Speech REST API directly via fetch — no native SDK deps,
 * which keeps it Bun-friendly. Returns the synthesized audio bytes.
 *
 * Required env vars:
 *   AZURE_SPEECH_KEY    - subscription key
 *   AZURE_SPEECH_REGION - region, e.g. "southeastasia"
 */

export type TtsOptions = {
  /** Voice name, e.g. "en-US-JennyNeural". */
  voice?: string;
  /** Output audio format header value. */
  format?: string;
  /**
   * Speaking rate multiplier. 1 = default, 1.5 = 50% faster.
   * Used to fit speech into a fixed time window.
   */
  rate?: number;
};

import { Semaphore } from "../lib/semaphore";

export const DEFAULT_VOICE = "my-MM-ThihaNeural";
const DEFAULT_FORMAT = "audio-16khz-128kbitrate-mono-mp3";

// Process-wide cap on concurrent Azure TTS requests, shared across ALL jobs.
// The per-job concurrency (srt-tts) limits one job; this bounds the TOTAL so
// raising MAX_CONCURRENT_JOBS can't fan out into an Azure 429 storm. Default 8
// leaves headroom over a single job's 3; lower it (env) if Azure throttles.
const GLOBAL_TTS_LIMIT = 8;
let limiter: Semaphore | undefined;
function ttsLimiter(): Semaphore {
  if (!limiter) {
    const raw = Number(process.env.AZURE_TTS_MAX_CONCURRENCY);
    const max = Number.isInteger(raw) && raw > 0 ? raw : GLOBAL_TTS_LIMIT;
    limiter = new Semaphore(max);
  }
  return limiter;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build the SSML document for a voice + optional speaking rate. */
export function buildSsml(text: string, voice: string, rate?: number): string {
  const locale = voice.split("-").slice(0, 2).join("-");
  const inner = escapeXml(text);
  const body =
    rate && rate !== 1
      ? `<prosody rate="${rate.toFixed(2)}">${inner}</prosody>`
      : inner;
  return `<speak version="1.0" xml:lang="${locale}"><voice xml:lang="${locale}" name="${voice}">${body}</voice></speak>`;
}

/** One spoken segment in a batched SSML document: text preceded by a silence gap. */
export type SsmlSegment = {
  /** Silence (ms) to insert before this segment's speech. */
  breakMs: number;
  text: string;
};

/**
 * Build a single SSML document covering many cues in one request. Each segment's
 * speech is preceded by a `<break>` equal to its inter-cue gap, so the SRT pacing
 * is preserved in one continuous stream. (Drift still accumulates when speech
 * overruns its window — accepted; user retimes in the editor.)
 */
export function buildBatchSsml(segments: SsmlSegment[], voice: string): string {
  const locale = voice.split("-").slice(0, 2).join("-");
  const body = segments
    .map((seg) => {
      const brk = seg.breakMs > 0 ? `<break time="${Math.round(seg.breakMs)}ms"/>` : "";
      return `${brk}${escapeXml(seg.text)}`;
    })
    .join("");
  return `<speak version="1.0" xml:lang="${locale}"><voice xml:lang="${locale}" name="${voice}">${body}</voice></speak>`;
}

/**
 * Synthesize `text` to speech. Returns audio as an ArrayBuffer.
 */
export async function synthesizeSpeech(
  text: string,
  options: TtsOptions = {}
): Promise<ArrayBuffer> {
  const voice = options.voice ?? DEFAULT_VOICE;
  const ssml = buildSsml(text, voice, options.rate);
  return synthesizeSsml(ssml, options.format ?? DEFAULT_FORMAT);
}

/**
 * Synthesize a full, pre-built SSML document. Returns audio as an ArrayBuffer.
 * Used for batched multi-cue requests.
 */
export async function synthesizeSsml(
  ssml: string,
  format: string = DEFAULT_FORMAT,
): Promise<ArrayBuffer> {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    throw new Error(
      "Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION env var"
    );
  }

  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

  // Hold a global permit for the whole request (including backoff sleeps) so a
  // throttled call doesn't free its slot for another to immediately pile on.
  return ttsLimiter().run(() => synthesizeOnce(url, key, ssml, format));
}

async function synthesizeOnce(
  url: string,
  key: string,
  ssml: string,
  format: string,
): Promise<ArrayBuffer> {
  // Azure throttles bursts with 429 ("Downstream Service Throttled"). Retry a
  // few times with backoff (honoring Retry-After) before giving up.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": format,
        "User-Agent": "auto-recap",
      },
      body: ssml,
    });

    if (res.ok) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 0) return buf;
      // Empty 200 — Azure sometimes does this under load. Treat as transient.
      if (attempt < MAX_ATTEMPTS) {
        await Bun.sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error("TTS returned empty audio after retries");
    }

    const retryable = res.status === 429 || res.status === 503;
    if (retryable && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 500 * 2 ** (attempt - 1); // 0.5s, 1s, 2s, 4s
      await Bun.sleep(waitMs);
      continue;
    }

    const detail = await res.text();
    throw new Error(`TTS failed: ${res.status} ${res.statusText} ${detail}`);
  }
}
