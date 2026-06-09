import { expect, test } from "bun:test";
import { aacArgs } from "./audio";

test("aacArgs encodes input to aac at output path", () => {
  const a = aacArgs("/d/dub.wav", "/d/dub.m4a");
  expect(a).toContain("/d/dub.wav");
  expect(a).toContain("/d/dub.m4a");
  expect(a.join(" ")).toContain("-c:a aac");
});
