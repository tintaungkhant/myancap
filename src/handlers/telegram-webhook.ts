/**
 * Telegram webhook handler.
 *
 * User sends an SRT as a text message -> bot replies with a timed MP3.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN      - bot token
 *   TELEGRAM_WEBHOOK_SECRET - (optional) secret token to verify requests
 */

import { srtToSpeech } from "../services/srt-tts";
import { wavToMp3 } from "../services/audio";
import { sendAudio, sendDocument, sendMessage } from "../services/telegram";

type TelegramUpdate = {
  message?: {
    chat: { id: number };
    text?: string;
  };
};

/** Does the text look like an SRT (has a timestamp arrow)? */
function looksLikeSrt(text: string): boolean {
  return /\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(text);
}

/** Generate audio and reply. Runs in background; errors are reported to chat. */
async function generateAndReply(chatId: number, srt: string): Promise<void> {
  try {
    const wav = await srtToSpeech(srt);
    const mp3 = await wavToMp3(wav);
    await sendDocument(
      chatId,
      new TextEncoder().encode(srt),
      "recap.srt",
      "application/x-subrip"
    );
    await sendAudio(chatId, mp3);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(chatId, `❌ Failed: ${msg}`).catch(() => {});
  }
}

/**
 * Handle one webhook update. Returns immediately (acks Telegram) and
 * does the slow TTS work in the background.
 */
export function handleUpdate(update: TelegramUpdate): void {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (!looksLikeSrt(text)) {
    sendMessage(
      chatId,
      "Send me an SRT subtitle as text and I'll voice it as an MP3."
    ).catch(() => {});
    return;
  }

  console.log('hi');

  sendMessage(chatId, "🎙️ Generating audio…").catch(() => {});
  // Fire-and-forget: do not block the webhook response.
  void generateAndReply(chatId, text);
}

/** Verify the optional Telegram secret-token header. */
export function verifySecret(header: string | undefined): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return true; // not configured -> skip check
  return header === secret;
}
