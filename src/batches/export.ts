import type { ArtifactStore } from "../artifacts/index.js";
import { loadWorkerConfig } from "../config/index.js";
import type { EncryptedRecordStore } from "../evaluation/encrypted-records.js";
import { orgRecords } from "../evaluation/org-records.js";
import { generationConfigEnvironment } from "../generation/config.js";
import { generationEnvironment } from "../generation/credentials.js";
import { buildExport } from "../generation/export.js";
import { MANAGED_E2B_TEMPLATE_OWNER } from "../managed/generation.js";
import { meteredSandboxExecutor } from "../managed/metered-sandbox.js";
import { withUsageLedger } from "../managed/usage.js";
import type { UsageLedger } from "../managed/usage-store.js";
import { createSandboxExecutor } from "../sandbox/index.js";
import {
  ensureManagedE2BTemplate,
  managedE2BTemplateReference,
} from "../sandbox/providers/e2b/managed-template.js";
import { withTaskSandbox } from "../sandbox/task-context.js";
import type { GenerationBatch } from "./types.js";

/** Resolve only this run's provider account; never launch repo tools in the API process. */
export async function exportBatch(
  batch: GenerationBatch,
  artifacts: ArtifactStore,
  records?: EncryptedRecordStore,
  usage?: UsageLedger,
) {
  const generation = batch.run.generation;
  let env = process.env;
  if (generation) {
    if (!records) throw Error("Export credentials unavailable");
    env = await generationEnvironment(records, batch.run.runId, generation, env);
    env = generationConfigEnvironment(generation.settings, env, batch.run.version.sandboxImage);
  }
  const config = loadWorkerConfig(env);
  if (config.execution.kind === "e2b" && config.execution.image === managedE2BTemplateReference()) {
    const managed = generation?.settings.sandbox === "managed";
    const credentialId = managed
      ? MANAGED_E2B_TEMPLATE_OWNER
      : generation?.settings.sandboxCredentialId;
    if (!records || !generation || !credentialId)
      throw new Error("Managed export template credentials unavailable");
    await ensureManagedE2BTemplate({
      reference: config.execution.image,
      credentials: config.execution.credentials,
      records: managed ? records : orgRecords(records, generation.orgId),
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
