import { expect, test } from "bun:test";
import type { ArtifactStore } from "../src/artifacts/index.js";
import type { TaskStore } from "../src/db/tasks.js";
import { authoringPrompt } from "../src/generation/pipeline/authoring.js";
import {
  createTaskActivities,
  infrastructureFailureSummary,
} from "../src/generation/tasks/activities.js";
import { candidate } from "./support/workflow-fixture.js";

test("review feedback is the reason to revise even when mechanical gates are green", () => {
  const prompt = authoringPrompt(
    candidate("prompt", 1),
    2,
    "Overall GREEN",
    "Remove private helper coupling",
  );
  expect(prompt).toContain("reviewer requested revisions");
  expect(prompt).toContain("Remove private helper coupling");
  expect(prompt).toContain("not a failed check");
  expect(prompt).toContain("fresh sandbox");
  expect(prompt).not.toContain("previous submission did not pass");
  const failed = authoringPrompt(candidate("prompt", 1), 2, "RED");
  expect(failed).toContain("did not pass verification");
  expect(failed).toContain("address its failures");
  expect(failed).toContain("fresh sandbox");
  expect(failed).not.toContain("reviewer requested revisions");
  expect(authoringPrompt(candidate("prompt", 1), 1)).not.toContain("fresh sandbox");
});

test("prompt sections stay explicit and ordered", () => {
  const prompt = authoringPrompt(candidate("prompt", 1), 1);
  const sections = [
    "# Build One Eval Task",
    "# What to Produce",
    "# Isolate the Tests",
    "# Keep the Instruction Fair",
    "# Environment",
    "# Difficulty",
    "# How to Work",
  ];
  const headings = prompt.split("\n").filter((line) => line.startsWith("# "));
  let previous = -1;
  for (const section of sections) {
    const index = headings.indexOf(section);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
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
  const tasks = {
    settle: async (_runId: string, _candidateId: string, verdict: unknown) => {
      saved = verdict;
      return true;
    },
  } as unknown as TaskStore;
  await createTaskActivities({ tasks, artifacts: {} as ArtifactStore }).settleTask({
    runId: "run",
    candidateId: "candidate",
    result: {
      progress: {
        candidateId: "candidate",
        taskId: "candidate",
        difficulty: "easy",
        status: "infrastructure_failed",
        stage: "review",
        round: 2,
        reason: detail,
      },
    },
  });
  expect(saved).toMatchObject({
    pipelineStatus: "infrastructure_failed",
    stage: "review",
    reason: expect.stringContaining(detail),
  });
});
