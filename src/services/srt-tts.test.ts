import { expect, test } from "bun:test";
import { mapLimit, breakTags, preBreaks, buildBatchSsml } from "./srt-tts";
import type { Cue } from "../lib/srt";

test("mapLimit preserves order", async () => {
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => n * 10);
  expect(out).toEqual([10, 20, 30, 40, 50]);
});

test("mapLimit never exceeds the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  await mapLimit(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(5);
    active--;
  });
  expect(peak).toBeLessThanOrEqual(3);
});

test("breakTags splits long silences into <=5s chunks, omits zero", () => {
  expect(breakTags(0)).toBe("");
  expect(breakTags(3)).toBe('<break time="3000ms"/>');
  expect(breakTags(12)).toBe('<break time="5000ms"/><break time="5000ms"/><break time="2000ms"/>');
});

test("preBreaks: first = start, rest = gap from previous end (clamped)", () => {
  const cues: Cue[] = [
    { index: 1, start: 1, end: 3, text: "a" },
    { index: 2, start: 4, end: 6, text: "b" },   // gap 1s
    { index: 3, start: 5.5, end: 8, text: "c" }, // overlaps prev end -> 0
  ];
  expect(preBreaks(cues)).toEqual([1, 1, 0]);
});

test("buildBatchSsml wraps cues with breaks + escaped text under one voice", () => {
  const cues: Cue[] = [
    { index: 1, start: 1, end: 2, text: "hi <b>" },
    { index: 2, start: 3, end: 4, text: "world" },
  ];
  const ssml = buildBatchSsml(cues, preBreaks(cues), "my-MM-ThihaNeural");
  expect(ssml).toContain('name="my-MM-ThihaNeural"');
  expect(ssml).toContain('<break time="1000ms"/>hi &lt;b&gt;');
  expect(ssml).toContain("world");
  // single voice wrapper
  expect(ssml.match(/<voice/g)?.length).toBe(1);
});
