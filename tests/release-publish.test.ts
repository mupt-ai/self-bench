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

test("publishing the trials marks the release, but only alongside its tasks", () => {
  const runs = baseRuns();
  const withBundles = inputs({
    runs,
    tasks: approvedTasks(tPrev).map((task) => ({
      ...task,
      bundleKey: `tasks/${task.taskId}.tar.gz`,
    })),
  });
  const chosen = previewRelease(withBundles).settings.map((setting) => setting.key);
  const tasksOnly = buildRelease(withBundles, chosen, { ...context, publishTasks: true });
  const trials = buildRelease(withBundles, chosen, {
    ...context,
    publishTasks: true,
    publishTrials: true,
  });
  expect(tasksOnly.payload.trialsPublished).toBeUndefined();
  expect(trials.payload.trialsPublished).toBe(true);
  expect(trials.hash).not.toBe(tasksOnly.hash);
  // The results name the tasks, so trials alone publish nothing more.
  const alone = buildRelease(withBundles, chosen, { ...context, publishTrials: true });
  expect(alone.payload.trialsPublished).toBeUndefined();
});

test("publishing model summaries keeps the report's sections on the chosen settings", () => {
  const all = inputs({ runs: baseRuns() });
  const [first, second, ...rest] = previewRelease(all).settings;
  if (!first || !second) throw new Error("Missing settings");
  const report = {
    overview: "They all stop early.",
    summaries: [
      { configuration: first.key, text: "It finishes.", tasks: 40, passed: 30 },
      { configuration: second.key, text: "It stops early.", tasks: 40, passed: 20 },
    ],
    model: "gpt-6-luna",
    summarizedAt: "2026-10-20T12:00:00.000Z",
  };
  const everything = [first.key, second.key, ...rest.map((setting) => setting.key)];
  const published = buildRelease(all, everything, { ...context, summaries: report });
  expect(published.payload.modelSummaries).toEqual({
    overview: "They all stop early.",
    settings: { [first.id]: "It finishes.", [second.id]: "It stops early." },
    model: "gpt-6-luna",
    summarizedAt: "2026-10-20T12:00:00.000Z",
  });
  expect(published.hash).not.toBe(buildRelease(all, everything, context).hash);
  // The overview names every setting it compared, so it is left out with one of them.
  const without = buildRelease(all, [first.key, ...rest.map((setting) => setting.key)], {
    ...context,
    summaries: report,
  });
  expect(without.payload.modelSummaries).toEqual({
    settings: { [first.id]: "It finishes." },
    model: "gpt-6-luna",
    summarizedAt: "2026-10-20T12:00:00.000Z",
  });
  // Nor when the reply compared a setting it wrote no section on, which the overview may name.
  const partial = buildRelease(all, [first.key], {
    ...context,
    summaries: {
      ...report,
      summaries: report.summaries.slice(0, 1),
      compared: [first.key, second.key],
    },
  });
  expect(partial.payload.modelSummaries?.overview).toBeUndefined();
  // A report on none of the chosen settings is refused rather than published empty.
  if (rest.length)
    expect(() =>
      buildRelease(
        all,
        rest.map((setting) => setting.key),
        { ...context, summaries: report },
      ),
    ).toThrow(ReleaseRefused);
});
