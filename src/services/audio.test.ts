import { expect, test } from "bun:test";
import { mp3Args, extractAudioArgs, ffprobeArgs } from "./audio";

test("mp3Args encodes input to mp3 at output path", () => {
  const a = mp3Args("/d/dub.wav", "/d/dub.mp3");
  expect(a).toContain("/d/dub.wav");
  expect(a).toContain("/d/dub.mp3");
  expect(a.join(" ")).toContain("-c:a libmp3lame");
});

test("extractAudioArgs strips video to a mono mp3", () => {
  const a = extractAudioArgs("/d/video.mp4", "/d/audio.mp3");
  expect(a).toContain("/d/video.mp4");
  expect(a).toContain("/d/audio.mp3");
  expect(a).toContain("-vn"); // drop the video track
  expect(a.join(" ")).toContain("-ac 1"); // downmix to mono
  expect(a.join(" ")).toContain("-c:a libmp3lame");
});

test("ffprobeArgs asks ffprobe for the format duration only", () => {
  const a = ffprobeArgs("/d/video.mp4");
  expect(a).toContain("/d/video.mp4");
  expect(a.join(" ")).toContain("format=duration");
  expect(a.join(" ")).toContain("-v error");
});
