import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { taskImageQueue } from "../../src/generation/tasks/task-images-workflow.js";

test("image exports run on the queue the Harbor workers scale on", async () => {
  // The chart's Harbor queue is `<name>-harbor`; its export trigger watches that plus `-images`.
  const chart = await readFile(
    new URL(
      "../../infra/terraform/modules/selfbench-environment/charts/selfbench-workers/templates/harbor.yaml",
      import.meta.url,
    ),
    "utf8",
  );
  expect(chart).toContain('printf "%s-images" .Values.temporal.queue');
  expect(taskImageQueue("selfbench-prod")).toBe("selfbench-prod-harbor-images");
});
