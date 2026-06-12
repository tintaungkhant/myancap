import { expect, test } from "bun:test";
import { Semaphore } from "./semaphore";

test("max=1 serializes: second task starts only after first releases", async () => {
  const sem = new Semaphore(1);
  const order: string[] = [];
  const slow = sem.run(async () => {
    order.push("a-start");
    await Bun.sleep(20);
    order.push("a-end");
  });
  const fast = sem.run(async () => {
    order.push("b-start");
  });
  await Promise.all([slow, fast]);
  expect(order).toEqual(["a-start", "a-end", "b-start"]);
});

test("run returns the task result and propagates errors", async () => {
  const sem = new Semaphore(2);
  expect(await sem.run(async () => 42)).toBe(42);
  await expect(sem.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
});
