import { z } from "zod";
import { type Harness, harnessIds, harnessLabels } from "../evaluation/models.js";
import { subagentSupport } from "../evaluation/subagents.js";
import { harnessOptionsSchema } from "./harness-options.js";
import { thinkingLevels } from "./models.js";

/**
 * Run conditions (evaluation/conditions.ts) as a batch names them: shared with the Run page,
 * so nothing here may need Node.
 */

/** The harnesses whose Harbor agents install skills: Claude Code, Codex, and Pi. */
export const SKILL_HARNESSES: readonly Harness[] = ["claude-code", "codex", "pi"];

/**
 * The one harness a condition changes: the one it names, or else the one its options are set for.
 * None when it changes no harness, which runs on every harness the run picks.
 */
export function conditionHarness(
  condition: { harness?: Harness | undefined; harnessOptions?: object | undefined } | undefined,
): Harness | undefined {
  if (condition?.harness) return condition.harness;
  return Object.keys(condition?.harnessOptions ?? {})[0] as Harness | undefined;
}

/**
 * Whether a condition runs on `harness`: one that changes a harness runs only on that harness, and
 * one with a subagent model only on a harness that takes one, since on another it would change
 * nothing it names.
 */
export function conditionRunsOn(
  condition:
    | {
        harness?: Harness | undefined;
        harnessOptions?: object | undefined;
        subagent?: object | undefined;
      }
    | undefined,
  harness: Harness,
): boolean {
  if (condition?.subagent && !subagentSupport[harness].configurable) return false;
  const only = conditionHarness(condition);
  return !only || only === harness;
}

export const MAX_CONDITIONS = 4;
/** The most saved harnesses, and the most environments, one run picks; it runs every pair. */
export const MAX_PICKED = 4;
/** The most pairs one batch runs beside the baseline, each a full run of every task. */
export const MAX_PAIRS = 12;
export const MAX_SKILLS = 10;
/** The longest skill source a condition takes: a GitHub URL with a ref. */
export const MAX_SKILL_LENGTH = 300;
const MAX_INSTRUCTIONS = 4_000;
/** The longest delegation prompt a condition gives a harness beside its subagent model. */
const MAX_SUBAGENT_PROMPT = 4_000;

/**
 * What a harness is told when its subagents run on another model, unless the condition says
 * otherwise: left to itself it may do the whole task on the run's own model, and the run measures
 * the two working together. A run that names its subagent model on a model row, with no prompt of
 * its own, is told the same (harbor_gateway.py's SUBAGENT_REQUIRED_PROMPT).
 */
export const DEFAULT_SUBAGENT_PROMPT =
  "You must do your planning, but move all implementation to subagents. " +
  "Spawn subagents, wait for its result, and use that result before finishing.";

const part = "[A-Za-z0-9._-]+";
const shorthand = new RegExp(`^(${part})/(${part})(?:@(${part}))?$`);
const url = new RegExp(`^https://github\\.com/(${part})/(${part})(?:/tree/(${part}))?/?$`);

/**
 * A skill source as Harbor fetches it: always a GitHub URL, so it can never name a directory on
 * the worker. `org/repo` and `org/repo@ref` are accepted and written out as URLs.
 */
export function skillSource(value: string): string | undefined {
  const given = value.trim();
  const match = shorthand.exec(given) ?? url.exec(given);
  if (!match) return undefined;
  const [, org, cloned, ref] = match;
  const repo = cloned?.replace(/\.git$/, "");
  if (!org || !repo || [org, repo, ref].some((piece) => piece === "." || piece === ".."))
    return undefined;
  return `https://github.com/${org}/${repo}${ref ? `/tree/${ref}` : ""}`;
}

export const credentialId = z.union([z.uuid(), z.literal("managed-model")]);

/**
 * The model a condition's subagents run on (evaluation/subagents.ts), by its catalog id, what
 * the harness is told about delegating (DEFAULT_SUBAGENT_PROMPT when left out, nothing when
 * empty), and the thinking level every subagent call is served at: the model's default when left
 * out, which is why "default" is no level to name here.
 */
export const subagentSchema = z
  .object({
    catalogId: z.string().trim().min(1).max(200),
    prompt: z.string().trim().max(MAX_SUBAGENT_PROMPT).default(DEFAULT_SUBAGENT_PROMPT),
    thinking: z.enum(thinkingLevels).exclude(["default"]).optional(),
  })
  .strict();
