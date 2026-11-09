import { createHash } from "node:crypto";
import type { z } from "zod";
import { type conditionSchema, SKILL_HARNESSES } from "../contracts/conditions.js";
import type { Harness } from "./models.js";

/**
 * A run condition: what a comparison changes about how agents run, for every task it picks, without
 * touching the tasks. Skills are installed into the agent's skills directory and instructions are
 * appended to each task's instruction, both by Harbor (`--skill`, `--extra-instruction`). Results
 * keep each condition apart from the baseline, so the two can be compared on the same tasks.
 */
export interface RunCondition {
  /** A digest of what it changes: two conditions that change the same things are one. */
  readonly id: string;
  readonly name: string;
  /** GitHub sources, each `https://github.com/org/repo[/tree/ref]`, whose `skills/` Harbor installs. */
  readonly skills: readonly string[];
  readonly instructions?: string;
}

export function runCondition(given: z.infer<typeof conditionSchema>): RunCondition {
  const skills = [...new Set(given.skills)];
  const instructions = given.instructions || undefined;
  const id = createHash("sha256")
    .update(JSON.stringify({ skills, instructions: instructions ?? "" }))
    .digest("hex")
    .slice(0, 12);
  return { id, name: given.name, skills, ...(instructions ? { instructions } : {}) };
}

/** Why `condition` cannot run on `harness`, if it cannot. */
export function conditionRefusal(condition: RunCondition, harness: Harness): string | undefined {
  if (condition.skills.length && !SKILL_HARNESSES.includes(harness))
    return `${condition.name} adds skills, which only Claude Code, Codex, and Pi load`;
  return undefined;
}

/** The `harbor run` arguments that apply a condition to a trial. */
export function conditionArguments(condition: RunCondition | undefined): string[] {
  if (!condition) return [];
  return [
    ...condition.skills.flatMap((skill) => ["--skill", skill]),
    ...(condition.instructions ? ["--extra-instruction", condition.instructions] : []),
  ];
}
