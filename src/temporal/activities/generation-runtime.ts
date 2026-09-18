import { Context } from "@temporalio/activity";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { loadWorkerConfig, type SelfBenchWorkerConfig } from "../../config.js";
import type { RunRequest } from "../../contracts.js";
import type { EncryptedRecordStore } from "../../evaluation/encrypted-records.js";
import { orgRecords } from "../../evaluation/org-records.js";
import { withExecutionEnvironment } from "../../execution-environment.js";
import { createSandboxExecutor, type SandboxExecutor } from "../../sandbox/index.js";
import { withTaskSandbox } from "../../sandbox/task-context.js";
import { ensureManagedE2BTemplate, managedE2BTemplateReference } from "../../setup/e2b/managed.js";
import { generationConfigEnvironment } from "../../site/generation-config.js";
import { generationEnvironment } from "../../site/generation-credentials.js";
import { safeHeartbeat } from "./runtime.js";

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
  if (!run.generation)
    return withTaskSandbox(legacySandbox, () =>
      action(legacySandbox, config.harborEnvironment, run),
    );
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
    if (
      run.version.executionBackend !== settings.sandbox ||
      (settings.sandboxImage && settings.sandboxImage !== run.version.sandboxImage)
    )
      throw new Error("Generation runtime does not match its saved configuration.");
    selected = loadWorkerConfig(
      generationConfigEnvironment(settings, env, run.version.sandboxImage),
    );
    if (selected.harborEnvironment !== run.version.harborEnvironment)
      throw new Error("Harbor verification does not match its saved configuration.");
  } catch (error) {
    throw ApplicationFailure.nonRetryable(
      error instanceof Error ? error.message : "Generation runtime unavailable",
      "GenerationConfiguration",
    );
  }
  // A managed E2B run stamped by the API must use this build's template; build it in the
  // user's account before the first sandbox request if the account does not have it yet.
  if (
    selected.execution.kind === "e2b" &&
    selected.execution.image === managedE2BTemplateReference() &&
    run.version.sandboxImage === selected.execution.image
  ) {
    const credentialId = settings.sandboxCredentialId;
    if (!credentialId || !records)
      throw ApplicationFailure.nonRetryable(
        "Managed E2B template build is not configured on this worker.",
        "GenerationConfiguration",
      );
    try {
      await ensureManagedE2BTemplate({
        reference: selected.execution.image,
        credentials: selected.execution.credentials,
        records: orgRecords(records, run.generation.orgId),
        credentialId,
        onLog: safeHeartbeat,
        signal: Context.current().cancellationSignal,
      });
    } catch (error) {
      // Cancellation must propagate as cancellation, not a non-retryable configuration failure.
      if (Context.current().cancellationSignal.aborted)
        throw new CancelledFailure("activity cancellation requested");
      throw ApplicationFailure.nonRetryable(
        error instanceof Error ? error.message : "Managed E2B template unavailable",
        "GenerationConfiguration",
      );
    }
  }
  const execution =
    "timeoutCapMs" in selected.execution
      ? {
          ...selected.execution,
          timeoutCapMs: Math.min(
            selected.execution.timeoutCapMs,
            run.version.sandboxTimeoutCapMs ?? selected.execution.timeoutCapMs,
          ),
        }
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
      return await withTaskSandbox(sandbox, () =>
        action(sandbox, selected.harborEnvironment, configuredRun),
      );
    } finally {
      sandbox.close();
    }
  });
}
