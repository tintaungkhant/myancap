/** Telegram webhook ingress: gate the update, then enqueue a pipeline job. */
import type { Database } from "bun:sqlite";
import { getConfig } from "../config";
import { extractYouTubeId } from "../services/youtube";
import { sendMessage } from "../services/telegram";
import {
  markUpdateProcessed,
  hasActiveJob,
  insertJob,
} from "../services/store";
import { newJobId, createJobDir, type Job } from "../pipeline/job";
import type { Semaphore } from "../pipeline/queue";
import { runJob } from "../pipeline/run";

type Update = {
  update_id?: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
};

/**
 * Injectable surface — defaults wire the real implementations. Tests pass stubs
 * (avoids Bun's process-global `mock.module` leakage between files).
 */
export type WebhookDeps = {
  runJob: typeof runJob;
  sendMessage: typeof sendMessage;
};

const defaultDeps: WebhookDeps = {
  runJob,
  sendMessage,
};

/** Verify the optional Telegram secret-token header. */
export function verifySecret(header: string | undefined): boolean {
  const secret = getConfig().telegramWebhookSecret;
  if (!secret) return true;
  return header === secret;
}

/** Handle one webhook update. Acks fast; heavy work runs in the background. */
export async function handleUpdate(
  db: Database,
  sem: Semaphore,
  update: Update,
  deps: WebhookDeps = defaultDeps,
): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const telegramId = msg.from?.id ?? chatId;
  const now = Date.now();

  // Gate 1: dedup Telegram retries.
  if (update.update_id !== undefined && !markUpdateProcessed(db, update.update_id, now)) {
    return;
  }

  // Gate 2: must be a YouTube link.
  const youtubeId = extractYouTubeId(msg.text);
  if (!youtubeId) {
    await deps.sendMessage(chatId, "❌ YouTube link ပို့ပါ").catch(() => {});
    return;
  }

  // Gate 3: one active job per user (the only state that persists, and only
  // while processing).
  if (hasActiveJob(db, telegramId)) {
    await deps.sendMessage(chatId, "⏳ ယခင် video ပြီးအောင် စောင့်ပါ").catch(() => {});
    return;
  }

  // Enqueue.
  const id = newJobId();
  const url = `https://www.youtube.com/watch?v=${youtubeId}`;
  insertJob(db, { id, telegramId, url, youtubeId, now });
  const dir = await createJobDir(id);
  await deps.sendMessage(chatId, "🎬 လုပ်ဆောင်နေသည်").catch(() => {});

  const job: Job = { id, telegramId, chatId, url, youtubeId, dir };
  void sem.run(() => deps.runJob(db, job));
}
