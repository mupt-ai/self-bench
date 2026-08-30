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

export const runRequestSchema = z.object({
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  repository: repositoryRefSchema,
  provenance: artifactRefSchema,
  candidateCounts: candidateCountsSchema,
  authoring: z.object({
    provider: z.literal("openai-codex"),
    model: z.string().min(1),
    reasoningEffort: z.literal("high"),
  }),
  version: runVersionSchema,
});

export type RunRequest = z.infer<typeof runRequestSchema>;
