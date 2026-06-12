/** Runs the 6 pipeline stages for one job. No recovery: fail → notify → clean. */
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getConfig } from "../config";
import * as youtube from "../services/youtube";
import { transcribe } from "../services/transcribe";
import { translateSrt } from "../services/translate";
import { srtToSpeech } from "../services/srt-tts";
import { wavToMp3, extractAudio, probeDuration } from "../services/audio";
import {
  sendVideo,
  sendDocument,
  sendAudio,
  sendMessage,
  getFile,
  downloadFile,
} from "../services/telegram";
import { slugify } from "../lib/slug";
import { deleteJob } from "../services/store";
import { cleanupJobDir, type Job } from "./job";

const VIDEO_MAX_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024; // Telegram Bot API getFile cap

/**
 * Injectable service surface — defaults wire the real services. Tests pass
 * stubs (avoids Bun's process-global `mock.module` leakage between files).
 */
export type RunDeps = {
  probe: typeof youtube.probe;
  download: typeof youtube.download;
  getFile: typeof getFile;
  downloadFile: typeof downloadFile;
  probeDuration: typeof probeDuration;
  extractAudio: typeof extractAudio;
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
  getFile,
  downloadFile,
  probeDuration,
  extractAudio,
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
  // Report progress to the chat, one message per stage. Fire-and-forget: a failed
  // status ping must not derail the pipeline. (The job row already holds the lock;
  // no per-stage DB write is needed.)
  const stage = (msg: string) => {
    void deps.sendMessage(job.chatId, msg).catch(() => {});
  };

  try {
    const videoPath = join(job.dir, "video.mp4");
    let base: string;
    let sendVideoBack: boolean;

    stage("⬇️ video download နေသည်");
    if (job.source.kind === "youtube") {
      const meta = await deps.probe(job.source.url);
      if (meta.durationSeconds > cfg.maxVideoSeconds) {
        const max = Math.round(cfg.maxVideoSeconds / 60);
        throw new Error(`Video too long (max ${max} min)`);
      }
      await deps.download(job.source.url, job.dir);
      base = slugify(meta.title, job.source.youtubeId);
      sendVideoBack = true;
    } else {
      const file = await deps.getFile(job.source.fileId);
      if (file.fileSize !== undefined && file.fileSize > DOWNLOAD_MAX_BYTES) {
        throw new Error("Video too big (max 20 MB)");
      }
      await deps.downloadFile(file.filePath, videoPath);
      const durationSeconds = await deps.probeDuration(videoPath);
      if (durationSeconds > cfg.maxVideoSeconds) {
        const max = Math.round(cfg.maxVideoSeconds / 60);
        throw new Error(`Video too long (max ${max} min)`);
      }
      base = `video_${job.id}`;
      sendVideoBack = false;
    }

    const audioPath = join(job.dir, "audio.mp3");
    await deps.extractAudio(videoPath, audioPath);

    stage("📝 စာတန်းထိုးထုတ်နေသည်");
    const enSrt = await deps.transcribe(audioPath);

    stage("🌐 ဘာသာပြန်နေသည်");
    const mySrt = await deps.translateSrt(enSrt);

    stage("🎙️ မြန်မာသံထုတ်နေသည်");
    const wav = await deps.srtToSpeech(mySrt, {
      voice: cfg.ttsVoice,
      maxRate: cfg.maxTtsRate,
      concurrency: cfg.ttsConcurrency,
      groupSeconds: cfg.ttsGroupSeconds,
    });
    const wavPath = join(job.dir, "dub.wav");
    const mp3Path = join(job.dir, "dub.mp3");
    await Bun.write(wavPath, wav);
    await deps.wavToMp3(wavPath, mp3Path);

    stage("📤 file တွေပို့နေသည်");

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

    // The video may exceed Telegram's 50 MB upload cap. Check the size without
    // reading the file; if it fits, load the bytes and send. Skip-with-warning
    // beats nothing — the subtitles + dub still go out below.
    const videoFile = Bun.file(videoPath);
    if (!sendVideoBack) {
      // Video-message job: the user already has the source video; nothing to send back.
    } else if (videoFile.size > VIDEO_MAX_BYTES) {
      await deps
        .sendMessage(job.chatId, "⚠️ video ကြီးလွန်းလို့ မပို့နိုင်ပါ — စာတန်းနဲ့ မြန်မာသံ ဖိုင်တွေပဲ ပို့ပါမယ်")
        .catch(() => {});
    } else {
      const videoBytes = new Uint8Array(await videoFile.arrayBuffer());
      await send("sendVideo", () => deps.sendVideo(job.chatId, videoBytes, `${base}.mp4`));
    }
    await send("sendMy", () =>
      deps.sendDocument(job.chatId, new TextEncoder().encode(mySrt), `${base}.my.srt`, "application/x-subrip"),
    );
    await send("sendEn", () =>
      deps.sendDocument(job.chatId, new TextEncoder().encode(enSrt), `${base}.en.srt`, "application/x-subrip"),
    );
    const mp3Bytes = new Uint8Array(await Bun.file(mp3Path).arrayBuffer());
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
