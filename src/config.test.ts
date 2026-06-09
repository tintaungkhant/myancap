import { expect, test } from "bun:test";
import { loadConfig } from "./config";

const full = {
  TELEGRAM_BOT_TOKEN: "t",
  OPENAI_API_KEY: "o",
  GEMINI_API_KEY: "g",
  AZURE_SPEECH_KEY: "a",
};

test("loads required keys and applies defaults", () => {
  const c = loadConfig(full);
  expect(c.telegramBotToken).toBe("t");
  expect(c.azureSpeechRegion).toBe("southeastasia");
  expect(c.ttsVoice).toBe("my-MM-ThihaNeural");
  expect(c.maxVideoSeconds).toBe(900);
  expect(c.port).toBe(3000);
  expect(c.telegramWebhookSecret).toBeUndefined();
});

test("throws listing every missing required key", () => {
  expect(() => loadConfig({})).toThrow(
    /TELEGRAM_BOT_TOKEN.*OPENAI_API_KEY.*GEMINI_API_KEY.*AZURE_SPEECH_KEY/s,
  );
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
