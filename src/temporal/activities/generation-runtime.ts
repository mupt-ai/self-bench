import { Context } from "@temporalio/activity";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { loadWorkerConfig, type SelfBenchWorkerConfig } from "../../config.js";
import type { RunRequest } from "../../contracts.js";
import type { EncryptedRecordStore } from "../../evaluation/encrypted-records.js";
import { orgRecords } from "../../evaluation/org-records.js";
import { withExecutionEnvironment } from "../../execution-environment.js";
import { meteredSandboxExecutor } from "../../managed/metered-sandbox.js";
import { withUsageLedger } from "../../managed/usage.js";
import type { UsageLedger } from "../../managed/usage-store.js";
import { createSandboxExecutor, type SandboxExecutor } from "../../sandbox/index.js";
import { withTaskSandbox } from "../../sandbox/task-context.js";
import { ensureManagedE2BTemplate, managedE2BTemplateReference } from "../../setup/e2b/managed.js";
import { generationConfigEnvironment } from "../../site/generation-config.js";
import { generationStageEnvironment, stageAuthoring } from "../../site/generation-credentials.js";
import { generationExecutionBackend } from "../../site/generation-settings.js";
import { MANAGED_E2B_TEMPLATE_OWNER } from "../../site/managed-generation.js";
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
  usage?: UsageLedger,
) {
  if (!run.generation)
    return withTaskSandbox(legacySandbox, () =>
      action(legacySandbox, config.harborEnvironment, run),
    );
  let env: NodeJS.ProcessEnv;
  try {
    if (!records) throw new Error("Generation credentials are not configured on this worker.");
    env = await generationStageEnvironment(records, run.runId, run.generation, process.env);
  } catch (error) {
    throw ApplicationFailure.nonRetryable(
      error instanceof Error ? error.message : "Generation credentials unavailable",
      "GenerationConfiguration",
    );
  }
  const settings = run.generation.settings;
  const scoped = run.generation.orgId ? orgRecords(records, run.generation.orgId) : records;
  let authoring: { provider: string; model: string; reasoningEffort: string };
  try {
    authoring = await stageAuthoring(scoped, run.generation, stage);
  } catch (error) {
    throw ApplicationFailure.nonRetryable(
      error instanceof Error ? error.message : "Generation credentials unavailable",
      "GenerationConfiguration",
    );
  }
  let selected: SelfBenchWorkerConfig;
  try {
    if (
      run.version.executionBackend !== generationExecutionBackend(settings.sandbox) ||
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
  // run's E2B account — the platform's own for managed sandboxes — before the first
  // sandbox request if the account does not have it yet.
  if (
    selected.execution.kind === "e2b" &&
    selected.execution.image === managedE2BTemplateReference() &&
    run.version.sandboxImage === selected.execution.image
  ) {
    const managed = settings.sandbox === "managed";
    const credentialId = managed ? MANAGED_E2B_TEMPLATE_OWNER : settings.sandboxCredentialId;
    if (!credentialId || !records)
      throw ApplicationFailure.nonRetryable(
        "Managed E2B template build is not configured on this worker.",
        "GenerationConfiguration",
      );
    try {
      await ensureManagedE2BTemplate({
        reference: selected.execution.image,
        credentials: selected.execution.credentials,
        // A platform template is shared across organizations, so its build lock is global.
        records: managed ? records : orgRecords(records, run.generation.orgId),
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
      provider: authoring.provider as RunRequest["authoring"]["provider"],
      model: authoring.model,
      reasoningEffort: authoring.reasoningEffort as RunRequest["authoring"]["reasoningEffort"],
    },
  };
  const generation = run.generation;
  const metered = meteredSandboxExecutor(createSandboxExecutor(execution, env), {
    managedModel: settings.modelAccess === "managed",
    managedSandbox: settings.sandbox === "managed",
    model: stage === "verifier" ? settings.verifierModel : settings.authorModel,
    sandboxProvider: selected.execution.kind,
    provider: authoring.provider,
  });
  return withExecutionEnvironment(env, async () =>
    withUsageLedger(
      async (entry) =>
        usage?.record({
          ...entry,
          runId: run.runId,
          orgId: generation.orgId ?? generation.ownerId,
        }),
      async () => {
        try {
          return await withTaskSandbox(metered, () =>
            action(metered, selected.harborEnvironment, configuredRun),
          );
        } finally {
          metered.close();
        }
      },
    ),
  );
}
