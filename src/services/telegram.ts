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

/** Extract the file_id from a sendVideo/sendAudio/sendDocument response. */
function fileIdFrom(result: any, key: "video" | "audio" | "document"): string {
  const id = result?.result?.[key]?.file_id;
  if (typeof id !== "string") throw new Error(`Telegram ${key}: no file_id in response`);
  return id;
}

/** Send an MP4 video. Returns its file_id. */
export async function sendVideo(
  chatId: number,
  mp4: Uint8Array,
  filename = "video.mp4"
): Promise<string> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "video",
    new Blob([mp4.buffer as ArrayBuffer], { type: "video/mp4" }),
    filename
  );

  const res = await fetch(apiUrl("sendVideo"), { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`sendVideo failed: ${res.status} ${await res.text()}`);
  }
  return fileIdFrom(await res.json(), "video");
}

/** Send an audio file. Returns its file_id. */
export async function sendAudio(
  chatId: number,
  audio: Uint8Array,
  filename = "recap.mp3"
): Promise<string> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "audio",
    new Blob([audio.buffer as ArrayBuffer], { type: "audio/mpeg" }),
    filename
  );

  const res = await fetch(apiUrl("sendAudio"), { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`sendAudio failed: ${res.status} ${await res.text()}`);
  }
  return fileIdFrom(await res.json(), "audio");
}

/** Send an arbitrary file as a document. Returns its file_id. */
export async function sendDocument(
  chatId: number,
  bytes: Uint8Array,
  filename: string,
  mime = "application/octet-stream"
): Promise<string> {
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
  return fileIdFrom(await res.json(), "document");
}

/** Re-send an already-uploaded file by its file_id (no re-upload). */
async function sendById(
  method: string,
  key: "video" | "audio" | "document",
  chatId: number,
  fileId: string,
): Promise<void> {
  const res = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, [key]: fileId }),
  });
  if (!res.ok) throw new Error(`${method} (by id) failed: ${res.status} ${await res.text()}`);
}

export const sendVideoById = (chatId: number, fileId: string) => sendById("sendVideo", "video", chatId, fileId);
export const sendAudioById = (chatId: number, fileId: string) => sendById("sendAudio", "audio", chatId, fileId);
export const sendDocumentById = (chatId: number, fileId: string) => sendById("sendDocument", "document", chatId, fileId);
