import { afterEach, beforeEach, expect, test } from "bun:test";

const realFetch = globalThis.fetch;
beforeEach(() => { process.env.TELEGRAM_BOT_TOKEN = "BOT123"; });
afterEach(() => { globalThis.fetch = realFetch; });

test("sendVideo posts to the bot endpoint and returns the file_id", async () => {
  let seenUrl = "";
  globalThis.fetch = (async (url: any) => {
    seenUrl = String(url);
    return new Response(
      JSON.stringify({ ok: true, result: { video: { file_id: "VID_FILE_ID" } } }),
      { status: 200 },
    );
  }) as any;

  const { sendVideo } = await import("./telegram");
  const id = await sendVideo(7, new Uint8Array([1, 2, 3]), "clip.mp4");

  expect(seenUrl).toBe("https://api.telegram.org/botBOT123/sendVideo");
  expect(id).toBe("VID_FILE_ID");
});
