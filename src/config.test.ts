import { expect, test } from "bun:test";
import { loadConfig } from "./config";

const full = {
  TELEGRAM_BOT_TOKEN: "t",
  OPENAI_API_KEY: "o",
  GEMINI_API_KEY: "g",
  AZURE_SPEECH_KEY: "a",
  AWS_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
  AWS_ACCESS_KEY_ID: "rk",
  AWS_SECRET_ACCESS_KEY: "rs",
  AWS_BUCKET: "vids",
  AWS_URL: "https://media.example.com",
};

test("loads required keys and applies defaults", () => {
  const c = loadConfig(full);
  expect(c.telegramBotToken).toBe("t");
  expect(c.azureSpeechRegion).toBe("southeastasia");
  expect(c.ttsVoice).toBe("my-MM-ThihaNeural");
  expect(c.maxVideoSeconds).toBe(900);
  expect(c.maxVideoHeight).toBe(1080);
  expect(c.r2Bucket).toBe("vids");
  expect(c.r2PublicBaseUrl).toBe("https://media.example.com");
  expect(c.r2KeyPrefix).toBe("");
  expect(c.maxTtsRate).toBe(1);
  expect(c.ttsConcurrency).toBe(3);
  expect(c.port).toBe(3000);
  expect(c.telegramWebhookSecret).toBeUndefined();
});

test("throws listing every missing required key", () => {
  expect(() => loadConfig({})).toThrow(
    /TELEGRAM_BOT_TOKEN.*OPENAI_API_KEY.*GEMINI_API_KEY.*AZURE_SPEECH_KEY/s,
  );
});

test("throws listing missing R2 keys", () => {
  expect(() => loadConfig({ TELEGRAM_BOT_TOKEN: "t", OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", AZURE_SPEECH_KEY: "a" }))
    .toThrow(/AWS_ENDPOINT.*AWS_ACCESS_KEY_ID.*AWS_SECRET_ACCESS_KEY.*AWS_BUCKET.*AWS_URL/s);
});

test("rejects a non-positive-integer numeric", () => {
  expect(() => loadConfig({ ...full, MAX_VIDEO_SECONDS: "0" })).toThrow(
    /MAX_VIDEO_SECONDS/,
  );
  expect(() => loadConfig({ ...full, PORT: "abc" })).toThrow(/PORT/);
});

test("the config object is frozen", () => {
  const c = loadConfig(full);
  expect(Object.isFrozen(c)).toBe(true);
});
