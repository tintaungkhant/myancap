import { expect, test } from "bun:test";
import {
  extractYouTubeId,
  probeArgs,
  parseProbe,
  videoArgs,
  audioArgs,
} from "./youtube";

test("extractYouTubeId matches the three accepted forms, rejects others", () => {
  expect(extractYouTubeId("watch https://youtube.com/watch?v=dQw4w9WgXcQ now")).toBe("dQw4w9WgXcQ");
  expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractYouTubeId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractYouTubeId("https://evil.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  expect(extractYouTubeId("just text")).toBeNull();
});

test("parseProbe reads duration + title", () => {
  expect(parseProbe("212\nHow to Cook Rice\n")).toEqual({
    durationSeconds: 212,
    title: "How to Cook Rice",
  });
});

test("parseProbe throws on a bad duration", () => {
  expect(() => parseProbe("notanumber\nTitle")).toThrow(/duration/);
});

test("arg builders include the key flags", () => {
  expect(probeArgs("URL")).toEqual(["--no-download", "--print", "%(duration)s\n%(title)s", "URL"]);
  expect(videoArgs("URL", "/d")).toContain("--merge-output-format");
  expect(videoArgs("URL", "/d")).toContain("/d/video.%(ext)s");
  expect(audioArgs("URL", "/d")).toContain("mp3");
  expect(audioArgs("URL", "/d")).toContain("/d/audio.%(ext)s");
});
