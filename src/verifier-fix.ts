import type { TaskDefinition } from "./contracts.js";
import { assertRepairedPatchPaths } from "./repair.js";

/** Definition fields the verification agent may change through submit_fix. */
export const VERIFIER_FIX_FIELDS = [
  "environment",
  "testCommand",
  "failToPass",
  "passToPass",
  "testPaths",
  "timeouts",
  "resources",
] as const;

const IMMUTABLE_FIELDS = [
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

export interface VerifierFixInput {
  readonly original: TaskDefinition;
  readonly fixed: TaskDefinition;
  readonly originalTestPatch: string;
  readonly fixedTestPatch: string;
  readonly originalGoldPatch: string;
  readonly fixedGoldPatch: string;
}

/**
 * A verifier fix may edit only the held-out tests and the environment contract (plus the test
 * selection, timeouts, and resources that describe how those tests run). The gold patch, base
 * commit, instruction, and task identity never change.
 */
export function assertVerifierFix(input: VerifierFixInput): void {
  for (const key of IMMUTABLE_FIELDS) {
    if (JSON.stringify(input.fixed[key]) !== JSON.stringify(input.original[key])) {
      throw new Error(`verifier fix changed immutable definition field ${key}`);
    }
  }
  if (input.fixedGoldPatch !== input.originalGoldPatch) {
    throw new Error("verifier fix changed the gold patch");
  }
  if (!input.fixedTestPatch.startsWith("diff --git ")) {
    throw new Error("verifier fix produced an empty or invalid held-out test patch");
  }
  try {
    assertRepairedPatchPaths(input.originalTestPatch, input.fixedTestPatch);
  } catch (error) {
    throw new Error(
      `verifier fix ${error instanceof Error ? error.message.replace(/^repair /, "") : String(error)}`,
    );
  }
  const definitionChanged = VERIFIER_FIX_FIELDS.some(
    (key) => JSON.stringify(input.fixed[key]) !== JSON.stringify(input.original[key]),
  );
  if (!definitionChanged && input.fixedTestPatch === input.originalTestPatch) {
    throw new Error("verifier fix left the task unchanged");
  }
}

/** Applies only the permitted fields from a submitted fix onto the original definition. */
export function applyVerifierFix(
  original: TaskDefinition,
  fix: Partial<Pick<TaskDefinition, (typeof VERIFIER_FIX_FIELDS)[number]>>,
): TaskDefinition {
  const next: TaskDefinition = { ...original };
  for (const key of VERIFIER_FIX_FIELDS) {
    const value = fix[key];
    if (value !== undefined) {
      Object.assign(next, { [key]: value });
    }
  }
  return next;
}
