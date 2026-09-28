import { expect, test } from "bun:test";
import type { Context } from "@temporalio/activity";
import { idleTracker } from "../src/temporal/idle-exit.js";

test("a worker is idle only while no activity runs, counted from the last one to finish", async () => {
  let clock = 1_000;
  const tracker = idleTracker(() => clock);
  const execute = tracker.interceptor({} as Context).inbound?.execute;
  if (!execute) throw new Error("no inbound interceptor");
  clock = 5_000;
  expect(tracker.idleForMs()).toBe(4_000);

  let finish = () => {};
  const running = execute(
    { args: [], headers: {} },
    () =>
      new Promise((resolve) => {
        finish = () => resolve(undefined);
      }),
  );
  clock = 60_000;
  expect(tracker.idleForMs()).toBe(0);

  finish();
  await running;
  clock = 90_000;
  expect(tracker.idleForMs()).toBe(30_000);
});
