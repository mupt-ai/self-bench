import { createHash } from "node:crypto";
import type { z } from "zod";
import { type conditionSchema, SKILL_HARNESSES } from "../contracts/conditions.js";
import {
  canonicalOptions,
  type HarnessOptions,
  harnessOptionArguments,
} from "../contracts/harness-options.js";
import { type Harness, harnessLabels } from "./models.js";

/**
 * A run condition: what a comparison changes for every task it picks. Skills are installed into the
 * agent's skills directory and instructions appended to each task's instruction, both by Harbor
 * (`--skill`, `--extra-instruction`); harness options set the agent's own options
 * (`--agent-kwarg`), and run only on the harnesses they name; an environment runs each task as a
 * repository environment built it, from its variant's bundle. Results keep each condition apart
 * from the baseline, so the two can be compared on the same tasks.
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
  /** Each harness's Harbor agent options; a condition with any runs only on those harnesses. */
  readonly harnessOptions?: HarnessOptions;
}

/** A condition as a comparison names it; `environment` is its environment's name, once found. */
export function runCondition(
  given: z.infer<typeof conditionSchema>,
  environmentName?: string,
): RunCondition {
  // A set of skills, in one order, so the same set is the same condition however it was listed.
  const skills = [...new Set(given.skills)].sort();
  const instructions = given.instructions || undefined;
  const harnessOptions = Object.keys(given.harnessOptions ?? {}).length
    ? canonicalOptions(given.harnessOptions ?? {})
    : undefined;
  const id = createHash("sha256")
    .update(
      JSON.stringify({
        skills,
        instructions: instructions ?? "",
        // Added only when set, so a condition without one keeps the id it always had.
        ...(given.environment !== undefined ? { environment: given.environment } : {}),
        ...(harnessOptions ? { harnessOptions } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return {
    id,
    name: given.name,
    skills,
    ...(instructions ? { instructions } : {}),
    ...(harnessOptions ? { harnessOptions } : {}),
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

/**
 * Whether a condition runs on `harness`: one that sets harness options runs only on the harnesses
 * it sets them for, since on another it would change nothing it names.
 */
export function conditionRunsOn(condition: RunCondition | undefined, harness: Harness): boolean {
  const options = condition?.harnessOptions;
  return !options || Object.keys(options).length === 0 || harness in options;
}

/** Why none of `harnesses` runs a condition that sets harness options, if none does. */
export function conditionUnmatched(
  condition: RunCondition,
  harnesses: readonly Harness[],
): string | undefined {
  if (harnesses.some((harness) => conditionRunsOn(condition, harness))) return undefined;
  const named = Object.keys(condition.harnessOptions ?? {}).map(
    (harness) => harnessLabels[harness as Harness],
  );
  return `${condition.name} sets options for ${named.join(" and ")}, which no picked model runs`;
}

/** The `harbor run` arguments that apply a condition to a trial on `harness`. */
export function conditionArguments(
  condition: RunCondition | undefined,
  harness: Harness,
): string[] {
  if (!condition) return [];
  return [
    ...condition.skills.flatMap((skill) => ["--skill", skill]),
    ...(condition.instructions ? ["--extra-instruction", condition.instructions] : []),
    ...harnessOptionArguments(condition.harnessOptions, harness),
  ];
}
