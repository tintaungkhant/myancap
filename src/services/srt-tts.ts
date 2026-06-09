/**
 * SRT -> timed TTS audio.
 *
 * Synthesizes each subtitle cue with Azure TTS as raw PCM, then assembles
 * one WAV file on the subtitle timeline: silence fills the gaps so each
 * cue starts at its SRT timestamp. Cues whose speech is longer than their
 * window are sped up (SSML prosody rate) to fit.
 */

import { synthesizeSpeech } from "./tts";
import { parseSrt, type Cue } from "../lib/srt";

// Re-export so existing importers of parseSrt from this module keep working.
export { parseSrt, type Cue };

// Azure raw PCM output: 16 kHz, 16-bit, mono.
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;
const PCM_FORMAT = "raw-16khz-16bit-mono-pcm";
const MAX_RATE = 2.5; // never compress beyond this

export type SrtTtsOptions = {
  voice?: string;
};

/** Duration of a raw-PCM buffer in seconds. */
function pcmDuration(bytes: number): number {
  return bytes / BYTES_PER_SEC;
}

/** A silence buffer of the given duration (clamped to >= 0). */
function silence(seconds: number): Uint8Array {
  const n = Math.max(0, Math.round(seconds * BYTES_PER_SEC));
  // Force even length (16-bit samples).
  return new Uint8Array(n - (n % BYTES_PER_SAMPLE));
}

/** Wrap raw little-endian PCM in a WAV (RIFF) container. */
function pcmToWav(pcm: Uint8Array): Uint8Array {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM format
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, BYTES_PER_SEC, true);
  v.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  v.setUint32(40, pcm.length, true);

  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/** Synthesize one cue, speeding up if its speech overruns the window. */
async function synthCue(cue: Cue, voice?: string): Promise<Uint8Array> {
  const window = cue.end - cue.start;

  const first = new Uint8Array(
    await synthesizeSpeech(cue.text, { voice, format: PCM_FORMAT })
  );
  if (pcmDuration(first.length) <= window || window <= 0) return first;

  const rate = Math.min(MAX_RATE, pcmDuration(first.length) / window);
  const fitted = new Uint8Array(
    await synthesizeSpeech(cue.text, { voice, format: PCM_FORMAT, rate })
  );
  return fitted;
}

/**
 * Render an SRT string into a single timed WAV buffer.
 * Returns a Uint8Array (WAV bytes).
 */
export async function srtToSpeech(
  srt: string,
  options: SrtTtsOptions = {}
): Promise<Uint8Array> {
  const cues = parseSrt(srt);
  if (cues.length === 0) throw new Error("No cues parsed from SRT");

  // Synthesize cues in parallel (network-bound), keep order.
  const audios = await Promise.all(
    cues.map((cue) => synthCue(cue, options.voice))
  );

  const parts: Uint8Array[] = [];
  let cursor = 0; // current timeline position, seconds

  cues.forEach((cue, i) => {
    const gap = cue.start - cursor;
    if (gap > 0) parts.push(silence(gap));

    const audio = audios[i];
    parts.push(audio);
    cursor = Math.max(cursor, cue.start) + pcmDuration(audio.length);
  });

  const total = parts.reduce((n, p) => n + p.length, 0);
  const pcm = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    pcm.set(p, off);
    off += p.length;
  }

  return pcmToWav(pcm);
}
