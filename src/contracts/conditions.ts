import { z } from "zod";
import type { Harness } from "../evaluation/models.js";

/**
 * Run conditions (evaluation/conditions.ts) as a comparison names them: shared with the Run page,
 * so nothing here may need Node.
 */

/** The harnesses whose Harbor agents install skills: Claude Code, Codex, and Pi. */
export const SKILL_HARNESSES: readonly Harness[] = ["claude-code", "codex", "pi"];

export const MAX_CONDITIONS = 4;
const MAX_INSTRUCTIONS = 4_000;

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

/** A condition as a comparison names it; `runCondition` gives it its id. */
export const conditionSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    skills: z
      .array(
        z
          .string()
          .refine((value) => skillSource(value) !== undefined, "a GitHub org/repo[@ref] or URL")
          .transform((value) => skillSource(value) as string),
      )
      .max(10)
      .default([]),
    instructions: z.string().trim().max(MAX_INSTRUCTIONS).optional(),
  })
  .strict()
  .refine((condition) => condition.skills.length > 0 || !!condition.instructions, {
    message: "a condition adds a skill or instructions",
  });
