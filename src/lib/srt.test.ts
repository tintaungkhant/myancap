import { expect, test } from "bun:test";
import { parseSrt, serializeSrt, parseTimestamp, formatTimestamp } from "./srt";

const SAMPLE =
  "1\n00:00:01,000 --> 00:00:03,500\nHello world\n\n" +
  "2\n00:00:04,000 --> 00:00:06,000\nSecond line\n";

test("parseTimestamp reads HH:MM:SS,mmm into seconds", () => {
  expect(parseTimestamp("00:00:01,000")).toBe(1);
  expect(parseTimestamp("01:02:03,500")).toBeCloseTo(3723.5, 3);
});

test("formatTimestamp is the inverse of parseTimestamp", () => {
  expect(formatTimestamp(1)).toBe("00:00:01,000");
  expect(formatTimestamp(3723.5)).toBe("01:02:03,500");
});

test("parseSrt extracts ordered cues", () => {
  const cues = parseSrt(SAMPLE);
  expect(cues.length).toBe(2);
  expect(cues[0]).toEqual({ index: 1, start: 1, end: 3.5, text: "Hello world" });
  expect(cues[1].text).toBe("Second line");
});

test("parseSrt splits cues even without blank-line separators", () => {
  // LLM output: single newlines, no blank line between cues. Must NOT collapse
  // into one giant cue (which made TTS read the digits/timestamps aloud).
  const dense =
    "1\n00:00:00,000 --> 00:00:03,500\nFirst line\n" +
    "2\n00:00:03,500 --> 00:00:06,000\nSecond line\n" +
    "3\n00:00:06,000 --> 00:00:08,000\nThird line";
  const cues = parseSrt(dense);
  expect(cues.length).toBe(3);
  expect(cues[0].text).toBe("First line");
  expect(cues[1]).toEqual({ index: 2, start: 3.5, end: 6, text: "Second line" });
  expect(cues[2].text).toBe("Third line");
});

test("serializeSrt round-trips a parsed SRT", () => {
  const again = parseSrt(serializeSrt(parseSrt(SAMPLE)));
  expect(again).toEqual(parseSrt(SAMPLE));
});
