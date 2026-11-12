import { MAX_SKILLS, SKILL_HARNESSES, skillSource } from "../../../../src/contracts/conditions";
import {
  type HarborAgentOption,
  type HarnessOptions,
  type HarnessOptionValue,
  harnessOptionProblem,
  harnessOptionsFor,
} from "../../../../src/contracts/harness-options";
import { type Harness, harnessLabels } from "../../../../src/evaluation/models";
import type { RunDraft } from "./RunExecution";

type Condition = NonNullable<RunDraft["conditions"]>[number];

/** The harnesses the draft's models run, in the order they were picked. */
export function pickedHarnesses(draft: RunDraft): Harness[] {
  return [...new Set(draft.models.flatMap((model) => model.harnesses))];
}

/** An option's value as its field shows it: the Run page keeps every value as typed text. */
export function optionText(option: HarborAgentOption, value: HarnessOptionValue | undefined) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return option.kind === "object" ? JSON.stringify(value, null, 2) : String(value);
}

/** Typed text as the option's value, or why it can't be. */
function optionValue(
  harness: Harness,
  option: HarborAgentOption,
  given: HarnessOptionValue,
): { value: unknown } | { problem: string } {
  const text = optionText(option, given).trim();
  const named = `${harnessLabels[harness]} ${option.label}`;
  let value: unknown = text;
  if (option.kind === "boolean") value = text === "true";
  else if (option.kind === "integer" || option.kind === "number")
    value = text === "" ? Number.NaN : Number(text);
  else if (option.kind === "object") {
    try {
      value = JSON.parse(text);
    } catch {
      return { problem: `${named} isn't valid JSON.` };
    }
  }
  const problem = harnessOptionProblem(harness, option.name, value);
  return problem ? { problem: `${problem}.` } : { value };
}

/** A condition's options for the harnesses the draft runs, typed, or the first problem with them. */
function conditionOptions(
  condition: Condition,
  harnesses: readonly Harness[],
): { options: HarnessOptions } | { problem: string } {
  const options: Record<string, Record<string, unknown>> = {};
  for (const harness of harnesses) {
    for (const [name, given] of Object.entries(condition.harnessOptions?.[harness] ?? {})) {
      const option = harnessOptionsFor(harness).find((entry) => entry.name === name);
      if (!option) continue;
      const typed = optionValue(harness, option, given);
      if ("problem" in typed) return typed;
      options[harness] = { ...options[harness], [name]: typed.value };
    }
  }
  return { options: options as HarnessOptions };
}

/** Why the draft's conditions can't run, if they can't; undefined when they can. */
export function conditionsProblem(draft: RunDraft): string | undefined {
  const conditions = draft.conditions ?? [];
  if (draft.baseline === false && conditions.length === 0)
    return "Run the baseline or add a condition.";
  const harnesses = pickedHarnesses(draft);
  for (const condition of conditions) {
    const name = condition.name.trim();
    if (!name) return "Name each condition.";
    const skills = condition.skills.filter((skill) => skill.trim());
    const typed = conditionOptions(condition, harnesses);
    if ("problem" in typed) return typed.problem;
    const options = Object.keys(typed.options).length > 0;
    if (
      !skills.length &&
      !condition.instructions?.trim() &&
      condition.environment === undefined &&
      !options
    )
      return `${name} needs an environment, a skill, instructions, or a harness option.`;
    if (skills.length > MAX_SKILLS) return `${name} can add at most ${MAX_SKILLS} skills.`;
    if (skills.some((skill) => !skillSource(skill)))
      return `${name}: write each skill as a GitHub org/repo, org/repo@ref, or URL.`;
    // A condition with options runs only on the harnesses it sets them for (conditionRunsOn).
    const unsupported = harnesses
      .filter((harness) => !options || harness in typed.options)
      .find((harness) => !SKILL_HARNESSES.includes(harness));
    if (skills.length && unsupported)
      return `${name} adds skills, which ${harnessLabels[unsupported]} can't load. Skills run on Claude Code, Codex, and Pi.`;
  }
  return undefined;
}

/** The draft's conditions as the server takes them: blank skill rows dropped, text trimmed. */
export function submittedConditions(draft: RunDraft): Pick<RunDraft, "conditions" | "baseline"> {
  const harnesses = pickedHarnesses(draft);
  const conditions = (draft.conditions ?? []).map((condition) => {
    const typed = conditionOptions(condition, harnesses);
    const options = "options" in typed ? typed.options : {};
    return {
      name: condition.name.trim(),
      skills: condition.skills.map((skill) => skill.trim()).filter(Boolean),
      ...(condition.instructions?.trim() ? { instructions: condition.instructions.trim() } : {}),
      ...(condition.environment !== undefined ? { environment: condition.environment } : {}),
      ...(Object.keys(options).length ? { harnessOptions: options } : {}),
    };
  });
  return {
    ...(conditions.length ? { conditions } : {}),
    ...(draft.baseline === false ? { baseline: false } : {}),
  };
}
