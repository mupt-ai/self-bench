import type { TaskDefinition, TaskEnvironment } from "../../contracts.js";
import type { CouplingEvidence } from "../../coupling.js";
import { joinPromptSections } from "../agent/prompt-sections.js";

export interface ReviewPromptInput {
  readonly taskId: string;
  readonly testSelection?: TaskDefinition["testSelection"];
  readonly testResults?: TaskDefinition["testResults"];
  readonly instruction: string;
  readonly renderedReport: string;
  readonly couplingEvidence: CouplingEvidence;
  readonly environment: TaskEnvironment;
  readonly testPatch: string;
  readonly goldPatch: string;
  readonly heldOutPaths: readonly string[];
}

const workspace = `# Workspace

- /work/task/harbor-task is the compiled task. Read its instruction, task.toml, environment, tests, and solution; never edit them.
- /work/repo is the exact base snapshot with the held-out test patch applied. It is read-only.
- The report, coupling evidence, environment contract, and both patches below are evidence for this decision.`;

const rubric = `# Review Rubric

## Instruction Fidelity
Preserve the human request without adding behavior inferred only from implementation or tests. Do not leak PRs, commits, test names, or the solution.

## Public Behavior
Held-out tests must exercise an existing public API, command, persistence boundary, or extension seam. Reject tests coupled to private helpers, exact internal SQL, query counts, private schemas, object identity, telemetry layout, incidental wording, or UI copy unless the request makes that artifact public.

## Coupling and Evidence
For every exact artifact asserted by held-out tests, require evidence from the authentic request or the base repository. Resolve every coupling blocker. Use external_contract only for a genuine named standard; use not_contract only for incidental test syntax.

## Environment
Require deterministic, reproducible setup: pinned images, frozen dependencies, a smoke command independent of the hidden gold patch, no secrets or host interpolation, and only necessary services.

## Mechanical Gates
Accept only a GREEN report. The nop split must fail every fail-to-pass test on base and pass every pass-to-pass test; the oracle must pass both deterministically.`;

const decision = `# Decision

- accept_task: the task is fair and the report is GREEN. Resolve every blocker and provide a plausible alternative implementation counterexample.
- submit_suggestions: the task needs changes, but you may not edit it. Give concise actionable fairness, seam, coupling, environment, or test suggestions.
- reject_task: the task cannot be made fair within the authoring workflow.

You have no bash, edit, write, or verify tools. Use read, grep, find, and ls only. Do not modify task files or the repository. Do not return prose after a tool call.`;

export function reviewPrompt(input: ReviewPromptInput): string {
  const evidence = JSON.stringify(
    {
      testSelection: input.testSelection ?? null,
      testResults: input.testResults ?? "command-level",
      protectedTestPaths: input.heldOutPaths,
    },
    null,
    2,
  );
  return joinPromptSections(
    `You are the independent SelfBench review agent for task ${input.taskId}. You have not seen the authoring conversation. Judge whether this Harbor task is a fair, self-contained benchmark and either accept it or submit suggestions for the next authoring agent.`,
    workspace,
    rubric,
    decision,
    `# Selection and Evidence Contract\n\n${evidence}`,
    `# Authentic Request\n\n${input.instruction.trim()}`,
    `# Mechanical Check Report\n\n${input.renderedReport.trim()}`,
    `# Deterministic Coupling Evidence\n\n${JSON.stringify(input.couplingEvidence, null, 2)}`,
    `# Environment Contract\n\n${JSON.stringify(input.environment, null, 2)}`,
    `# Held-Out Test Patch\n\n\`\`\`diff\n${input.testPatch}\n\`\`\``,
    `# Gold Implementation Patch\n\n\`\`\`diff\n${input.goldPatch}\n\`\`\``,
  );
}
