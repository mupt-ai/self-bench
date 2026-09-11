import { loadConfig, type SelfBenchConfig } from "../config.js";
import type { RunRequest } from "../contracts.js";
import { generationConfigEnvironment } from "./generation-config.js";
import type { GenerationReference } from "./generation-settings.js";

/** Shared configuration for single-PR and discovered batch candidates. */
export function configureGenerationRun(
  run: RunRequest,
  generation: GenerationReference,
  config: SelfBenchConfig,
) {
  run.generation = generation;
  run.authoring = {
    provider: "openai",
    model: generation.settings.authorModel,
    reasoningEffort: generation.settings.reasoning,
  };
  const settings = generation.settings;
  const selected = loadConfig(
    generationConfigEnvironment(
      settings,
      process.env,
      settings.sandboxImage ??
        (settings.sandbox === config.execution.kind ? config.execution.image : undefined),
    ),
  );
  run.version.executionBackend = selected.execution.kind;
  run.version.harborEnvironment = selected.harborEnvironment;
  run.version.sandboxImage = selected.execution.image;
  if ("timeoutCapMs" in selected.execution)
    run.version.sandboxTimeoutCapMs = selected.execution.timeoutCapMs;
  else delete run.version.sandboxTimeoutCapMs;
}
