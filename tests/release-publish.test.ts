import { expect, test } from "bun:test";
import { buildRelease, previewRelease, ReleaseRefused } from "../src/public/release-build.js";
import { approvedTasks, full, inputs, names } from "./support/release-fixture.js";

const context = {
  repository: { id: 70107786, fullName: "vercel/next.js" },
  publisher: { login: "acme", kind: "org" as const },
};
const tPrev = names(1, 40);
const baseRuns = () => names(1, 10).map((index) => full(`s${index.slice(1)}`, tPrev));

test("publishing the tasks marks the release and needs each task's compiled files", () => {
  const runs = baseRuns();
  const all = inputs({ runs });
  const chosen = previewRelease(all).settings.map((setting) => setting.key);
  const withBundles = inputs({
    runs,
    tasks: approvedTasks(tPrev).map((task) => ({
      ...task,
      bundleKey: `tasks/${task.taskId}.tar.gz`,
    })),
  });
  const quiet = buildRelease(withBundles, chosen, context);
  const published = buildRelease(withBundles, chosen, { ...context, publishTasks: true });
  expect(quiet.payload.tasksPublished).toBeUndefined();
  expect(published.payload.tasksPublished).toBe(true);
  // A different public page, so a release of its own even with the same results.
  expect(published.hash).not.toBe(quiet.hash);
  // A task with no compiled files cannot be published.
  expect(() => buildRelease(all, chosen, { ...context, publishTasks: true })).toThrow(
    ReleaseRefused,
  );
});
