/**
 * SRT -> timed TTS audio.
 *
 * Synthesizes each subtitle cue with Azure TTS as raw PCM, then assembles
 * one WAV file on the subtitle timeline: silence fills the gaps so each
 * cue starts at its SRT timestamp. Cues whose speech is longer than their
 * window are sped up (SSML prosody rate) to fit.
 */

import {
  synthesizeSpeech,
  synthesizeSsml,
  buildBatchSsml,
  DEFAULT_VOICE,
  type SsmlSegment,
} from "./tts";
import { parseSrt, type Cue } from "../lib/srt";

// Re-export so existing importers of parseSrt from this module keep working.
export { parseSrt, type Cue };

// Azure raw PCM output: 16 kHz, 16-bit, mono.
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;
const PCM_FORMAT = "raw-16khz-16bit-mono-pcm";
const DEFAULT_MAX_RATE = 1; // 1 = constant natural speed (no per-cue speed-up)
const DEFAULT_CONCURRENCY = 3; // cap parallel Azure calls to avoid 429 throttling
const MAX_GAP_SECONDS = 30; // clamp silence between cues — guards against a bogus
                            // far-future timestamp creating minutes of silence

export type SrtTtsOptions = {
  voice?: string;
  /** Cap on prosody speed-up. Above it, cues overflow (and drift) instead of
   * compressing further — natural voice beats chipmunk. */
  maxRate?: number;
  /** Max simultaneous TTS requests. Too high → Azure 429. */
  concurrency?: number;
  /** 0 = one Azure call per cue. >0 = group cues into one call per ~N spoken
   * seconds (fewer calls; some intra-group drift). */
  groupSeconds?: number;
};

/** Map with a bounded number of concurrent workers; preserves input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

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

/** Concatenate PCM chunks into one buffer. */
function concatPcm(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Synthesize one cue, speeding up if its speech overruns the window. */
async function synthCue(cue: Cue, voice: string, maxRate: number): Promise<Uint8Array> {
  const window = cue.end - cue.start;

  const first = new Uint8Array(
    await synthesizeSpeech(cue.text, { voice, format: PCM_FORMAT })
  );
  if (pcmDuration(first.length) <= window || window <= 0) return first;

  const ratio = pcmDuration(first.length) / window;
  if (ratio <= 1) return first;
  const rate = Math.min(maxRate, ratio);
  if (rate <= 1) return first;
  return new Uint8Array(
    await synthesizeSpeech(cue.text, { voice, format: PCM_FORMAT, rate })
  );
}

/**
 * Group consecutive cues so each group's spoken length stays under `budgetSec`.
 * A cue larger than the budget becomes its own group. Estimate uses the cue's
 * SRT window (end - start) — the planned spoken length.
 */
export function groupCues(cues: Cue[], budgetSec: number): Cue[][] {
  const groups: Cue[][] = [];
  let current: Cue[] = [];
  let acc = 0;
  for (const cue of cues) {
    const dur = Math.max(0, cue.end - cue.start);
    if (current.length > 0 && acc + dur > budgetSec) {
      groups.push(current);
      current = [];
      acc = 0;
    }
    current.push(cue);
    acc += dur;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Chunked-batch path: one Azure call per GROUP of cues (not per cue). Each group
 * is one SSML doc with internal `<break>`s for the gaps between its cues, kept
 * short (≤ budgetSec) to dodge the REST endpoint's long-synthesis truncation.
 * Fewer calls than per-cue; some intra-group drift if speech overruns.
 */
async function groupSynthesize(
  cues: Cue[],
  voice: string,
  budgetSec: number,
  concurrency: number,
): Promise<Uint8Array> {
  const groups = groupCues(cues, budgetSec);

  // Synthesize each group concurrently (bounded). One Azure request per group.
  const groupAudios = await mapLimit(groups, concurrency, (group) => {
    const segments: SsmlSegment[] = group.map((cue, i) => {
      // First cue in a group is anchored by the group's placement, so no leading
      // break. Later cues get the in-group gap from the previous cue's end.
      const breakMs =
        i === 0
          ? 0
          : Math.max(0, Math.min(MAX_GAP_SECONDS, cue.start - group[i - 1].end)) * 1000;
      return { breakMs, text: cue.text };
    });
    const ssml = buildBatchSsml(segments, voice);
    return synthesizeSsml(ssml, PCM_FORMAT).then((buf) => new Uint8Array(buf));
  });

  // Lay the groups on the timeline by each group's first cue start.
  const parts: Uint8Array[] = [];
  let cursor = 0;
  groups.forEach((group, i) => {
    const gap = Math.max(0, Math.min(MAX_GAP_SECONDS, group[0].start - cursor));
    if (gap > 0) parts.push(silence(gap));
    parts.push(groupAudios[i]);
    cursor = cursor + gap + pcmDuration(groupAudios[i].length);
  });

  return concatPcm(parts);
}

async function perCueSynthesize(
  cues: Cue[],
  voice: string,
  maxRate: number,
  concurrency: number,
): Promise<Uint8Array> {
  const audios = await mapLimit(cues, concurrency, (cue) => synthCue(cue, voice, maxRate));

  const parts: Uint8Array[] = [];
  let cursor = 0; // current timeline position, seconds
  cues.forEach((cue, i) => {
    // Clamp the gap: negative (previous cue overran) → 0; absurdly large (bad
    // timestamp) → MAX_GAP_SECONDS. Place this cue after the clamped silence.
    const gap = Math.max(0, Math.min(MAX_GAP_SECONDS, cue.start - cursor));
    if (gap > 0) parts.push(silence(gap));
    parts.push(audios[i]);
    cursor = cursor + gap + pcmDuration(audios[i].length);
  });

  return concatPcm(parts);
}

/**
 * Render an SRT string into a single timed WAV buffer. By default one Azure
 * request per cue (kept small — the REST endpoint truncates long single-request
 * synthesis); `groupSeconds > 0` batches cues into ~N-second groups to cut call
 * volume. Either way bounded by `concurrency` to avoid 429 throttling.
 */
export async function srtToSpeech(
  srt: string,
  options: SrtTtsOptions = {}
): Promise<Uint8Array> {
  const cues = parseSrt(srt);
  if (cues.length === 0) throw new Error("No cues parsed from SRT");

  const voice = options.voice ?? DEFAULT_VOICE;
  const maxRate = options.maxRate ?? DEFAULT_MAX_RATE;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const groupSeconds = options.groupSeconds ?? 0;

  // groupSeconds > 0 → one Azure call per group of cues (fewer calls); otherwise
  // one call per cue (default, safest — no truncation, exact per-cue timing).
  const pcm =
    groupSeconds > 0
      ? await groupSynthesize(cues, voice, groupSeconds, concurrency)
      : await perCueSynthesize(cues, voice, maxRate, concurrency);
  return pcmToWav(pcm);
}
