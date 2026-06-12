import { expect, test } from "bun:test";
import {
  extractYouTubeId,
  extraArgs,
  probeArgs,
  parseProbe,
  videoArgs,
} from "./youtube";

test("extraArgs adds cookies + player client only when set", () => {
  expect(extraArgs(undefined, undefined)).toEqual([]);
  expect(extraArgs("/c.txt", undefined)).toEqual(["--cookies", "/c.txt"]);
  expect(extraArgs(undefined, "tv")).toEqual([
    "--extractor-args",
    "youtube:player_client=tv",
  ]);
});

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
  expect(videoArgs("URL", "/d", 480)).toContain("--merge-output-format");
  expect(videoArgs("URL", "/d", 480)).toContain("/d/video.%(ext)s");
  expect(videoArgs("URL", "/d", 480).join(" ")).toContain("height<=480");
});
