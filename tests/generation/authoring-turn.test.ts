import { expect, test } from "bun:test";
import type { ScenarioCandidate } from "../../src/contracts/index.js";
import { agentScript } from "../../src/generation/pipeline/agent.js";
import { authoringPrompt, verifyResultPrompt } from "../../src/generation/pipeline/authoring.js";
import { taskSourceEnvironment } from "../../src/generation/pipeline/task-source.js";
import { redReport } from "../support/workflow-fixture.js";

test("the turn after a verify carries the report and the next step", () => {
  const red = redReport("authoring", 1, "t", { oracle: true });
  expect(verifyResultPrompt(red, 2)).toContain("green=false. 2 verify call(s) remain");
  expect(verifyResultPrompt(red, 2)).toContain("verify again");
  expect(verifyResultPrompt(red, 0)).toContain("call submit_task with your best task");
  expect(verifyResultPrompt({ ...red, green: true }, 1)).toContain("Call submit_task now.");
});

const scenario: ScenarioCandidate = {
  kind: "scenario",
  candidateId: "scenario-traded",
  difficulty: "medium",
  title: "Traded to a New Team",
  request: "An email traded me to team 3, but my agent read team 6 from the spreadsheet.",
  provenance: { uri: "file:///p", sha256: "a".repeat(64), sizeBytes: 1, contentType: "x" },
};

test("a scenario's author is briefed on the scenario, not a pull request", () => {
  const brief = authoringPrompt(scenario, 1);
  expect(brief).toContain("# Build One Eval Task from a Scenario");
  expect(brief).toContain("Title: Traded to a New Team");
  expect(brief).toContain(scenario.request);
  expect(brief).toContain("The requester attached no files.");
  expect(brief).toContain("workspace/");
  expect(brief).not.toMatch(/pull request|base commit/i);
  const attached = authoringPrompt({ ...scenario, attachments: scenario.provenance }, 1);
  expect(attached).toContain("/work/attachments");
  const revision = authoringPrompt(scenario, 2, "report", "Use the venue too.");
  expect(revision).toContain("workspace/ included");
  expect(revision).not.toContain("re-cloned");
});

test("a repository scenario's author builds on the repository at its commit", () => {
  const commit = "c".repeat(40);
  const repository = { ...scenario, baseCommit: commit };
  const brief = authoringPrompt(repository, 1);
  expect(brief).toContain("# Build One Eval Task from a Scenario in This Repository");
  expect(brief).toContain(`Base commit: ${commit}`);
  expect(brief).toContain(scenario.request);
  expect(brief).not.toContain("workspace/");
  expect(authoringPrompt(repository, 2, "report")).toContain("re-cloned");
  // Its static check applies the patches to that commit, under a scenario's audit.
  expect(taskSourceEnvironment(repository)).toEqual({
    SELFBENCH_TASK_SOURCE: "repository_scenario",
    SELFBENCH_BASE_COMMIT: commit,
  });
  expect(taskSourceEnvironment(scenario)).toEqual({ SELFBENCH_TASK_SOURCE: "scenario" });
});

test("a scenario's author starts in /work/task with no repository to clone", () => {
  const script = agentScript({
    workspace: { kind: "scenario" },
    extension: "/work/authoring.js",
    tools: "read",
  });
  expect(script).toContain("mkdir -p /work/task\ncd /work/task");
  expect(script).not.toContain("git clone");
});
