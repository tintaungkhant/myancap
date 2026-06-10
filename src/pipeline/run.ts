/** Runs the 6 pipeline stages for one job. No recovery: fail → notify → clean. */
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getConfig } from "../config";
import * as youtube from "../services/youtube";
import { transcribe } from "../services/transcribe";
import { translateSrt } from "../services/translate";
import { srtToSpeech } from "../services/srt-tts";
import { wavToAac } from "../services/audio";
import {
  sendVideo,
  sendDocument,
  sendMessage,
} from "../services/telegram";
import { slugify } from "../lib/slug";
import { setJobStatus, deleteJob } from "../services/store";
import { cleanupJobDir, type Job } from "./job";

const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Injectable service surface — defaults wire the real services. Tests pass
 * stubs (avoids Bun's process-global `mock.module` leakage between files).
 */
export type RunDeps = {
  probe: typeof youtube.probe;
  download: typeof youtube.download;
  transcribe: typeof transcribe;
  translateSrt: typeof translateSrt;
  srtToSpeech: typeof srtToSpeech;
  wavToAac: typeof wavToAac;
  sendVideo: typeof sendVideo;
  sendDocument: typeof sendDocument;
  sendMessage: typeof sendMessage;
};

const defaultDeps: RunDeps = {
  probe: youtube.probe,
  download: youtube.download,
  transcribe,
  translateSrt,
  srtToSpeech,
  wavToAac,
  sendVideo,
  sendDocument,
  sendMessage,
};

export async function runJob(
  db: Database,
  job: Job,
  deps: RunDeps = defaultDeps,
): Promise<void> {
  const cfg = getConfig();
  const stage = (s: string, msg: string) => {
    setJobStatus(db, job.id, "running", { stage: s, now: Date.now() });
    void deps.sendMessage(job.chatId, msg).catch(() => {});
  };

  try {
    stage("download", "⬇️ video download နေသည်");
    const meta = await deps.probe(job.url);
    if (meta.durationSeconds > cfg.maxVideoSeconds) {
      const max = Math.round(cfg.maxVideoSeconds / 60);
      throw new Error(`Video too long (max ${max} min)`);
    }
    const { videoPath, audioPath } = await deps.download(job.url, job.dir);

    stage("transcribe", "📝 စာတန်းထိုးထုတ်နေသည်");
    const enSrt = await deps.transcribe(audioPath);

    stage("translate", "🌐 ဘာသာပြန်နေသည်");
    const mySrt = await deps.translateSrt(enSrt);

    stage("tts", "🎙️ မြန်မာသံထုတ်နေသည်");
    const wav = await deps.srtToSpeech(mySrt, {
      voice: cfg.ttsVoice,
      maxRate: cfg.maxTtsRate,
      concurrency: cfg.ttsConcurrency,
    });
    const wavPath = join(job.dir, "dub.wav");
    const aacPath = join(job.dir, "dub.aac");
    await Bun.write(wavPath, wav);
    await deps.wavToAac(wavPath, aacPath);

    stage("send", "📤 file တွေပို့နေသည်");
    const base = slugify(meta.title, job.youtubeId);

    // The video may exceed Telegram's 50 MB upload cap. If so, skip it but still
    // deliver the subtitle + dub — a partial result beats nothing.
    const videoBytes = new Uint8Array(await Bun.file(videoPath).arrayBuffer());
    if (videoBytes.byteLength > VIDEO_MAX_BYTES) {
      await deps
        .sendMessage(job.chatId, "⚠️ video ကြီးလွန်းလို့ မပို့နိုင်ပါ — စာတန်းနဲ့ မြန်မာသံ ဖိုင်တွေပဲ ပို့ပါမယ်")
        .catch(() => {});
    } else {
      await deps.sendVideo(job.chatId, videoBytes, `${base}.mp4`);
    }
    await deps.sendDocument(
      job.chatId,
      new TextEncoder().encode(mySrt),
      `${base}.my.srt`,
      "application/x-subrip",
    );
    await deps.sendDocument(
      job.chatId,
      new TextEncoder().encode(enSrt),
      `${base}.en.srt`,
      "application/x-subrip",
    );
    const aacBytes = new Uint8Array(await Bun.file(aacPath).arrayBuffer());
    // Sent as a document, not sendAudio: Telegram's audio endpoint only accepts
    // mp3/m4a and would reject a raw .aac. A document arrives untouched.
    await deps.sendDocument(job.chatId, aacBytes, `${base}.aac`, "audio/aac");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await deps.sendMessage(job.chatId, `❌ မအောင်မြင်ပါ — ${msg}`).catch(() => {});
  } finally {
    // Ephemeral: wipe all state for this job — the row (releases the per-user
    // lock) and the temp dir — whether it succeeded or failed.
    deleteJob(db, job.id);
    await cleanupJobDir(job.dir);
  }
}
