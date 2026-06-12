import { afterEach, beforeEach, expect, test } from "bun:test";
import { objectKey } from "./r2";

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.OPENAI_API_KEY = "o";
  process.env.GEMINI_API_KEY = "g";
  process.env.AZURE_SPEECH_KEY = "a";
  process.env.AWS_ENDPOINT = "https://acc.r2.cloudflarestorage.com";
  process.env.AWS_ACCESS_KEY_ID = "rk";
  process.env.AWS_SECRET_ACCESS_KEY = "rs";
  process.env.AWS_BUCKET = "vids";
  process.env.AWS_URL = "https://media.example.com";
});
afterEach(() => { globalThis.fetch = realFetch; });

test("objectKey joins prefix, base, jobId, .mp4", () => {
  expect(objectKey("my_clip", "ab12")).toBe("my_clip-ab12.mp4");
  expect(objectKey("my_clip", "ab12", "videos/")).toBe("videos/my_clip-ab12.mp4");
});

test("uploadVideo PUTs a signed, unsigned-payload request and returns the public URL", async () => {
  const dest = "/tmp/myancap-r2-test.mp4";
  await Bun.write(dest, new Uint8Array([1, 2, 3, 4, 5]));

  let seen: { url: string; method: string; headers: Headers } | null = null;
  globalThis.fetch = (async (req: any) => {
    // aws4fetch passes a Request object after signing.
    seen = { url: req.url, method: req.method, headers: req.headers };
    return new Response("", { status: 200 });
  }) as any;

  const { uploadVideo } = await import("./r2");
  const url = await uploadVideo(dest, "videos/clip-ab12.mp4");

  expect(url).toBe("https://media.example.com/videos/clip-ab12.mp4");
  expect(seen!.method).toBe("PUT");
  expect(seen!.url).toBe("https://acc.r2.cloudflarestorage.com/vids/videos/clip-ab12.mp4");
  expect(seen!.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
  expect(seen!.headers.get("content-length")).toBe("5");
  expect(seen!.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
});

test("uploadVideo throws on a non-2xx response", async () => {
  const dest = "/tmp/myancap-r2-test2.mp4";
  await Bun.write(dest, new Uint8Array([9]));
  globalThis.fetch = (async () => new Response("denied", { status: 403 })) as any;

  const { uploadVideo } = await import("./r2");
  await expect(uploadVideo(dest, "k.mp4")).rejects.toThrow(/403/);
});
