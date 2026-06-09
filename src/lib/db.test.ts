import { expect, test } from "bun:test";
import { openDb } from "./db";

test("creates the three tables", () => {
  const db = openDb(":memory:");
  const names = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r: any) => r.name);
  expect(names).toContain("jobs");
  expect(names).toContain("videos");
  expect(names).toContain("processed_updates");
  db.close();
});

test("is idempotent — opening twice does not throw", () => {
  const db = openDb(":memory:");
  expect(() => openDb(":memory:")).not.toThrow();
  db.close();
});
