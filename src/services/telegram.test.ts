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

test("getFile returns file_path and file_size", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ ok: true, result: { file_path: "videos/file_1.mp4", file_size: 1234 } }),
      { status: 200 },
    )) as any;

  const { getFile } = await import("./telegram");
  const f = await getFile("FILE_ID");
  expect(f.filePath).toBe("videos/file_1.mp4");
  expect(f.fileSize).toBe(1234);
});

test("downloadFile writes the response bytes to dest", async () => {
  globalThis.fetch = (async (url: any) => {
    expect(String(url)).toBe("https://api.telegram.org/file/botBOT123/videos/file_1.mp4");
    return new Response(new Uint8Array([9, 8, 7]), { status: 200 });
  }) as any;

  const { downloadFile } = await import("./telegram");
  const dest = "/tmp/myancap-dl-test.bin";
  await downloadFile("videos/file_1.mp4", dest);
  const bytes = new Uint8Array(await Bun.file(dest).arrayBuffer());
  expect(Array.from(bytes)).toEqual([9, 8, 7]);
});

test("downloadFile throws on non-ok", async () => {
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as any;
  const { downloadFile } = await import("./telegram");
  await expect(downloadFile("x/y.mp4", "/tmp/myancap-dl-test2.bin")).rejects.toThrow();
});
