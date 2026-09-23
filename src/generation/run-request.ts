import { z } from "zod";
import type { SelfBenchConfig } from "../contracts/config/index.js";
import {
  artifactRefSchema,
  MAX_CANDIDATES_PER_RUN,
  type RunRequest,
  repositoryRefSchema,
  runRequestSchema,
} from "../contracts/index.js";

const runIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/);
const commonSchema = {
  runId: runIdSchema,
  authoringModel: z.string().min(1).default("gpt-5.6-sol"),
  selfbenchCommit: z.string().regex(/^[0-9a-f]{40}$/i),
};

const submissionSchema = z.object({
  ...commonSchema,
  repository: repositoryRefSchema,
  provenance: artifactRefSchema,
  candidateCounts: z.object({
    easy: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
    medium: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
    hard: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
  }),
});

export type RunSubmission = z.input<typeof submissionSchema>;

export function buildRunRequest(config: SelfBenchConfig, submission: RunSubmission): RunRequest {
  const parsed = submissionSchema.parse(submission);
  return runRequestSchema.parse({
    runId: parsed.runId,
    repository: parsed.repository,
    provenance: parsed.provenance,
    candidateCounts: parsed.candidateCounts,
    authoring: authoring(parsed.authoringModel),
    version: version(config, parsed.selfbenchCommit),
  });
}

function authoring(model: string): RunRequest["authoring"] {
  return { provider: "openai-codex", model, reasoningEffort: "high" };
}

function version(config: SelfBenchConfig, selfbenchCommit: string): RunRequest["version"] {
  return {
    selfbenchCommit: config.buildCommit ?? selfbenchCommit,
    executionBackend: config.execution.kind,
    harborEnvironment: config.harborEnvironment,
    sandboxImage: config.execution.image,
    ...(config.execution.kind === "vercel" || config.execution.kind === "e2b"
      ? { sandboxTimeoutCapMs: config.execution.timeoutCapMs }
      : {}),
    schema: 2,
  };
}
