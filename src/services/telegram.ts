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

/** Extract the file_id from a sendAudio/sendDocument response. */
function fileIdFrom(result: any, key: "audio" | "document"): string {
  const id = result?.result?.[key]?.file_id;
  if (typeof id !== "string") throw new Error(`Telegram ${key}: no file_id in response`);
  return id;
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

/** Build the file-download URL (different host path than the API methods). */
function fileUrl(filePath: string): string {
  return `https://api.telegram.org/file/bot${token()}/${filePath}`;
}

/** Resolve a file_id to a downloadable file_path (+ size if Telegram reports it). */
export async function getFile(fileId: string): Promise<{ filePath: string; fileSize?: number }> {
  const res = await fetch(apiUrl("getFile"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) {
    throw new Error(`getFile failed: ${res.status} ${await res.text()}`);
  }
  const body: any = await res.json();
  const filePath = body?.result?.file_path;
  if (typeof filePath !== "string") {
    throw new Error("getFile: no file_path in response");
  }
  const fileSize = body?.result?.file_size;
  return { filePath, fileSize: typeof fileSize === "number" ? fileSize : undefined };
}

/** Download a Telegram file (by file_path from getFile) to a local path. */
export async function downloadFile(filePath: string, destPath: string): Promise<void> {
  const res = await fetch(fileUrl(filePath));
  if (!res.ok) {
    throw new Error(`downloadFile failed: ${res.status} ${await res.text()}`);
  }
  await Bun.write(destPath, await res.arrayBuffer());
}
