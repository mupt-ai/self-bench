import { z } from "zod";
import type { SelfBenchConfig } from "../config.js";
import {
  artifactRefSchema,
  MAX_CANDIDATES_PER_RUN,
  type ReplayRunRequest,
  type RunRequest,
  replayRunRequestSchema,
  replaySchema,
  repositoryRefSchema,
  runRequestSchema,
} from "../contracts.js";

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

const replaySubmissionSchema = z.object({ ...commonSchema, replay: replaySchema });

export type RunSubmission =
  | z.input<typeof submissionSchema>
  | z.input<typeof replaySubmissionSchema>;

export function buildRunRequest(
  config: SelfBenchConfig,
  submission: RunSubmission,
): RunRequest | ReplayRunRequest {
  if ("replay" in submission) {
    const parsed = replaySubmissionSchema.parse(submission);
    return replayRunRequestSchema.parse({
      runId: parsed.runId,
      replay: parsed.replay,
      authoring: authoring(parsed.authoringModel),
      version: version(config, parsed.selfbenchCommit),
    });
  }
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
