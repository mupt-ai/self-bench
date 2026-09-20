import { expect, test } from "bun:test";
import {
  activeHarborProcesses,
  HARBOR_PROCESS_LIMIT,
  withHarborProcess,
} from "../src/harbor-processes.js";

test("Harbor processes above the limit wait for a running one to finish", async () => {
  const releases: (() => void)[] = [];
  let peak = 0;
  const runs = Array.from({ length: HARBOR_PROCESS_LIMIT + 4 }, () =>
    withHarborProcess(undefined, async () => {
      peak = Math.max(peak, activeHarborProcesses());
      await new Promise<void>((resolve) => releases.push(resolve));
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(activeHarborProcesses()).toBe(HARBOR_PROCESS_LIMIT);
  expect(releases).toHaveLength(HARBOR_PROCESS_LIMIT);
  for (const release of releases.splice(0, 2)) release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Finished processes hand their slot to waiters; two more actions started.
  expect(releases).toHaveLength(HARBOR_PROCESS_LIMIT);
  expect(activeHarborProcesses()).toBe(HARBOR_PROCESS_LIMIT);
  while (releases.length > 0) {
    for (const release of releases.splice(0)) release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await Promise.all(runs);
  expect(peak).toBe(HARBOR_PROCESS_LIMIT);
  expect(activeHarborProcesses()).toBe(0);
});

test("a cancelled waiter leaves the queue without taking a slot", async () => {
  const releases: (() => void)[] = [];
  const running = Array.from({ length: HARBOR_PROCESS_LIMIT }, () =>
    withHarborProcess(undefined, () => new Promise<void>((resolve) => releases.push(resolve))),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const controller = new AbortController();
  const waiter = withHarborProcess(controller.signal, async () => "ran");
  controller.abort(new Error("cancelled"));
  await expect(waiter).rejects.toThrow("cancelled");
  for (const release of releases) release();
  await Promise.all(running);
  expect(activeHarborProcesses()).toBe(0);
  await expect(withHarborProcess(undefined, async () => "next")).resolves.toBe("next");
});
