import { expect, test } from "bun:test";
import { aacArgs } from "./audio";

test("aacArgs encodes input to raw ADTS aac at output path", () => {
  const a = aacArgs("/d/dub.wav", "/d/dub.aac");
  expect(a).toContain("/d/dub.wav");
  expect(a).toContain("/d/dub.aac");
  expect(a.join(" ")).toContain("-c:a aac");
  expect(a.join(" ")).toContain("-f adts");
});
