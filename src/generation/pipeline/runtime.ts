import { Context } from "@temporalio/activity";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { withExecutionEnvironment } from "../../contracts/config/execution-environment.js";
import { loadWorkerConfig, type SelfBenchWorkerConfig } from "../../contracts/config/index.js";
import type { RunRequest } from "../../contracts/index.js";
import { orgRecords } from "../../db/encrypted-records.js";
import type { UsageLedger } from "../../db/usage.js";
import type { Vault } from "../../db/vault.js";
import { withCredentialCapacity } from "../../sandbox/capacity-wait.js";
import { capacityLimitedSandbox, credentialCapacity } from "../../sandbox/credential-capacity.js";
import { createSandboxExecutor, type SandboxExecutor } from "../../sandbox/index.js";
import { prepareSandboxRuntime } from "../../sandbox/runtime-image.js";
import { stampedManagedHarbor } from "../billing/managed.js";
import { meteredSandboxExecutor } from "../billing/metered-sandbox.js";
import { withUsageLedger } from "../billing/usage.js";
import {
  generationEnvironment,
  generationRuntimeOwner,
  stageAuthoring,
} from "../settings/credentials.js";
import { generationConfigEnvironment } from "../settings/run.js";
import { generationExecutionBackend } from "../settings/settings.js";
import { safeHeartbeat } from "./helpers.js";

export async function withGenerationRuntime<T>(
  config: SelfBenchWorkerConfig,
  vault: Vault | undefined,
  run: RunRequest,
  stage: "author" | "verifier",
  legacySandbox: SandboxExecutor,
  action: (
    sandbox: SandboxExecutor,
    environment: SelfBenchWorkerConfig["harborEnvironment"],
    configuredRun: RunRequest,
  ) => Promise<T>,
  usage?: UsageLedger,
  harborWork = false,
) {
  if (!run.generation) return action(legacySandbox, config.harborEnvironment, run);
  let env: NodeJS.ProcessEnv;
  try {
    if (!vault) throw new Error("Generation credentials are not configured on this worker.");
    env = await generationEnvironment(
      vault,
      run.runId,
      run.generation,
      process.env,
      stampedManagedHarbor(run.version.harborEnvironment),
    );
  } catch (error) {
    throw ApplicationFailure.nonRetryable(
      error instanceof Error ? error.message : "Generation credentials unavailable",
      "GenerationConfiguration",
    );
  }
  const settings = run.generation.settings;
  let authoring: Awaited<ReturnType<typeof stageAuthoring>>;
  try {
    authoring = await stageAuthoring(vault.credentials, run.generation, stage);
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
      generationConfigEnvironment(
        settings,
        env,
        run.version.sandboxImage,
        stampedManagedHarbor(run.version.harborEnvironment),
      ),
    );
    if (selected.harborEnvironment !== run.version.harborEnvironment)
      throw new Error("Harbor verification does not match its saved configuration.");
  } catch (error) {
    throw ApplicationFailure.nonRetryable(
      error instanceof Error ? error.message : "Generation runtime unavailable",
      "GenerationConfiguration",
    );
  }
  // A run stamped with the managed E2B template must find it in the run's account before the
  // first sandbox request; build it there if absent.
  const generation = run.generation;
  try {
    await prepareSandboxRuntime(selected.execution, () => ({
      ...generationRuntimeOwner(generation, vault.records),
      onLog: safeHeartbeat,
      signal: Context.current().cancellationSignal,
    }));
  } catch (error) {
    // Cancellation must propagate as cancellation, not a non-retryable configuration failure.
    if (Context.current().cancellationSignal.aborted)
      throw new CancelledFailure("activity cancellation requested");
    throw ApplicationFailure.nonRetryable(
      error instanceof Error ? error.message : "Managed E2B template unavailable",
      "GenerationConfiguration",
    );
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
      ...(authoring.piModels ? { piModels: authoring.piModels } : {}),
    },
  };
  const orgId = generation.orgId ?? generation.ownerId;
  const capacityFor = async (id: string | undefined) => {
    if (!id) return undefined;
    const credential = await vault.credentials.find(orgId, id);
    return credential
      ? credentialCapacity(
          orgRecords(vault.records, orgId),
          id,
          credential.maxSandboxes ?? Number.POSITIVE_INFINITY,
        )
      : undefined;
  };
  const capacity = await capacityFor(settings.sandboxCredentialId);
  const sandbox = createSandboxExecutor(execution, env);
  const metered = meteredSandboxExecutor(
    capacity ? capacityLimitedSandbox(sandbox, capacity) : sandbox,
    {
      managedModel: settings.modelAccess === "managed",
      managedSandbox: settings.sandbox === "managed",
      model: stage === "verifier" ? settings.verifierModel : settings.authorModel,
      ...(authoring.rates ? { rates: authoring.rates } : {}),
      sandboxProvider: selected.execution.kind,
      provider: authoring.provider,
    },
  );
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
          if (!harborWork) return await action(metered, selected.harborEnvironment, configuredRun);
          const harborCapacity = await capacityFor(settings.harborCredentialId);
          if (!harborCapacity)
            return await action(metered, selected.harborEnvironment, configuredRun);
          // Harbor creates its own sandboxes outside the JS executor. Hold one shared slot for
          // the entire check (nop and oracle run sequentially), including build and teardown.
          return await withCredentialCapacity(harborCapacity, 72 * 60 * 60_000, () =>
            action(metered, selected.harborEnvironment, configuredRun),
          );
        } finally {
          metered.close();
        }
      },
    ),
  );
}
