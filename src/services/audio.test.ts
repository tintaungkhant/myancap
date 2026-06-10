import { expect, test } from "bun:test";
import { mp3Args } from "./audio";

test("mp3Args encodes input to mp3 at output path", () => {
  const a = mp3Args("/d/dub.wav", "/d/dub.mp3");
  expect(a).toContain("/d/dub.wav");
  expect(a).toContain("/d/dub.mp3");
  expect(a.join(" ")).toContain("-c:a libmp3lame");
});
