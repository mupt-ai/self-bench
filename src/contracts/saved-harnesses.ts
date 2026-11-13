import { z } from "zod";
import { harnessIds } from "../evaluation/models.js";
import {
  changesSomething,
  credentialId,
  harnessChanges,
  harnessFits,
  subagentSchema,
} from "./conditions.js";

/**
 * A saved harness's fields as older clients sent them, when it was a "saved condition": the agent
 * it changes was `harness`. Read as `agent`, so either spelling saves the same harness.
 */
function agentNamed(given: unknown): unknown {
  if (!given || typeof given !== "object" || Array.isArray(given)) return given;
  const { harness, ...rest } = given as Record<string, unknown>;
  if (harness === undefined || "agent" in rest) return given;
  return { ...rest, agent: harness };
}

const { harness: _, ...changes } = harnessChanges;

/**
 * A saved harness (`/api/orgs/{org}/harnesses`): a workspace's named change to one agent (Claude
 * Code, Codex, Pi, …): its skills, instructions, options, and subagent model with the credential
 * that serves it. Any of the workspace's runs picks it by id. It names no environment, which
 * belongs to the repository and is picked beside it.
 */
export const savedHarnessSchema = z.preprocess(
  agentNamed,
  z
    .object({
      ...changes,
      /** The agent it changes: its options, skills, and subagent model all belong to it. */
      agent: z.enum(harnessIds).optional(),
      /** Its subagent model, and the credential that serves it: the first that can when unset. */
      subagent: subagentSchema
        .extend({ credentialId: credentialId.optional() })
        .strict()
        .optional(),
    })
    .strict()
    .refine(changesSomething, {
      message: "a harness adds a skill, instructions, options, or a subagent model",
    })
    .superRefine((saved, context) => harnessFits({ ...saved, harness: saved.agent }, context)),
);
export type SavedHarnessDraft = z.infer<typeof savedHarnessSchema>;
