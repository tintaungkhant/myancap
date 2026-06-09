import { expect, test } from "bun:test";
import { buildSsml, DEFAULT_VOICE } from "./tts";

test("default voice is Thiha", () => {
  expect(DEFAULT_VOICE).toBe("my-MM-ThihaNeural");
});

test("buildSsml wraps text with voice + locale, no prosody at rate 1", () => {
  const ssml = buildSsml("hello", "my-MM-ThihaNeural");
  expect(ssml).toContain('name="my-MM-ThihaNeural"');
  expect(ssml).toContain('xml:lang="my-MM"');
  expect(ssml).not.toContain("<prosody");
});

test("buildSsml adds prosody rate when > 1", () => {
  const ssml = buildSsml("hello", "my-MM-ThihaNeural", 1.5);
  expect(ssml).toContain('<prosody rate="1.50">');
});
