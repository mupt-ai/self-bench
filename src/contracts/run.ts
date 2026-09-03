import { z } from "zod";
import { EXECUTION_BACKENDS, HARBOR_ENVIRONMENTS } from "../providers.js";
import { artifactRefSchema, commitSchema, repositoryRefSchema } from "./common.js";

export const MAX_CANDIDATES_PER_RUN = 10_000;

const candidateCountsSchema = z
  .object({
    easy: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
    medium: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
    hard: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
  })
  .refine(({ easy, medium, hard }) => easy + medium + hard >= 1, {
    message: "at least one candidate must be requested",
  })
  .refine(({ easy, medium, hard }) => easy + medium + hard <= MAX_CANDIDATES_PER_RUN, {
    message: `at most ${MAX_CANDIDATES_PER_RUN} candidates may be requested`,
  });

const runVersionSchema = z
  .object({
    selfbenchCommit: commitSchema,
    executionBackend: z.enum(EXECUTION_BACKENDS),
    harborEnvironment: z.enum(HARBOR_ENVIRONMENTS),
    sandboxImage: z.string().min(1),
    sandboxTimeoutCapMs: z.number().int().min(100).optional(),
    schema: z.literal(2),
  })
  .refine(
    (version) =>
      version.sandboxTimeoutCapMs === undefined ||
      version.executionBackend === "vercel" ||
      version.executionBackend === "e2b",
    {
      message: "sandboxTimeoutCapMs is only valid for Vercel or E2B execution",
      path: ["sandboxTimeoutCapMs"],
    },
  );

const runIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/);

const authoringSchema = z.object({
  provider: z.literal("openai-codex"),
  model: z.string().min(1),
  reasoningEffort: z.literal("high"),
});

export const MAX_EXCLUDED_RUNS = 100;

/** Run IDs whose processed source PRs discovery must never propose again. */
export const excludeRunsSchema = z.array(runIdSchema).max(MAX_EXCLUDED_RUNS);

export const runRequestSchema = z.object({
  runId: runIdSchema,
  repository: repositoryRefSchema,
  provenance: artifactRefSchema,
  candidateCounts: candidateCountsSchema,
  excludeRuns: excludeRunsSchema.optional(),
  authoring: authoringSchema,
  version: runVersionSchema,
});

export type RunRequest = z.infer<typeof runRequestSchema>;

export const replaySchema = z
  .object({
    sourceRunId: runIdSchema,
    candidateIds: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/))
      .min(1)
      .max(MAX_CANDIDATES_PER_RUN),
  })
  .strict();

/**
 * Starts a run from known candidates of an earlier run instead of discovery: the worker rebuilds
 * each Candidate from the source run's artifacts and runs authoring and verification fresh.
 */
export const replayRunRequestSchema = z.object({
  runId: runIdSchema,
  replay: replaySchema,
  authoring: authoringSchema,
  version: runVersionSchema,
});

export type ReplayRunRequest = z.infer<typeof replayRunRequestSchema>;

export type WorkflowRunInput = RunRequest | ReplayRunRequest;

export function isReplayRunRequest(input: WorkflowRunInput): input is ReplayRunRequest {
  return "replay" in input;
}
