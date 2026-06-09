/** OpenAI whisper-1 transcription. Returns a timestamped English SRT string. */
import { getConfig } from "../config";

export async function transcribe(mp3Path: string): Promise<string> {
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("language", "en");
  form.append("response_format", "srt");
  form.append("file", Bun.file(mp3Path));

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${getConfig().openaiApiKey}` },
    body: form,
  });

  if (!res.ok) {
    throw new Error(`whisper-1 failed: ${res.status} ${await res.text()}`);
  }
  return res.text();
}
