import { expect, test } from "bun:test";
import { mapLimit } from "./srt-tts";

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






