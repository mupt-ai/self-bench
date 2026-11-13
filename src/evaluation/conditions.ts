import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  conditionHarness,
  conditionRunsOn,
  type conditionSchema,
  SKILL_HARNESSES,
} from "../contracts/conditions.js";
import {
  canonicalOptions,
  type HarnessOptions,
  harnessOptionArguments,
} from "../contracts/harness-options.js";
import { type Harness, harnessLabels } from "./models.js";
import { subagentSupport } from "./subagents.js";

/**
 * A run condition: what a comparison changes for every task it picks. Skills are installed into the
 * agent's skills directory and instructions appended to each task's instruction, both by Harbor
 * (`--skill`, `--extra-instruction`); harness options set the agent's own options
 * (`--agent-kwarg`), and run only on the harnesses they name; an environment runs each task as a
 * repository environment built it, from its variant's bundle; a subagent model runs the harness's
 * delegated agents on another model (subagents.ts). Results keep each condition apart from the
 * baseline, so the two can be compared on the same tasks.
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
  /** The one harness it changes, when it changes one: its options, skills, and subagents. */
  readonly harness?: Harness;
  /** That harness's Harbor agent options; a condition with any runs only on that harness. */
  readonly harnessOptions?: HarnessOptions;
  /**
   * The model its subagents run on, by catalog id, and what the harness is told about delegating
   * (empty for nothing). A condition with one runs only on the harnesses that take one, and its
   * runs record the model as served (EvaluationInput.subagent).
   */
  readonly subagent?: { readonly catalogId: string; readonly prompt: string };
}

/** A condition as a comparison names it; `environment` is its environment's name, once found. */
export function runCondition(
  given: Omit<z.infer<typeof conditionSchema>, "subagent"> & {
    subagent?: { catalogId: string; prompt: string } | undefined;
  },
  environmentName?: string,
): RunCondition {
  // A set of skills, in one order, so the same set is the same condition however it was listed.
  const skills = [...new Set(given.skills)].sort();
  const instructions = given.instructions || undefined;
  const harnessOptions = Object.keys(given.harnessOptions ?? {}).length
    ? canonicalOptions(given.harnessOptions ?? {})
    : undefined;
  const subagent = given.subagent
    ? { catalogId: given.subagent.catalogId, prompt: given.subagent.prompt }
    : undefined;
  // Named only when no options carry it, so a condition's id is the same whichever way it names it.
  const harness = conditionHarness(given);
  const named = harness && !harnessOptions ? harness : undefined;
  const id = createHash("sha256")
    .update(
      JSON.stringify({
        skills,
        instructions: instructions ?? "",
        // Added only when set, so a condition without one keeps the id it always had.
        ...(given.environment !== undefined ? { environment: given.environment } : {}),
        ...(harnessOptions ? { harnessOptions } : {}),
        ...(named ? { harness: named } : {}),
        ...(subagent ? { subagent } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return {
    id,
    name: given.name,
    skills,
    ...(instructions ? { instructions } : {}),
    ...(harness ? { harness } : {}),
    ...(harnessOptions ? { harnessOptions } : {}),
    ...(given.environment !== undefined
      ? { environment: { id: given.environment, name: environmentName ?? given.name } }
      : {}),
    ...(subagent ? { subagent } : {}),
  };
}

/** Why `condition` cannot run on `harness`, if it cannot. */
export function conditionRefusal(condition: RunCondition, harness: Harness): string | undefined {
  if (condition.skills.length && !SKILL_HARNESSES.includes(harness))
    return `${condition.name} adds skills, which only Claude Code, Codex, and Pi load`;
  return undefined;
}

/** Why none of `harnesses` runs a condition that narrows the harnesses it runs on, if none does. */
export function conditionUnmatched(
  condition: RunCondition,
  harnesses: readonly Harness[],
): string | undefined {
  if (harnesses.some((harness) => conditionRunsOn(condition, harness))) return undefined;
  const only = conditionHarness(condition);
  // A subagent model is what rules the harnesses out when none of them takes one.
  if (condition.subagent && harnesses.every((harness) => !subagentSupport[harness].configurable))
    return `${condition.name} sets a subagent model, which only Claude Code and Codex take, and no picked model runs either`;
  const named = only ? harnessLabels[only] : "a harness";
  return `${condition.name} is for ${named}, which no picked model runs`;
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
