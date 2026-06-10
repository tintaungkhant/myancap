/** Runs the 6 pipeline stages for one job. No recovery: fail → notify → clean. */
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getConfig } from "../config";
import * as youtube from "../services/youtube";
import { transcribe } from "../services/transcribe";
import { translateSrt } from "../services/translate";
import { srtToSpeech } from "../services/srt-tts";
import { wavToMp3 } from "../services/audio";
import {
  sendVideo,
  sendDocument,
  sendAudio,
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
  wavToMp3: typeof wavToMp3;
  sendVideo: typeof sendVideo;
  sendDocument: typeof sendDocument;
  sendAudio: typeof sendAudio;
  sendMessage: typeof sendMessage;
};

const defaultDeps: RunDeps = {
  probe: youtube.probe,
  download: youtube.download,
  transcribe,
  translateSrt,
  srtToSpeech,
  wavToMp3,
  sendVideo,
  sendDocument,
  sendAudio,
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
    const mp3Path = join(job.dir, "dub.mp3");
    await Bun.write(wavPath, wav);
    await deps.wavToMp3(wavPath, mp3Path);

    stage("send", "📤 file တွေပို့နေသည်");
    const base = slugify(meta.title, job.youtubeId);

    // Each upload is independent and retried — a dropped socket on one file
    // (Telegram occasionally closes the connection mid-upload) must not abort
    // the whole job or block the others.
    const send = async (label: string, fn: () => Promise<unknown>) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fn();
          return;
        } catch (e) {
          console.error(`job ${job.id}: ${label} attempt ${attempt}/3 failed:`, e);
          if (attempt < 3) await Bun.sleep(1500 * attempt);
        }
      }
      console.error(`job ${job.id}: ${label} gave up`);
    };

    // The video may exceed Telegram's 50 MB upload cap. If so, skip it but still
    // deliver the subtitle + dub — a partial result beats nothing.
    const videoBytes = new Uint8Array(await Bun.file(videoPath).arrayBuffer());
    if (videoBytes.byteLength > VIDEO_MAX_BYTES) {
      await deps
        .sendMessage(job.chatId, "⚠️ video ကြီးလွန်းလို့ မပို့နိုင်ပါ — စာတန်းနဲ့ မြန်မာသံ ဖိုင်တွေပဲ ပို့ပါမယ်")
        .catch(() => {});
    } else {
      await send("sendVideo", () => deps.sendVideo(job.chatId, videoBytes, `${base}.mp4`));
    }
    await send("sendMy", () =>
      deps.sendDocument(job.chatId, new TextEncoder().encode(mySrt), `${base}.my.srt`, "application/x-subrip"),
    );
    await send("sendEn", () =>
      deps.sendDocument(job.chatId, new TextEncoder().encode(enSrt), `${base}.en.srt`, "application/x-subrip"),
    );
    const mp3Bytes = new Uint8Array(await Bun.file(mp3Path).arrayBuffer());
    console.log(`job ${job.id}: sending mp3 (${mp3Bytes.byteLength} bytes)`);
    await send("sendMp3", async () => {
      // Prefer inline-playable audio; if Telegram rejects it, deliver as a document.
      try {
        await deps.sendAudio(job.chatId, mp3Bytes, `${base}.mp3`);
      } catch {
        await deps.sendDocument(job.chatId, mp3Bytes, `${base}.mp3`, "audio/mpeg");
      }
    });
  } catch (e) {
    console.error(`job ${job.id} failed:`, e);
    const msg = e instanceof Error ? e.message : String(e);
    await deps.sendMessage(job.chatId, `❌ မအောင်မြင်ပါ — ${msg}`).catch(() => {});
  } finally {
    // Ephemeral: wipe all state for this job — the row (releases the per-user
    // lock) and the temp dir — whether it succeeded or failed.
    deleteJob(db, job.id);
    await cleanupJobDir(job.dir);
  }
}
