import type { TaskDefinition } from "./contracts.js";

export interface StaticAuditReport {
  readonly accepted: boolean;
  readonly blockers: readonly string[];
  readonly metrics: {
    readonly implementationFiles: number;
    readonly implementationChangedLines: number;
    readonly testFiles: number;
  };
}

export function auditHardTask(
  definition: TaskDefinition,
  goldPatch: string,
  testPatch: string,
): StaticAuditReport {
  const gold = patchMetrics(goldPatch);
  const tests = patchMetrics(testPatch);
  const testPathSet = new Set(tests.files);
  const blockers: string[] = [];
  const overlap = gold.files.filter((path) => testPathSet.has(path));
  if (overlap.length > 0) {
    blockers.push(`gold and held-out test patches overlap: ${overlap.join(", ")}`);
  }
  if (gold.files.length < 3) {
    blockers.push(`hard mode requires at least 3 implementation files; found ${gold.files.length}`);
  }
  if (gold.changedLines < 100) {
    blockers.push(
      `hard mode requires at least 100 changed implementation lines; found ${gold.changedLines}`,
    );
  }
  if (tests.files.length === 0) {
    blockers.push("held-out test patch changes no files");
  }
  if (definition.passToPass.length < 2) {
    blockers.push("hard mode requires at least 2 pass-to-pass regression tests");
  }
  if (
    definition.failToPass.some((path) => testCommandHardcodesPath(definition.testCommand, path)) ||
    definition.passToPass.some((path) => testCommandHardcodesPath(definition.testCommand, path))
  ) {
    blockers.push(
      'test command must not hard-code fail-to-pass or pass-to-pass paths outside "{tests}"',
    );
  }
  return {
    accepted: blockers.length === 0,
    blockers,
    metrics: {
      implementationFiles: gold.files.length,
      implementationChangedLines: gold.changedLines,
      testFiles: tests.files.length,
    },
  };
}

function testCommandHardcodesPath(command: string, path: string): boolean {
  return command.replace("{tests}", "").includes(path);
}

function patchMetrics(patch: string): { files: string[]; changedLines: number } {
  const files: string[] = [];
  let changedLines = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git a/")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (match?.[2]) {
        files.push(match[2]);
      }
      continue;
    }
    if (
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---"))
    ) {
      changedLines += 1;
    }
  }
  return { files, changedLines };
}
