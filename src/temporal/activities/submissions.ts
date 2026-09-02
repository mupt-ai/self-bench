import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractRegularArchive } from "../../archive.js";
import { readTaskPatches, withTemporaryDirectory } from "./runtime.js";

export interface SubmissionFiles {
  readonly taskId: string | undefined;
  readonly definition: unknown;
  readonly testPatch: string;
  readonly goldPatch: string;
}

/** Parses a sandbox submission (definition.json bytes + source bundle); undefined when unreadable. */
export async function readSubmission(
  definitionBytes: Uint8Array,
  sourceBundle: Uint8Array,
): Promise<SubmissionFiles | undefined> {
  try {
    const definition = JSON.parse(Buffer.from(definitionBytes).toString("utf8")) as unknown;
    const patches = await withTemporaryDirectory("selfbench-submission-", async (root) => {
      const archive = join(root, "source-task.tar.gz");
      const authored = join(root, "authored");
      await mkdir(authored);
      await writeFile(archive, sourceBundle);
      await extractRegularArchive(archive, authored);
      return await readTaskPatches(authored);
    });
    const taskId = (definition as { taskId?: unknown } | null)?.taskId;
    return {
      taskId: typeof taskId === "string" && taskId ? taskId : undefined,
      definition,
      ...patches,
    };
  } catch {
    return undefined;
  }
}
