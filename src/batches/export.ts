import type { ArtifactStore } from "../artifacts.js";
import { loadWorkerConfig } from "../config.js";
import type { EncryptedRecordStore } from "../evaluation/encrypted-records.js";
import { orgRecords } from "../evaluation/org-records.js";
import { createSandboxExecutor } from "../sandbox/index.js";
import { withTaskSandbox } from "../sandbox/task-context.js";
import { ensureManagedE2BTemplate, managedE2BTemplateReference } from "../setup/e2b/managed.js";
import { generationConfigEnvironment } from "../site/generation-config.js";
import { generationEnvironment } from "../site/generation-credentials.js";
import { buildExport } from "../temporal/activities/export.js";
import type { GenerationBatch } from "./types.js";

/** Resolve only this run's provider account; never launch repo tools in the API process. */
export async function exportBatch(
  batch: GenerationBatch,
  artifacts: ArtifactStore,
  records?: EncryptedRecordStore,
) {
  let env = process.env;
  if (batch.run.generation) {
    if (!records) throw Error("Export credentials unavailable");
    env = await generationEnvironment(records, batch.run.runId, batch.run.generation, env);
    env = generationConfigEnvironment(
      batch.run.generation.settings,
      env,
      batch.run.version.sandboxImage,
    );
  }
  const config = loadWorkerConfig(env);
  if (config.execution.kind === "e2b" && config.execution.image === managedE2BTemplateReference()) {
    const generation = batch.run.generation;
    if (!records || !generation?.settings.sandboxCredentialId)
      throw new Error("Managed export template credentials unavailable");
    await ensureManagedE2BTemplate({
      reference: config.execution.image,
      credentials: config.execution.credentials,
      records: orgRecords(records, generation.orgId),
      credentialId: generation.settings.sandboxCredentialId,
    });
  }
  const executor = createSandboxExecutor(config.execution, env);
  try {
    return await withTaskSandbox(executor, () =>
      buildExport(
        artifacts,
        {
          run: batch.run,
          tasks: batch.candidates.flatMap((item) => (item.result?.task ? [item.result.task] : [])),
        },
        `application-${crypto.randomUUID()}`,
      ),
    );
  } finally {
    executor.close();
  }
}