export type SubagentThinking = NonNullable<z.infer<typeof subagentSchema>["thinking"]>;

/** What a condition changes about the harness: the same for every repository and benchmark. */
export const harnessChanges = {
  name: z.string().trim().min(1).max(60),
  /** The harness it changes: its options, skills, and subagent model all belong to it. */
  harness: z.enum(harnessIds).optional(),
  skills: z
    .array(
      z
        .string()
        .max(MAX_SKILL_LENGTH)
        .refine((value) => skillSource(value) !== undefined, "a GitHub org/repo[@ref] or URL")
        .transform((value) => skillSource(value) as string),
    )
    .max(MAX_SKILLS)
    .default([]),
  instructions: z.string().trim().max(MAX_INSTRUCTIONS).optional(),
  /** Options for each harness's Harbor agent (harness-options.ts), by harness. */
  harnessOptions: harnessOptionsSchema.optional(),
};

export const changesSomething = (condition: {
  skills: readonly string[];
  instructions?: string | undefined;
  environment?: number | undefined;
  harnessOptions?: object | undefined;
  subagent?: object | undefined;
}) =>
  condition.skills.length > 0 ||
  !!condition.instructions ||
  condition.environment !== undefined ||
  condition.subagent !== undefined ||
  Object.keys(condition.harnessOptions ?? {}).length > 0;

/**
 * A condition changes one harness, so the harness, its options, and the skills and subagent model
 * it is given must all fit it: skills need a harness that loads them, and a subagent model one that
 * takes it (SKILL_HARNESSES, subagentSupport).
 */
export function harnessFits(
  condition: {
    harness?: Harness | undefined;
    skills: readonly string[];
    harnessOptions?: object | undefined;
    subagent?: object | undefined;
  },
  context: z.RefinementCtx,
) {
  const named = Object.keys(condition.harnessOptions ?? {});
  if (named.length > 1)
    context.addIssue({ code: "custom", message: "it changes one agent: pick one" });
  if (condition.harness && named.some((harness) => harness !== condition.harness))
    context.addIssue({
      code: "custom",
      message: `its options are for ${harnessLabels[named[0] as Harness]}, not ${harnessLabels[condition.harness]}`,
    });
  const harness = conditionHarness(condition);
  if (!harness) return;
  if (condition.skills.length > 0 && !SKILL_HARNESSES.includes(harness))
    context.addIssue({
      code: "custom",
      message: `${harnessLabels[harness]} can't load skills. Skills run on Claude Code, Codex, and Pi`,
    });
  if (condition.subagent && !subagentSupport[harness].configurable)
    context.addIssue({
      code: "custom",
      message: `${harnessLabels[harness]} takes no subagent model: only Claude Code and Codex do`,
    });
}

/** A condition as a batch names it; `runCondition` gives it its id. */
export const conditionSchema = z
  .object({
    ...harnessChanges,
    /** A repository environment (`{repo}/environments`): every task as it built them. */
    environment: z.number().int().positive().optional(),
    /** Its subagent model, and the credential that serves it: the first that can when left out. */
    subagent: subagentSchema.extend({ credentialId: credentialId.optional() }).strict().optional(),
  })
  .strict()
  .refine(changesSomething, {
    message: "each one adds a skill, instructions, an environment, options, or a subagent model",
  })
  .superRefine(harnessFits);

/**
 * One pair a batch runs, as older clients and retries name it: one of the workspace's saved
 * harnesses by id, the repository environment its tasks run in, or both. A credential named here
 * serves the saved harness's subagent model in place of its own. Newer clients send `harnesses`
 * and `environments` (batches.ts), which run every pair.
 */
const pickedConditionSchema = z
  .object({
    saved: z.number().int().positive().optional(),
    environment: z.number().int().positive().optional(),
    subagentCredentialId: credentialId.optional(),
  })
  .strict()
  .refine((picked) => picked.saved !== undefined || picked.environment !== undefined, {
    message: "pick a saved harness, an environment, or both",
  });

/** One of a batch's pairs: one picked from what is saved, or one written out (retries). */
export const runBatchConditionSchema = z.union([pickedConditionSchema, conditionSchema]);
export type RunBatchCondition = z.infer<typeof runBatchConditionSchema>;
