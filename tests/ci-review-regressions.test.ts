import { expect, test } from "bun:test";
import type { ArtifactStore } from "../src/artifacts/index.js";
import type { TaskRecord, TaskStore } from "../src/db/tasks.js";
import { authoringPrompt, authoringResumePrompt } from "../src/generation/authoring/prompt.js";
import { infrastructureFailureSummary, refreshInProgress } from "../src/generation/tasks/status.js";
import { candidate } from "./support/workflow-fixture.js";

test("review feedback is the reason to revise even when mechanical gates are green", () => {
  const prompt = authoringResumePrompt(2, "Overall GREEN", "Remove private helper coupling");
  expect(prompt).toContain("read-only reviewer requested revisions");
  expect(prompt).toContain("Remove private helper coupling");
  expect(prompt).toContain("not a failed check");
  expect(prompt).toContain("fresh sandbox");
  expect(prompt).not.toContain("previous submission did not pass");
  expect(prompt).not.toContain("address its failures");
  const failed = authoringResumePrompt(2, "RED");
  expect(failed).toContain("did not pass mechanical verification");
  expect(failed).toContain("address its failures");
  expect(failed).toContain("fresh sandbox");
  expect(authoringPrompt(candidate("prompt", 1))).not.toContain("fresh sandbox");
});

test("prompt sections stay explicit and ordered", () => {
  const prompt = authoringPrompt(candidate("prompt", 1));
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
  expect(prompt.match(/^#/gm)?.length).toBeGreaterThanOrEqual(sections.length);
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
  const task = {
    id: 1,
    workflowId: "workflow",
    stage: "review",
    round: 2,
    pipelineStatus: "in_progress",
  } as TaskRecord;
  const tasks = {
    listForRepo: async () => [task],
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
  const { authoringResumePrompt } = await import("../src/generation/authoring/prompt.js");
  expect(authoringResumePrompt(3, "RED mechanical report")).not.toContain(
    "read-only reviewer requested revisions",
  );
});
