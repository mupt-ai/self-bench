import { z } from "zod";
import type { ArtifactRef } from "./common.js";
import type { AuthoredTask, AuthoredTaskDraft } from "./task.js";

export const verifyStageSchema = z.enum(["authoring", "verification"]);
export type VerifyStage = z.infer<typeof verifyStageSchema>;

export const MAX_AUTHORING_ROUNDS = 3;
export const MAX_VERIFIER_ROUNDS = 3;

export const harborRewardsSchema = z.record(z.string(), z.number());
export type HarborRewards = z.infer<typeof harborRewardsSchema>;

const gateSchema = z.object({
  ran: z.boolean(),
  ok: z.boolean(),
  logTail: z.string(),
});

const rewardGateSchema = gateSchema.extend({ rewards: harborRewardsSchema });

/**
 * One round's mechanical verdict on a submitted task: trusted compile (schema, policy, evidence),
 * static audit, Harbor image build, smoke command, and the nop/oracle split. Rendered as markdown
 * for the agent and stored as JSON per round.
 */
export const verifyReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: verifyStageSchema,
    round: z.number().int().positive(),
    taskId: z.string().min(1),
    compile: z.object({ ok: z.boolean(), errors: z.array(z.string()) }),
    audit: z.object({ ok: z.boolean(), blockers: z.array(z.string()) }),
    build: gateSchema.extend({ infrastructure: z.boolean() }),
    smoke: gateSchema,
    nop: rewardGateSchema,
    oracle: rewardGateSchema,
    green: z.boolean(),
  })
  .strict();

export type VerifyReport = z.infer<typeof verifyReportSchema>;

export interface VerifyOutcome {
  readonly report: VerifyReport;
  /** Stored JSON report for this round. */
  readonly reportRef: ArtifactRef;
  /** The compiled Harbor bundle; absent when compilation failed. */
  readonly task?: AuthoredTask;
}

export type AuthoringRoundResult =
  | {
      readonly kind: "submitted";
      readonly task: AuthoredTaskDraft;
      readonly session: ArtifactRef;
    }
  | { readonly kind: "rejected"; readonly candidateId: string; readonly reason: string };

export type VerifierRoundResult =
  | { readonly kind: "accepted"; readonly session: ArtifactRef; readonly reason: string }
  | {
      readonly kind: "fixed";
      readonly task: AuthoredTaskDraft;
      readonly session: ArtifactRef;
      readonly summary: string;
    }
  | { readonly kind: "rejected"; readonly candidateId: string; readonly reason: string };
