import type { ArtifactStore } from "../../artifacts/index.js";
import { loadWorkerConfig } from "../../contracts/config/index.js";
import { orgRecords } from "../../db/encrypted-records.js";
import type { UsageLedger } from "../../db/usage.js";
import type { Vault } from "../../db/vault.js";
import { createSandboxExecutor } from "../../sandbox/index.js";
import {
  ensureManagedE2BTemplate,
  managedE2BTemplateReference,
} from "../../sandbox/providers/e2b/managed-template.js";
import { withTaskSandbox } from "../../sandbox/task-context.js";
import { MANAGED_E2B_TEMPLATE_OWNER } from "../billing/managed.js";
import { meteredSandboxExecutor } from "../billing/metered-sandbox.js";
import { withUsageLedger } from "../billing/usage.js";
import { buildExport } from "../pipeline/export.js";
import { credentialOrg, generationEnvironment } from "../settings/credentials.js";
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
    env = await generationEnvironment(vault, batch.run.runId, generation, env);
    env = generationConfigEnvironment(generation.settings, env, batch.run.version.sandboxImage);
  }
  const config = loadWorkerConfig(env);
  if (config.execution.kind === "e2b" && config.execution.image === managedE2BTemplateReference()) {
    const managed = generation?.settings.sandbox === "managed";
    const credentialId = managed
      ? MANAGED_E2B_TEMPLATE_OWNER
      : generation?.settings.sandboxCredentialId;
    if (!vault || !generation || !credentialId)
      throw new Error("Managed export template credentials unavailable");
    await ensureManagedE2BTemplate({
      reference: config.execution.image,
      credentials: config.execution.credentials,
      records: managed ? vault.records : orgRecords(vault.records, credentialOrg(generation)),
      credentialId,
    });
  }
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
