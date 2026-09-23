import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../../../lib/util.js";
import { failure, type ToolFailure } from "./static-check.js";

export interface TaskDeliverable {
  readonly definition: Record<string, unknown>;
  readonly testPatch: string;
  readonly goldPatch: string;
}

const TASK_DELIVERABLE_FILES = [
  "definition.json",
  "instruction.md",
  "test.patch",
  "gold.patch",
] as const;

/**
 * Authoring deliverable: `<root>/definition.json` (schema 2 with the environment contract),
 * `instruction.md`, `test.patch`, `gold.patch`. instruction.md is authoritative for the prompt:
 * `definition.prompt` is derived from it and must match when present.
 */
export function loadTaskDeliverable(root: string): TaskDeliverable | ToolFailure {
  const missing = TASK_DELIVERABLE_FILES.filter((name) => !existsSync(join(root, name)));
  if (missing.length > 0) {
    return deliverableFailure(
      root,
      missing.map((name) => `${name} is missing`),
    );
  }
  let definition: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(join(root, "definition.json"), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    definition = parsed as Record<string, unknown>;
  } catch (error) {
    return deliverableFailure(root, [`definition.json is not valid JSON: ${errorMessage(error)}`]);
  }
  const instruction = readFileSync(join(root, "instruction.md"), "utf8").trim();
  const testPatch = readFileSync(join(root, "test.patch"), "utf8");
  const goldPatch = readFileSync(join(root, "gold.patch"), "utf8");
  const problems: string[] = [];
  if (!instruction) {
    problems.push("instruction.md is empty");
  }
  if (typeof definition.prompt === "string" && definition.prompt.trim() !== instruction) {
    problems.push(
      "definition.json prompt differs from instruction.md; remove prompt or make them identical",
    );
  }
  if (!testPatch.trim()) {
    problems.push("test.patch is empty");
  }
  if (!goldPatch.trim()) {
    problems.push("gold.patch is empty");
  }
  if (problems.length > 0) {
    return deliverableFailure(root, problems);
  }
  return { definition: { ...definition, prompt: instruction }, testPatch, goldPatch };
}

function deliverableFailure(root: string, problems: readonly string[]): ToolFailure {
  return failure(
    `The deliverable in ${root} is incomplete; nothing was recorded. Fix every item and call the tool again:\n${problems.map((problem) => `- [files] ${problem}`).join("\n")}`,
  );
}
