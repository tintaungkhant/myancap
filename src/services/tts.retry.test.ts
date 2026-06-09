import { afterEach, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("retries on 429 then succeeds", async () => {
  process.env.AZURE_SPEECH_KEY = "k";
  process.env.AZURE_SPEECH_REGION = "r";

  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) return new Response("throttled", { status: 429 });
    return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });
  }) as any;

  const { synthesizeSpeech } = await import("./tts");
  const buf = await synthesizeSpeech("hi");

  expect(calls).toBe(2);
  expect(buf.byteLength).toBe(3);
});
