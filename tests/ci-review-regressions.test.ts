import { expect, test } from "bun:test";
import type { ArtifactStore } from "../src/artifacts.js";
import { infrastructureFailureSummary, refreshInProgress } from "../src/site/task-status.js";
import type { TaskRecord, TaskStore } from "../src/site/task-store.js";
import { authoringResumePrompt } from "../src/temporal/activities/prompts-authoring.js";

test("review feedback is the reason to revise even when mechanical gates are green", () => {
  const prompt = authoringResumePrompt(2, "Overall GREEN", "Remove private helper coupling");
  expect(prompt).toContain("read-only reviewer requested revisions");
  expect(prompt).toContain("Remove private helper coupling");
  expect(prompt).not.toContain("previous submission did not pass");
  expect(authoringResumePrompt(2, "RED")).toContain("did not pass mechanical verification");
});

test("unrelated ENOENT does not claim the checkout is unavailable", () => {
  expect(infrastructureFailureSummary("ENOENT: missing /work/tests/result.json")).not.toContain(
    "checkout",
  );
  expect(
    infrastructureFailureSummary("could not find package.json above /deleted/dist/runtime.js"),
  ).toContain("unavailable checkout");
});

test("workflow failure preserves complete technical details", async () => {
  const detail = "ENOENT: missing /work/tests/result.json\nUnderlying diagnostic";
  let saved: unknown;
  const task = { id: 1, workflowId: "workflow", stage: "verification", round: 2 } as TaskRecord;
  const tasks = {
    inProgress: async () => [task],
    progress: async (_id: number, patch: unknown) => {
      saved = patch;
      return task;
    },
  } as unknown as TaskStore;
  await refreshInProgress({
    tasks,
    artifacts: {} as ArtifactStore,
    repo: { id: 1, fullName: "a/b" },
    status: { snapshot: async () => ({ kind: "failed", status: "FAILED", detail }) },
  });
  expect(saved).toMatchObject({
    pipelineStatus: "infrastructure_failed",
    reason: expect.stringContaining(detail),
  });
});

test("authoring feedback is cleared when the revised mechanical report is red", async () => {
  const { authoringResumePrompt } = await import("../src/temporal/activities/prompts-authoring.js");
  expect(authoringResumePrompt(3, "RED mechanical report")).not.toContain(
    "read-only reviewer requested revisions",
  );
});
