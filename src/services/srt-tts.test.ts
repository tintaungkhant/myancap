import { expect, test } from "bun:test";
import { mapLimit, groupCues } from "./srt-tts";
import type { Cue } from "../lib/srt";

const cue = (start: number, end: number): Cue => ({ index: 1, start, end, text: "x" });

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

test("groupCues packs cues up to the second budget", () => {
  // four 5s cues, budget 12s → [5+5], [5+5]
  const cues = [cue(0, 5), cue(5, 10), cue(10, 15), cue(15, 20)];
  const groups = groupCues(cues, 12);
  expect(groups.map((g) => g.length)).toEqual([2, 2]);
});

test("groupCues gives an oversized cue its own group", () => {
  // 30s cue exceeds a 12s budget → alone; the two 5s cues pack together
  const cues = [cue(0, 30), cue(30, 35), cue(35, 40)];
  const groups = groupCues(cues, 12);
  expect(groups.map((g) => g.length)).toEqual([1, 2]);
});

test("groupCues keeps every cue exactly once, in order", () => {
  const cues = [cue(0, 4), cue(4, 9), cue(9, 11), cue(11, 20)];
  const flat = groupCues(cues, 7).flat();
  expect(flat).toEqual(cues);
});






