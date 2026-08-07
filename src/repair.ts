export function patchPaths(patch: string): readonly string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match?.[2]) {
      paths.add(match[2]);
    }
  }
  return [...paths].sort();
}

export function assertRepairPaths(
  originalTestPatch: string,
  changedPaths: readonly string[],
): void {
  const allowed = new Set(patchPaths(originalTestPatch));
  if (allowed.size === 0) {
    throw new Error("original held-out test patch changes no files");
  }
  const outside = changedPaths.filter((path) => !allowed.has(path));
  if (outside.length > 0) {
    throw new Error(`repair changed files outside the held-out tests: ${outside.join(", ")}`);
  }
}

export function repairPrompt(input: {
  readonly taskId: string;
  readonly authenticRequest: string;
  readonly couplingReport: string;
  readonly allowedPaths: readonly string[];
}): string {
  return `Repair the held-out tests for SelfBench task ${input.taskId}.

The repository is the exact base snapshot with the current held-out test patch already applied. You may edit only these existing test files:

${input.allowedPaths.map((path) => `- ${path}`).join("\n")}

The authentic engineer request is:

<authentic_request>
${input.authenticRequest.trim()}
</authentic_request>

The independent coupling report is:

<coupling_report>
${input.couplingReport.trim()}
</coupling_report>

Rewrite the tests so they verify every material requested behavior through stable public boundaries without requiring the gold patch's exact internal names, helper structure, error prose, mock input shape, response presentation, or incidental implementation choices. Preserve meaningful negative, authorization, compatibility, and regression coverage. Do not edit application code, the request, or the gold patch. Do not delete assertions merely to silence the report. A coherent alternative implementation must be able to pass, while the unchanged base must still fail the fail-to-pass tests and the gold implementation must still pass.

The final working tree must retain a non-empty test patch relative to HEAD and every originally added fail-to-pass test must still have an equivalent behavioral test. Do not reset, revert, delete, or commit the test patch. If an exact public response field is the only stable seam, prefer asserting the underlying externally visible behavior through existing endpoints, persistence, or follow-up actions. If no rigorous uncoupled test is possible within the allowed files, leave the current tests in place and explain the blocker in your final message instead of removing coverage.

Inspect /work/task/solution/gold.patch only to understand the intended behavior and available seams, never to copy its private structure into assertions. Inspect /work/task/tests/test.sh for the verifier command. Run focused tests when feasible. Finish only after the working tree contains the repaired test files and no other changes.`;
}
