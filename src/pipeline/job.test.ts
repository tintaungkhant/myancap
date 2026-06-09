import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { newJobId, createJobDir, cleanupJobDir } from "./job";

process.env.WORK_DIR = "/tmp/myancap-test";
process.env.TELEGRAM_BOT_TOKEN = "t";
process.env.OPENAI_API_KEY = "o";
process.env.GEMINI_API_KEY = "g";
process.env.AZURE_SPEECH_KEY = "a";

test("newJobId returns a short non-empty id", () => {
  const id = newJobId();
  expect(id.length).toBeGreaterThan(0);
  expect(newJobId()).not.toBe(id);
});

test("createJobDir makes a dir; cleanupJobDir removes it", async () => {
  const dir = await createJobDir("jobtest1");
  expect(existsSync(dir)).toBe(true);
  await cleanupJobDir(dir);
  expect(existsSync(dir)).toBe(false);
});

afterAll(async () => { await cleanupJobDir("/tmp/myancap-test"); });
