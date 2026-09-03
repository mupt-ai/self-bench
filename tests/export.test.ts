import { describe, expect, test } from "bun:test";
import { dedupeBySourcePr, exportManifest } from "../src/temporal/activities/export.js";
import { run } from "./support/workflow-fixture.js";

describe("export deduplication by source pull request", () => {
  test("keeps the first accepted task per pull request and records every later one", () => {
    const { kept, dropped } = dedupeBySourcePr([
      { taskId: "uploader-retry", sourcePr: 93203 },
      { taskId: "billing-rounding", sourcePr: 91010 },
      { taskId: "uploader-retry-again", sourcePr: 93203 },
      { taskId: "uploader-retry-third", sourcePr: 93203 },
    ]);

    expect(kept.map((task) => task.taskId)).toEqual(["uploader-retry", "billing-rounding"]);
    expect(dropped).toEqual([
      { taskId: "uploader-retry-again", sourcePr: 93203, keptTaskId: "uploader-retry" },
      { taskId: "uploader-retry-third", sourcePr: 93203, keptTaskId: "uploader-retry" },
    ]);
  });

  test("leaves distinct pull requests untouched", () => {
    const tasks = [
      { taskId: "a", sourcePr: 1 },
      { taskId: "b", sourcePr: 2 },
    ];

    expect(dedupeBySourcePr(tasks)).toEqual({ kept: tasks, dropped: [] });
  });

  test("manifest counts only kept tasks and lists the dropped duplicates", () => {
    const manifest = exportManifest(
      run,
      [{ taskId: "uploader-retry", sha256: "f".repeat(64) }],
      [{ taskId: "uploader-retry-again", sourcePr: 93203, keptTaskId: "uploader-retry" }],
    );

    expect(manifest).toEqual({
      schemaVersion: 1,
      runId: run.runId,
      candidateCounts: run.candidateCounts,
      repository: run.repository,
      version: run.version,
      acceptedCount: 1,
      tasks: [{ taskId: "uploader-retry", sha256: "f".repeat(64) }],
      droppedDuplicates: [
        { taskId: "uploader-retry-again", sourcePr: 93203, keptTaskId: "uploader-retry" },
      ],
    });
  });
});
