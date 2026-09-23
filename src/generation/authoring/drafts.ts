import type { ArtifactStore } from "../../artifacts/index.js";
import type { AuthoredTaskDraft } from "../../contracts/index.js";
import { taskOperation } from "../../sandbox/task-operation.js";

/**
 * Stores a submission (definition.json, test.patch, gold.patch) as the definition artifact plus
 * the source bundle the trusted compiler consumes.
 */
export async function materializeDraft(
  store: ArtifactStore,
  prefix: string,
  candidateId: string,
  definitionJson: string,
  testPatch: string,
  goldPatch: string,
  signal?: AbortSignal,
): Promise<AuthoredTaskDraft> {
  const definitionBytes = Buffer.from(
    definitionJson.endsWith("\n") ? definitionJson : `${definitionJson}\n`,
  );
  const outputs = await taskOperation(
    "draft",
    [
      { path: "/work/definition.json", contents: definitionBytes },
      { path: "/work/test.patch", contents: testPatch },
      { path: "/work/gold.patch", contents: goldPatch },
    ],
    ["/work/source-task.tar.gz"],
    signal,
  );
  const sourceBundle = outputs["/work/source-task.tar.gz"];
  if (!sourceBundle) throw new Error("Draft sandbox returned no archive");
  const [definitionRef, bundleRef] = await Promise.all([
    store.put(`${prefix}/definition.json`, definitionBytes, "application/json"),
    store.put(`${prefix}/source-task.tar.gz`, sourceBundle, "application/gzip"),
  ]);
  const taskId = (JSON.parse(definitionJson) as { taskId?: unknown }).taskId;
  return {
    candidateId,
    taskId: typeof taskId === "string" && taskId ? taskId : candidateId,
    definition: definitionRef,
    sourceBundle: bundleRef,
  };
}
