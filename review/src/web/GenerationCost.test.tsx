import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskItem } from "./api";
import { costLabel, GenerationCost } from "./GenerationCost";
import { TaskGenerationControls } from "./task/TaskGenerationControls";

const task = (state: TaskItem["state"]): TaskItem => ({
  runId: "run-one",
  taskId: "task-one",
  candidateId: "candidate-one",
  difficulty: "medium",
  state,
  pipelineStatus: state === "in_progress" ? "in_progress" : "infrastructure_failed",
  stage: state === "cancelled" ? "cancelled" : "authoring",
  syncedAt: "2026-01-01T00:00:00Z",
});

test("cost labels expose unknown, unpriced, partial, and fully priced states", () => {
  expect(costLabel(undefined)).toBe("Unknown");
  expect(
    costLabel({ state: "unpriced", sandboxSeconds: 3, updatedAt: "2026-01-01T00:00:00Z" }),
  ).toBe("Unpriced by Provider");
  expect(
    costLabel({
      state: "partial",
      sandboxSeconds: 3,
      sandboxUsd: 0.01,
      modelUsd: 0.02,
      updatedAt: "2026-01-01T00:00:00Z",
    }),
  ).toBe("$0.03+ (Partial)");
  expect(
    costLabel({
      state: "estimated",
      usd: 0.005,
      sandboxSeconds: 3,
      updatedAt: "2026-01-01T00:00:00Z",
    }),
  ).toBe("$0.0050");
  expect(renderToStaticMarkup(<GenerationCost cost={undefined} />)).toContain("Current Cost:");
});

test("active tasks always expose cancellation and cancelled tasks confirm it", () => {
  const active = renderToStaticMarkup(
    <TaskGenerationControls
      task={task("in_progress")}
      org="Mupt-AI"
      fullName="Mupt-AI/self-bench"
      onRequested={() => {}}
    />,
  );
  expect(active).toContain("Current Cost:");
  expect(active).toContain(">Unknown</span>");
  expect(active).toContain("Cancel Generation");
  expect(active).not.toContain('disabled=""');

  const cancelled = renderToStaticMarkup(
    <TaskGenerationControls
      task={task("cancelled")}
      org="Mupt-AI"
      fullName="Mupt-AI/self-bench"
      onRequested={() => {}}
    />,
  );
  expect(cancelled).toContain("Cancellation Confirmed");
  expect(cancelled).toContain('disabled=""');
});
