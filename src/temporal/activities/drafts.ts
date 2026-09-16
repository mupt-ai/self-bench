import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../../artifacts.js";
import type { AuthoredTaskDraft } from "../../contracts.js";
import { runCommand } from "../../process.js";
import { withTemporaryDirectory } from "./runtime.js";

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
): Promise<AuthoredTaskDraft> {
  const definitionBytes = Buffer.from(
    definitionJson.endsWith("\n") ? definitionJson : `${definitionJson}\n`,
  );
  const sourceBundle = await withTemporaryDirectory("selfbench-draft-", async (root) => {
    const authored = join(root, "authored");
    await mkdir(authored);
    await Promise.all([
      writeFile(join(authored, "definition.json"), definitionBytes),
      writeFile(join(authored, "test.patch"), testPatch),
      writeFile(join(authored, "gold.patch"), goldPatch),
    ]);
    const archive = join(root, "source-task.tar.gz");
    await runCommand("tar", ["-czf", archive, "-C", authored, "."]);
    return await readFile(archive);
  });
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
