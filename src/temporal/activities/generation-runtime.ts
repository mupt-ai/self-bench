import { ApplicationFailure } from "@temporalio/common";
import { loadConfig, type SelfBenchWorkerConfig } from "../../config.js";
import type { RunRequest } from "../../contracts.js";
import type { EncryptedRecordStore } from "../../evaluation/encrypted-records.js";
import { withExecutionEnvironment } from "../../execution-environment.js";
import { createSandboxExecutor, type SandboxExecutor } from "../../sandbox/index.js";
import { generationEnvironment } from "../../site/generation-credentials.js";

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
  const selected = loadConfig({
    ...env,
    SELFBENCH_EXECUTION_BACKEND: settings.sandbox,
    SELFBENCH_HARBOR_ENVIRONMENT: settings.sandbox,
  });
  const execution = selected.execution;
  if (execution.kind !== "docker" && execution.kind !== "modal")
    throw new Error("Unsupported generation sandbox");
  const configuredRun = {
    ...run,
    authoring: {
      ...run.authoring,
      model: stage === "verifier" ? settings.verifierModel : settings.authorModel,
      reasoningEffort: settings.reasoning,
    },
  };
  return withExecutionEnvironment(env, () =>
    action(
      createSandboxExecutor({ ...execution, image: run.version.sandboxImage }, env),
      selected.harborEnvironment,
      configuredRun,
    ),
  );
}
