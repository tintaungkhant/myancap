import { expect, test } from "bun:test";
import { slugify } from "./slug";

test("lowercases and snake-cases a title", () => {
  expect(slugify("How to Cook Rice", "x")).toBe("how_to_cook_rice");
});

test("collapses punctuation runs and trims underscores", () => {
  expect(slugify("How to Cook Rice (2024) — Easy!", "x")).toBe(
    "how_to_cook_rice_2024_easy",
  );
});

test("falls back when the title slugifies to empty", () => {
  expect(slugify("???", "dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(slugify("", "dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

test("caps length at 80 chars without a trailing underscore", () => {
  const s = slugify("a ".repeat(100), "x");
  expect(s.length).toBeLessThanOrEqual(80);
  expect(s.endsWith("_")).toBe(false);
});
