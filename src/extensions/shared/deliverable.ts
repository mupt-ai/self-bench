import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FIX_FIELDS } from "./schemas.js";
import { failure, type ToolFailure } from "./static-check.js";

export interface TaskDeliverable {
  readonly definition: Record<string, unknown>;
  readonly testPatch: string;
  readonly goldPatch: string;
}

export const TASK_DELIVERABLE_FILES = [
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
    return deliverableFailure(root, [
      `definition.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
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

export interface FixDeliverable {
  readonly definition: Record<string, unknown>;
  readonly testPatch: string;
  readonly goldPatch: string;
  readonly testPatchSource: "file" | "working-tree";
  readonly original: { definition: string; testPatch: string; goldPatch: string };
}

/**
 * Verifier deliverable: `<fixRoot>/definition.json` (optional; only environment, testCommand,
 * failToPass, passToPass, testPaths, timeouts, resources are read and merged onto the compiled
 * task's definition) and `<fixRoot>/test.patch` (optional; regenerated with `git diff` from the
 * repository working tree when absent).
 */
export function loadFixDeliverable(
  fixRoot: string,
  taskDirectory: string,
  repository: string,
): FixDeliverable | ToolFailure {
  const originalDefinition = join(taskDirectory, "definition.json");
  const definition = JSON.parse(readFileSync(originalDefinition, "utf8")) as Record<
    string,
    unknown
  >;
  const fixDefinitionPath = join(fixRoot, "definition.json");
  if (existsSync(fixDefinitionPath)) {
    let fix: Record<string, unknown>;
    try {
      fix = JSON.parse(readFileSync(fixDefinitionPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      return deliverableFailure(fixRoot, [
        `definition.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    for (const field of FIX_FIELDS) {
      if (fix[field] !== undefined) {
        definition[field] = fix[field];
      }
    }
  }
  const testPatchPath = join(fixRoot, "test.patch");
  const fromFile = existsSync(testPatchPath);
  const testPatch = fromFile ? readFileSync(testPatchPath, "utf8") : workingTreePatch(repository);
  if (!testPatch.trim()) {
    return deliverableFailure(fixRoot, [
      fromFile ? "test.patch is empty" : "test.patch is absent and /work/repo has no changes",
    ]);
  }
  return {
    definition,
    testPatch,
    goldPatch: readFileSync(join(taskDirectory, "solution/gold.patch"), "utf8"),
    testPatchSource: fromFile ? "file" : "working-tree",
    original: {
      definition: originalDefinition,
      testPatch: join(taskDirectory, "tests/test.patch"),
      goldPatch: join(taskDirectory, "solution/gold.patch"),
    },
  };
}

export function workingTreePatch(repository: string): string {
  for (const args of [
    ["add", "-N", "--all"],
    ["diff", "--binary", "HEAD"],
  ]) {
    const result = spawnSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr.slice(-2_000)}`);
    }
    if (args[0] === "diff") {
      return result.stdout;
    }
  }
  return "";
}

function deliverableFailure(root: string, problems: readonly string[]): ToolFailure {
  return failure(
    `The deliverable in ${root} is incomplete; nothing was recorded. Fix every item and call the tool again:\n${problems.map((problem) => `- [files] ${problem}`).join("\n")}`,
  );
}
