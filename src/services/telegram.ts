/**
 * Minimal Telegram Bot API client.
 *
 * Required env var:
 *   TELEGRAM_BOT_TOKEN - bot token from @BotFather
 */

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("Missing TELEGRAM_BOT_TOKEN env var");
  return t;
}

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${token()}/${method}`;
}

/** Send a plain text message. */
export async function sendMessage(chatId: number, text: string): Promise<void> {
  const res = await fetch(apiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    throw new Error(`sendMessage failed: ${res.status} ${await res.text()}`);
  }
}

/** Send an MP3 audio file. */
export async function sendAudio(
  chatId: number,
  mp3: Uint8Array,
  filename = "recap.mp3"
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "audio",
    new Blob([mp3.buffer as ArrayBuffer], { type: "audio/mpeg" }),
    filename
  );

  const res = await fetch(apiUrl("sendAudio"), { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`sendAudio failed: ${res.status} ${await res.text()}`);
  }
}

/** Send an arbitrary file as a document. */
export async function sendDocument(
  chatId: number,
  bytes: Uint8Array,
  filename: string,
  mime = "application/octet-stream"
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "document",
    new Blob([bytes.buffer as ArrayBuffer], { type: mime }),
    filename
  );

  const res = await fetch(apiUrl("sendDocument"), { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`sendDocument failed: ${res.status} ${await res.text()}`);
  }
}
