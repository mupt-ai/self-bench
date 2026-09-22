import { loadConfig, type SelfBenchConfig } from "../config.js";
import type { RunRequest } from "../contracts.js";
import { managedE2BTemplateReference } from "../setup/e2b/managed.js";
import { generationConfigEnvironment } from "./config.js";
import type { GenerationReference } from "./settings.js";

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
          : undefined) ??
        (settings.sandbox === "managed" ? managedE2BTemplateReference() : undefined),
    ),
  );
  run.version.executionBackend = selected.execution.kind;
  run.version.harborEnvironment = selected.harborEnvironment;
  run.version.sandboxImage = selected.execution.image;
  if ("timeoutCapMs" in selected.execution)
    run.version.sandboxTimeoutCapMs = selected.execution.timeoutCapMs;
  else delete run.version.sandboxTimeoutCapMs;
}
