import {
  conditionHarness,
  DEFAULT_SUBAGENT_PROMPT,
  MAX_SKILLS,
  type SavedConditionDraft,
  SKILL_HARNESSES,
  skillSource,
} from "../../../../src/contracts/conditions";
import {
  type HarborAgentOption,
  type HarnessOptions,
  type HarnessOptionValue,
  harnessOptionProblem,
  harnessOptionsFor,
} from "../../../../src/contracts/harness-options";
import { type Harness, harnessLabels } from "../../../../src/evaluation/models";
import { subagentSupport } from "../../../../src/evaluation/subagents";
import type { SavedCondition } from "./condition-api";

/** Harness options as their fields hold them: every value typed text until the condition is saved. */
export type OptionsDraft = Partial<Record<Harness, Record<string, HarnessOptionValue>>>;

/**
 * A saved condition as its editor holds it: text as typed, checked when it is saved. It changes one
 * harness: its skills, options and subagent model belong to that harness, and are kept by harness
 * as they are typed, so switching harnesses and back loses nothing. Only the chosen harness's are
 * saved.
 */
export interface ConditionDraft {
  name: string;
  harness?: Harness;
  skills: string[];
  instructions: string;
  harnessOptions: OptionsDraft;
  /** The model its subagents run on, and what the harness is told about delegating. */
  subagent?: { catalogId: string; prompt: string };
}

export const blankCondition = (): ConditionDraft => ({
  name: "",
  skills: [],
  instructions: "",
  harnessOptions: {},
});

/** A saved condition as its editor opens it. */
export function draftOf(saved: SavedCondition): ConditionDraft {
  const harness = conditionHarness(saved);
  return {
    name: saved.name,
    ...(harness ? { harness } : {}),
    skills: [...saved.skills],
    instructions: saved.instructions ?? "",
    harnessOptions: { ...saved.harnessOptions },
    ...(saved.subagent ? { subagent: { ...saved.subagent } } : {}),
  };
}

/**
 * The harness picked, with what its fields cannot keep: skills it cannot load, and a subagent model
 * it cannot take, are dropped. Its options are kept, since they are kept by harness.
 */
export function withHarness(draft: ConditionDraft, harness: Harness): ConditionDraft {
  const skills = SKILL_HARNESSES.includes(harness) ? draft.skills : [];
  const { subagent: _, ...rest } = draft;
  return {
    ...rest,
    harness,
    skills,
    ...(subagentSupport[harness].configurable && draft.subagent
      ? { subagent: draft.subagent }
      : {}),
  };
}

/** A subagent model as the editor first shows it: with the delegation prompt runs have always had. */
export const subagentOn = (catalogId: string, prompt = DEFAULT_SUBAGENT_PROMPT) => ({
  catalogId,
  prompt,
});

/** An option's value as its field shows it. */
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

/** The chosen harness's options, typed, or the first problem with them. */
function typedOptions(draft: ConditionDraft): { options: HarnessOptions } | { problem: string } {
  const harness = draft.harness;
  if (!harness) return { options: {} };
  const options: Record<string, unknown> = {};
  for (const [name, given] of Object.entries(draft.harnessOptions[harness] ?? {})) {
    const option = harnessOptionsFor(harness).find((entry) => entry.name === name);
    if (!option) continue;
    const typed = optionValue(harness, option, given);
    if ("problem" in typed) return typed;
    options[name] = typed.value;
  }
  return Object.keys(options).length
    ? { options: { [harness]: options } as HarnessOptions }
    : { options: {} };
}

/** Why the draft can't be saved, if it can't; undefined when it can. */
export function conditionProblem(draft: ConditionDraft): string | undefined {
  if (!draft.name.trim()) return "Name the condition.";
  const skills = draft.skills.filter((skill) => skill.trim());
  const typed = typedOptions(draft);
  if ("problem" in typed) return typed.problem;
  if (!draft.harness && (skills.length || draft.subagent || Object.keys(typed.options).length))
    return "Pick a harness for its skills, options, or subagent model.";
  if (
    !skills.length &&
    !draft.instructions.trim() &&
    !draft.subagent &&
    !Object.keys(typed.options).length
  )
    return "Add a skill, instructions, a harness option, or a subagent model.";
  if (draft.harness && skills.length && !SKILL_HARNESSES.includes(draft.harness))
    return `${harnessLabels[draft.harness]} can't load skills. Skills run on Claude Code, Codex, and Pi.`;
  if (draft.subagent && draft.harness && !subagentSupport[draft.harness].configurable)
    return `${harnessLabels[draft.harness]} takes no subagent model.`;
  if (skills.length > MAX_SKILLS) return `A condition can add at most ${MAX_SKILLS} skills.`;
  if (skills.some((skill) => !skillSource(skill)))
    return "Write each skill as a GitHub org/repo, org/repo@ref, or URL.";
  return undefined;
}

/** The draft as the server takes it: blank skill rows dropped, text trimmed, options typed. */
export function submittedCondition(draft: ConditionDraft): SavedConditionDraft {
  const typed = typedOptions(draft);
  const options = "options" in typed ? typed.options : {};
  const instructions = draft.instructions.trim();
  return {
    name: draft.name.trim(),
    ...(draft.harness ? { harness: draft.harness } : {}),
    skills: draft.skills.map((skill) => skill.trim()).filter(Boolean),
    ...(instructions ? { instructions } : {}),
    ...(Object.keys(options).length ? { harnessOptions: options } : {}),
    ...(draft.subagent
      ? { subagent: { catalogId: draft.subagent.catalogId, prompt: draft.subagent.prompt.trim() } }
      : {}),
  };
}
