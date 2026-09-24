import { z } from "zod";
import { loadConfig, type SelfBenchConfig } from "../../contracts/config/index.js";
import {
  artifactRefSchema,
  MAX_CANDIDATES_PER_RUN,
  type RunRequest,
  repositoryRefSchema,
  runRequestSchema,
} from "../../contracts/index.js";
import { sandboxImageEnvironment } from "../../sandbox/runtime-image.js";
import { managedHarborEnvironment } from "../billing/managed.js";
import {
  type GenerationReference,
  type GenerationSettings,
  generationExecutionBackend,
  generationHarborEnvironment,
} from "./settings.js";

const runIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/);
const commonSchema = {
  runId: runIdSchema,
  authoringModel: z.string().min(1).default("gpt-6-sol"),
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
    ...("timeoutCapMs" in config.execution
      ? { sandboxTimeoutCapMs: config.execution.timeoutCapMs }
      : {}),
    schema: 2,
  };
}

/** Generation agents and Harbor verification have independent provider contracts. */
export function generationConfigEnvironment(
  settings: GenerationSettings,
  base: NodeJS.ProcessEnv,
  image = settings.sandboxImage,
  /** Managed runs: the Harbor environment stamped at creation; new runs read the live keys. */
  managedHarbor = managedHarborEnvironment(base),
): NodeJS.ProcessEnv {
  const backend = generationExecutionBackend(settings.sandbox);
  return {
    ...base,
    SELFBENCH_EXECUTION_BACKEND: backend,
    SELFBENCH_HARBOR_ENVIRONMENT: generationHarborEnvironment(settings, managedHarbor),
    ...sandboxImageEnvironment(backend, image),
  };
}

/** Shared configuration for single-PR and discovered batch candidates. */
export function configureGenerationRun(
  run: RunRequest,
  generation: GenerationReference,
  config: SelfBenchConfig,
) {
  run.generation = generation;
  // Provisional: the worker re-resolves the provider and the provider-specific model id
  // from the selected credential per stage before each agent invocation.
  run.authoring = {
    provider: generation.settings.modelAccess === "managed" ? "openrouter" : "openai",
    model: generation.settings.authorModel,
    reasoningEffort: generation.settings.reasoning,
  };
  const settings = generation.settings;
  const selected = loadConfig(
    generationConfigEnvironment(
      settings,
      process.env,
      settings.sandboxImage ??
        (settings.sandbox !== "managed" && settings.sandbox === config.execution.kind
          ? config.execution.image
          : undefined),
    ),
  );
  run.version.executionBackend = selected.execution.kind;
  run.version.harborEnvironment = selected.harborEnvironment;
  run.version.sandboxImage = selected.execution.image;
  if ("timeoutCapMs" in selected.execution)
    run.version.sandboxTimeoutCapMs = selected.execution.timeoutCapMs;
  else delete run.version.sandboxTimeoutCapMs;
}
