import type { ArtifactStore } from "../../artifacts/index.js";
import { loadWorkerConfig } from "../../contracts/config/index.js";
import type { UsageLedger } from "../../db/usage.js";
import type { Vault } from "../../db/vault.js";
import { createSandboxExecutor } from "../../sandbox/index.js";
import { prepareSandboxRuntime } from "../../sandbox/runtime-image.js";
import { withTaskSandbox } from "../../sandbox/task-context.js";
import { stampedManagedHarbor } from "../billing/managed.js";
import { meteredSandboxExecutor } from "../billing/metered-sandbox.js";
import { withUsageLedger } from "../billing/usage.js";
import { buildExport } from "../pipeline/export.js";
import { generationEnvironment, generationRuntimeOwner } from "../settings/credentials.js";
import { generationConfigEnvironment } from "../settings/run.js";
import type { GenerationBatch } from "./types.js";

/** Resolve only this run's provider account; never launch repo tools in the API process. */
export async function exportBatch(
  batch: GenerationBatch,
  artifacts: ArtifactStore,
  vault?: Vault,
  usage?: UsageLedger,
) {
  const generation = batch.run.generation;
  let env = process.env;
  if (generation) {
    if (!vault) throw Error("Export credentials unavailable");
    const managedHarbor = stampedManagedHarbor(batch.run.version.harborEnvironment);
    env = await generationEnvironment(vault, batch.run.runId, generation, env, managedHarbor);
    env = generationConfigEnvironment(
      generation.settings,
      env,
      batch.run.version.sandboxImage,
      managedHarbor,
    );
  }
  const config = loadWorkerConfig(env);
  await prepareSandboxRuntime(config.execution, () => {
    if (!vault || !generation) throw new Error("Managed export template credentials unavailable");
    return generationRuntimeOwner(generation, vault.records);
  });
  const inner = createSandboxExecutor(config.execution, env);
  const executor =
    generation && usage
      ? meteredSandboxExecutor(inner, {
          managedModel: generation.settings.modelAccess === "managed",
          managedSandbox: generation.settings.sandbox === "managed",
          model: generation.settings.authorModel,
          sandboxProvider: batch.run.version.executionBackend,
        })
      : inner;
  try {
    const runExport = () =>
      withTaskSandbox(executor, () =>
        buildExport(
          artifacts,
          {
            run: batch.run,
            tasks: batch.candidates.flatMap((item) =>
              item.result?.task ? [item.result.task] : [],
            ),
          },
          `application-${crypto.randomUUID()}`,
        ),
      );
    if (!generation || !usage) return await runExport();
    return await withUsageLedger(
      async (entry) =>
        usage.record({
          ...entry,
          runId: batch.run.runId,
          orgId: generation.orgId ?? generation.ownerId,
        }),
      runExport,
    );
  } finally {
    executor.close();
  }
}
