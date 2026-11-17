import { expect, test } from "bun:test";
import { buildRelease, previewRelease } from "../src/public/release-build.js";
import { approvedTasks, inputs, run } from "./support/release-fixture.js";

const context = {
  repository: { id: 70107786, fullName: "vercel/next.js" },
  publisher: { login: "acme", kind: "org" as const },
};

const started = Date.parse("2026-09-01T00:00:00.000Z");
const timed = (minutes: number) => ({
  startedAt: new Date(started).toISOString(),
  finishedAt: new Date(started + minutes * 60_000).toISOString(),
});

test("a setting's time is its tasks' mean wall-clock minutes; untimed attempts are left out", () => {
  const runs = [
    run({
      model: "timed",
      results: {
        t1: { rewards: { reward: 1 }, ...timed(10) },
        t2: { rewards: { reward: 0 }, ...timed(30) },
        t3: { rewards: { reward: 1 } },
      },
    }),
  ];
  const all = inputs({ runs, tasks: approvedTasks(["t1", "t2", "t3"]) });
  const chosen = previewRelease(all).settings.map((setting) => setting.key);
  const { payload, detail } = buildRelease(all, chosen, context);
  expect(payload.settings[0]?.minutesPerTask).toBe(20);
  // Results are keyed by task key, which names the run, so read them by their values.
  const results = detail.results as Record<string, Record<string, { minutes?: number }>>;
  const attempts = Object.values(results[chosen[0] ?? ""] ?? {});
  expect(attempts.map((attempt) => attempt.minutes)).toEqual([10, 30, undefined]);
});
