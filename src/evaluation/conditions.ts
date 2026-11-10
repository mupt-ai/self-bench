import { createHash } from "node:crypto";
import type { z } from "zod";
import { type conditionSchema, SKILL_HARNESSES } from "../contracts/conditions.js";
import type { Harness } from "./models.js";

/**
 * A run condition: what a comparison changes for every task it picks. Skills are installed into the
 * agent's skills directory and instructions appended to each task's instruction, both by Harbor
 * (`--skill`, `--extra-instruction`); an environment runs each task as a repository environment
 * built it, from its variant's bundle. Results keep each condition apart from the baseline, so
 * the two can be compared on the same tasks.
 */
export interface RunCondition {
  /** A digest of what it changes: two conditions that change the same things are one. */
  readonly id: string;
  readonly name: string;
  /** GitHub sources, each `https://github.com/org/repo[/tree/ref]`, whose `skills/` Harbor installs. */
  readonly skills: readonly string[];
  readonly instructions?: string;
  /** The repository environment its tasks ran in, by id and name. */
  readonly environment?: { readonly id: number; readonly name: string };
}

/** A condition as a comparison names it; `environment` is its environment's name, once found. */
export function runCondition(
  given: z.infer<typeof conditionSchema>,
  environmentName?: string,
): RunCondition {
  // A set of skills, in one order, so the same set is the same condition however it was listed.
  const skills = [...new Set(given.skills)].sort();
  const instructions = given.instructions || undefined;
  const id = createHash("sha256")
    .update(
      JSON.stringify({
        skills,
        instructions: instructions ?? "",
        // Added only when set, so a condition without one keeps the id it always had.
        ...(given.environment !== undefined ? { environment: given.environment } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return {
    id,
    name: given.name,
    skills,
    ...(instructions ? { instructions } : {}),
    ...(given.environment !== undefined
      ? { environment: { id: given.environment, name: environmentName ?? given.name } }
      : {}),
  };
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
