import { ApplicationFailure } from "@temporalio/common";
import { loadWorkerConfig, type SelfBenchWorkerConfig } from "../../config.js";
import type { RunRequest } from "../../contracts.js";
import type { EncryptedRecordStore } from "../../evaluation/encrypted-records.js";
import { withExecutionEnvironment } from "../../execution-environment.js";
import { createSandboxExecutor, type SandboxExecutor } from "../../sandbox/index.js";
import { generationEnvironment } from "../../site/generation-credentials.js";
import { generationConfigEnvironment } from "../../site/generation-config.js";

export async function withGenerationRuntime<T>(
  config: SelfBenchWorkerConfig,
  records: EncryptedRecordStore | undefined,
  run: RunRequest,
  stage: "author" | "verifier",
  legacySandbox: SandboxExecutor,
  action: (
    sandbox: SandboxExecutor,
    environment: SelfBenchWorkerConfig["harborEnvironment"],
    configuredRun: RunRequest,
  ) => Promise<T>,
) {
  if (!run.generation) return action(legacySandbox, config.harborEnvironment, run);
  let env: NodeJS.ProcessEnv;
  try {
    if (!records) throw new Error("Generation credentials are not configured on this worker.");
    env = await generationEnvironment(records, run.runId, run.generation, process.env);
  } catch (error) {
    throw ApplicationFailure.nonRetryable(
      error instanceof Error ? error.message : "Generation credentials unavailable",
      "GenerationConfiguration",
    );
  }
  const settings = run.generation.settings;
  let selected: SelfBenchWorkerConfig;
  try {
    if (run.version.executionBackend !== settings.sandbox ||
        (settings.sandboxImage && settings.sandboxImage !== run.version.sandboxImage))
      throw new Error("Generation runtime does not match its saved configuration.");
    selected = loadWorkerConfig(generationConfigEnvironment(settings, env, run.version.sandboxImage));
    if (selected.harborEnvironment !== run.version.harborEnvironment)
      throw new Error("Harbor verification does not match its saved configuration.");
  } catch (error) {
    throw ApplicationFailure.nonRetryable(
      error instanceof Error ? error.message : "Generation runtime unavailable",
      "GenerationConfiguration",
    );
  }
  const execution = "timeoutCapMs" in selected.execution
    ? { ...selected.execution, timeoutCapMs: Math.min(selected.execution.timeoutCapMs, run.version.sandboxTimeoutCapMs ?? selected.execution.timeoutCapMs) }
    : selected.execution;
  const configuredRun = {
    ...run,
    authoring: {
      ...run.authoring,
      model: stage === "verifier" ? settings.verifierModel : settings.authorModel,
      reasoningEffort: settings.reasoning,
    },
  };
  return withExecutionEnvironment(env, async () => {
    const sandbox = createSandboxExecutor(execution, env);
    try {
      return await action(sandbox, selected.harborEnvironment, configuredRun);
    } finally {
      sandbox.close();
    }
  });
}
