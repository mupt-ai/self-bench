import { z } from "zod";
import { type ArtifactRef, artifactRefSchema } from "./common.js";
import { type AuthoredTask, authoredTaskDraftSchema, authoredTaskSchema } from "./task.js";

export const verifyStageSchema = z.enum(["authoring", "verification"]);
export type VerifyStage = z.infer<typeof verifyStageSchema>;

export const MAX_AUTHORING_ROUNDS = 3;
export const MAX_VERIFIER_ROUNDS = 3;
/** In-session `verify` calls per agent session (carried across fallback rounds). */
export const AUTHOR_VERIFY_BUDGET = 5;
export const VERIFIER_VERIFY_BUDGET = 2;

export const harborRewardsSchema = z.record(z.string(), z.number());
export type HarborRewards = z.infer<typeof harborRewardsSchema>;

const gateSchema = z.object({
  ran: z.boolean(),
  ok: z.boolean(),
  /** Actionable excerpt: error lines with context, compose diagnostics, filtered tail. */
  logTail: z.string(),
  /** The complete raw log stored next to the report. */
  log: artifactRefSchema.optional(),
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

export const verifyOutcomeSchema = z.object({
  report: verifyReportSchema,
  reportRef: artifactRefSchema,
  task: authoredTaskDraftSchema.extend({ bundle: artifactRefSchema }).optional(),
});

export interface VerifyOutcome {
  readonly report: VerifyReport;
  /** Stored JSON report for this round. */
  readonly reportRef: ArtifactRef;
  /** The compiled Harbor bundle; absent when compilation failed. */
  readonly task?: AuthoredTask;
}

/** A green in-session verify whose payload equals the final submission; the worker reuses it. */
const verifiedSubmissionSchema = z.object({
  report: artifactRefSchema,
  task: authoredTaskSchema,
});

const rejectedRoundSchema = z.object({
  kind: z.literal("rejected"),
  candidateId: z.string().min(1),
  reason: z.string().min(1),
});

export const authoringRoundResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("submitted"),
    task: authoredTaskDraftSchema,
    session: artifactRefSchema,
    verifyCalls: z.number().int().nonnegative().optional(),
    verified: verifiedSubmissionSchema.optional(),
  }),
  rejectedRoundSchema,
]);

export type AuthoringRoundResult = z.infer<typeof authoringRoundResultSchema>;

export const verifierRoundResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), session: artifactRefSchema, reason: z.string().min(1) }),
  z.object({
    kind: z.literal("suggestions"),
    session: artifactRefSchema,
    summary: z.string().min(1),
    suggestions: z.string().min(1),
  }),
  // Historical compatibility; new verifier sessions cannot produce this variant.
  z.object({
    kind: z.literal("fixed"),
    task: authoredTaskDraftSchema,
    session: artifactRefSchema,
    summary: z.string().min(1),
    verifyCalls: z.number().int().nonnegative().optional(),
    verified: verifiedSubmissionSchema.optional(),
  }),
  rejectedRoundSchema,
]);

export type VerifierRoundResult = z.infer<typeof verifierRoundResultSchema>;
