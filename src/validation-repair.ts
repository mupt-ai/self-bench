import type { TaskDefinition } from "./contracts.js";
import { patchPaths } from "./repair.js";

export function validationRepairPaths(originalTestPatch: string): readonly string[] {
  const paths = patchPaths(originalTestPatch);
  if (paths.length === 0) {
    throw new Error("original held-out test patch changes no files");
  }
  const nonTestPaths = paths.filter((path) => !isTestOnlyPath(path));
  if (nonTestPaths.length > 0) {
    throw new Error(`validation repair requires test-only patch paths: ${nonTestPaths.join(", ")}`);
  }
  return paths;
}

function isTestOnlyPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const filename = segments.at(-1) ?? "";
  return (
    segments.some((segment) =>
      /^(?:tests?|__tests__|e2e|integration|fixtures?|selfbench(?:-tests|_tests)?|\.selfbench-tests)$/.test(
        segment,
      ),
    ) || /(?:^|\.)(?:test|spec)\.[^.]+$/.test(filename)
  );
}

export function assertValidationRepair(
  original: TaskDefinition,
  repaired: TaskDefinition,
  originalTestPatch: string,
  changedPaths: readonly string[],
): void {
  const immutableKeys = [
    "schemaVersion",
    "difficulty",
    "taskId",
    "repo",
    "baseCommit",
    "workdir",
    "sourcePr",
    "sourceUrl",
    "prompt",
  ] as const;
  for (const key of immutableKeys) {
    if (JSON.stringify(repaired[key]) !== JSON.stringify(original[key])) {
      throw new Error(`validation repair changed immutable definition field ${key}`);
    }
  }
  const allowed = new Set(validationRepairPaths(originalTestPatch));
  const outside = changedPaths.filter((path) => !allowed.has(path));
  if (outside.length > 0) {
    throw new Error(
      `validation repair changed files outside held-out tests: ${outside.join(", ")}`,
    );
  }
}

export function validationRepairPrompt(input: {
  readonly definition: TaskDefinition;
  readonly authenticRequest: string;
  readonly diagnostics: string;
  readonly allowedPaths: readonly string[];
}): string {
  return `Repair the verifier harness and held-out tests for SelfBench task ${input.definition.taskId}.

The repository is the exact base snapshot with the current held-out test patch already applied. You may edit only these existing held-out test files:

${input.allowedPaths.map((path) => `- ${path}`).join("\n")}

The authentic engineer request is:

<authentic_request>
${input.authenticRequest.trim()}
</authentic_request>

The failed nop/oracle validation diagnostics are:

<validation_diagnostics>
${input.diagnostics.trim()}
</validation_diagnostics>

Fix the task so its repository-native verifier is rigorous and runnable. You may edit the allowed held-out tests and /work/definition.json. In definition.json you may change only setupCommand, testCommand, failToPass, passToPass, testPaths, toolchains, timeouts, and resources. Never change task identity, difficulty, repository, base commit, workdir, source pull request, prompt, or reference solution.

The required validation split is:
- nop: the base repository plus held-out tests must make failToPass fail while passToPass succeeds;
- oracle: after /work/task/solution/gold.patch is applied, failToPass and passToPass must both succeed deterministically.

Use the verifier diagnostics rather than guessing. Inspect repository package scripts and CI for the native test command. Keep {tests} as a list-safe placeholder; do not quote the whole placeholder, assign it to one scalar, or hard-code selected paths elsewhere. Use one test mode/bundler per command instead of chaining equivalent suites. Put dependency installation, native builds, fixture generation, and browser/runtime installation in setupCommand, not testCommand. Pin the repository's declared package manager and use frozen installs. Browser-backed tests must install required browser binaries and OS dependencies during setup. Run focused nop/oracle-style commands in the sandbox when feasible.

Do not weaken, delete, or skip requested behavioral coverage merely to make commands exit zero. A passing base with no solution is not acceptable. If no rigorous runnable split exists, leave the files and definition unchanged and explain why in the final response.

Inspect /work/gold.patch and /work/test.sh only to verify the intended behavior and oracle seam, never to couple assertions to private implementation details. Do not modify application code, the instruction, gold patch, or commit files. Finish with the repaired definition at /work/definition.json and any held-out test edits present in the working tree; do not commit.`;
}
