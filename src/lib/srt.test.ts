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

test("serializeSrt round-trips a parsed SRT", () => {
  const again = parseSrt(serializeSrt(parseSrt(SAMPLE)));
  expect(again).toEqual(parseSrt(SAMPLE));
});
