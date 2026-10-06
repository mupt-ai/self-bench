import { expect, test } from "bun:test";
import { buildRelease, previewRelease } from "../src/public/release-build.js";
import { approvedTasks, inputs, names, run } from "./support/release-fixture.js";

/** Runs with fixed ids and times, so the release they make hashes the same every time. */
const fixed = (id: number, model: string, results: Record<string, number>) => ({
  ...run({ model, createdAt: "2026-09-01T00:00:00Z", results }),
  id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
});

test("a repository release hashes exactly as it always has", () => {
  const tasks = names(1, 3);
  const all = inputs({
    tasks: approvedTasks(tasks).map((task) => ({ ...task, bundleKey: `tasks/${task.taskId}` })),
    runs: [fixed(1, "alpha", { t1: 1, t2: 0, t3: 1 }), fixed(2, "beta", { t1: 0, t2: 0, t3: 1 })],
  });
  const chosen = previewRelease(all).settings.map((setting) => setting.key);
  const built = buildRelease(all, chosen, {
    repository: { id: 70107786, fullName: "vercel/next.js" },
    publisher: { login: "acme", kind: "org" },
    publishTasks: true,
  });
  // A changed hash would make every unchanged repository write a new release after a deploy.
  expect(built.hash).toBe("23ad5ece2604deab8fc60d612a25bf46f6ebdd3bb6288ef6239668addf442aaa");
});
