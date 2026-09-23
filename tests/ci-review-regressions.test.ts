import { expect, test } from "bun:test";
import type { ArtifactStore } from "../src/artifacts/index.js";
import type { TaskRecord, TaskStore } from "../src/db/tasks.js";
import { authoringPrompt } from "../src/generation/pipeline/authoring.js";
import { infrastructureFailureSummary, refreshInProgress } from "../src/generation/tasks/status.js";
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
  expect(authoringPrompt(candidate("prompt", 1), 1)).toContain("(round 1 of 3)");
  expect(
    authoringPrompt(candidate("prompt", 1), 1, undefined, undefined, { authoringRounds: 5 }),
  ).toContain("(round 1 of 5)");
  expect(authoringPrompt(candidate("prompt", 1), 1)).toContain("real image build");
  expect(
    authoringPrompt(candidate("prompt", 1), 1, undefined, undefined, { verification: "static" }),
  ).toContain("builds and runs nothing");
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
