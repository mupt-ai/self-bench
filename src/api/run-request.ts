import { z } from "zod";
import type { SelfBenchConfig } from "../config.js";
import {
  artifactRefSchema,
  MAX_CANDIDATES_PER_RUN,
  type RunRequest,
  repositoryRefSchema,
  runRequestSchema,
} from "../contracts.js";

const submissionSchema = z.object({
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  repository: repositoryRefSchema,
  provenance: artifactRefSchema,
  candidateCounts: z.object({
    easy: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
    medium: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
    hard: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
  }),
  authoringModel: z.string().min(1).default("gpt-5.6-sol"),
  selfbenchCommit: z.string().regex(/^[0-9a-f]{40}$/i),
});

export function buildRunRequest(
  config: SelfBenchConfig,
  submission: z.input<typeof submissionSchema>,
): RunRequest {
  const parsed = submissionSchema.parse(submission);
  return runRequestSchema.parse({
    runId: parsed.runId,
    repository: parsed.repository,
    provenance: parsed.provenance,
    candidateCounts: parsed.candidateCounts,
    authoring: {
      provider: "openai-codex",
      model: parsed.authoringModel,
      reasoningEffort: "high",
    },
    version: {
      selfbenchCommit: config.buildCommit ?? parsed.selfbenchCommit,
      executionBackend: config.execution.kind,
      harborEnvironment: config.harborEnvironment,
      sandboxImage: config.execution.image,
      ...(config.execution.kind === "vercel" || config.execution.kind === "e2b"
        ? { sandboxTimeoutCapMs: config.execution.timeoutCapMs }
        : {}),
      schema: 2,
    },
  });
}
