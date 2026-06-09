import { afterEach, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function setEnv() {
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.GEMINI_API_KEY = "g";
  process.env.AZURE_SPEECH_KEY = "a";
}

test("posts to OpenAI with auth header and returns the srt body", async () => {
  setEnv();
  let seenUrl = "";
  let seenAuth = "";
  globalThis.fetch = (async (url: any, init: any) => {
    seenUrl = String(url);
    seenAuth = init.headers.Authorization;
    return new Response("1\n00:00:01,000 --> 00:00:02,000\nHi\n", { status: 200 });
  }) as any;

  const { transcribe } = await import("./transcribe");
  const srt = await transcribe("/tmp/audio.mp3");

  expect(seenUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect(seenAuth).toBe("Bearer sk-test");
  expect(srt).toContain("--> 00:00:02,000");
});
