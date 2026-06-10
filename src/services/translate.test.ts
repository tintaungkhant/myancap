import { expect, test } from "bun:test";
import {
  buildPrompt,
  sanitizeTimings,
  stripFences,
} from "./translate";
import type { Cue } from "../lib/srt";

test("buildPrompt states the core rules", () => {
  const p = buildPrompt("SRTHERE");
  expect(p).toContain("Myanmar");
  expect(p).toContain("Return ONLY the raw SRT");
  expect(p).toContain("SRTHERE");
});

test("sanitizeTimings fixes overlaps and non-positive durations", () => {
  const cues: Cue[] = [
    { index: 1, start: 0, end: 2, text: "a" },
    { index: 2, start: 1, end: 1, text: "b" }, // starts before prev end, zero-length
  ];
  const fixed = sanitizeTimings(cues);
  expect(fixed[1].start).toBeGreaterThanOrEqual(fixed[0].end);
  expect(fixed[1].end).toBeGreaterThan(fixed[1].start);
});

test("stripFences removes markdown code fences", () => {
  expect(stripFences("```srt\n1\n00:00:01,000 --> 00:00:02,000\nHi\n```")).toContain("--> 00:00:02,000");
});
