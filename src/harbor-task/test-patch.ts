import type { TaskDefinition } from "../contracts.js";
import { assertSafePatchPaths } from "./paths.js";

/** A missing test delta is intentional only when all tests come from the base tree. */
export function isBaseOnlyTestPatch(definition: TaskDefinition, patch: string): boolean {
  return definition.testSelection?.mode === "base-only" && patch === "";
}

export function assertTestPatch(definition: TaskDefinition, patch: string): void {
  if (isBaseOnlyTestPatch(definition, patch)) return;
  if (definition.testSelection?.mode === "base-only") {
    throw new Error("base-only requires an empty test.patch");
  }
  if (!patch.startsWith("diff --git ")) throw new Error("test.patch is not a Git patch");
  assertSafePatchPaths(patch, "test patch");
}
