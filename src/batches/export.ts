import type { ArtifactStore } from "../artifacts.js";
import { loadWorkerConfig } from "../config.js";
import type { EncryptedRecordStore } from "../evaluation/encrypted-records.js";
import { createSandboxExecutor } from "../sandbox/index.js";
import { withTaskSandbox } from "../sandbox/task-context.js";
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
