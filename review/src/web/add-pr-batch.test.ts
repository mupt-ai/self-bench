import { expect, test } from "bun:test";
import { addPrBatch } from "./add-pr-batch";

test("PR batches submit each selection once, serially, and retain individual failures for retry", async () => {
  const calls: number[] = [];
  let active = 0;
  const result = await addPrBatch([57, 56, 55, 57], async (number) => {
    expect(++active).toBe(1);
    calls.push(number);
    await Promise.resolve();
    active--;
    if (number === 56) throw new Error("PR not eligible");
    return `task-${number}`;
  });
  expect(calls).toEqual([57, 56, 55]);
  expect(result.started).toEqual([
    { number: 57, task: "task-57" },
    { number: 55, task: "task-55" },
  ]);
  expect(result.failed).toEqual([{ number: 56, message: "PR not eligible" }]);
  const retry = await addPrBatch(
    result.failed.map((item) => item.number),
    async (number) => {
      calls.push(number);
      return `task-${number}`;
    },
  );
  expect(calls).toEqual([57, 56, 55, 56]);
  expect(retry.failed).toEqual([]);
  expect(
    await addPrBatch([], async () => {
      throw new Error("Must not submit");
    }),
  ).toEqual({ started: [], failed: [] });
});
