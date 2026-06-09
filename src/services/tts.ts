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

const DEFAULT_VOICE = "my-MM-NilarNeural";
const DEFAULT_FORMAT = "audio-16khz-128kbitrate-mono-mp3";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Synthesize `text` to speech. Returns audio as an ArrayBuffer.
 */
export async function synthesizeSpeech(
  text: string,
  options: TtsOptions = {}
): Promise<ArrayBuffer> {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;

  if (!key || !region) {
    throw new Error(
      "Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION env var"
    );
  }

  const voice = options.voice ?? DEFAULT_VOICE;
  const format = options.format ?? DEFAULT_FORMAT;
  const locale = voice.split("-").slice(0, 2).join("-");

  const inner = escapeXml(text);
  const body =
    options.rate && options.rate !== 1
      ? `<prosody rate="${options.rate.toFixed(2)}">${inner}</prosody>`
      : inner;

  const ssml = `<speak version="1.0" xml:lang="${locale}"><voice xml:lang="${locale}" name="${voice}">${body}</voice></speak>`;

  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

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

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`TTS failed: ${res.status} ${res.statusText} ${detail}`);
  }

  return res.arrayBuffer();
}
