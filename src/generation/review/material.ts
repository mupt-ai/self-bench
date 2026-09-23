import type { ArtifactStore } from "../../artifacts/index.js";
import type { AuthoredTask, TaskDefinition } from "../../contracts/index.js";
import { taskOperation } from "../../sandbox/task-operation.js";
import type { CouplingEvidence } from "../checks/coupling.js";
export interface ReviewMaterial {
  readonly definition: TaskDefinition;
  readonly instruction: string;
  readonly testPatch: string;
  readonly goldPatch: string;
  readonly couplingEvidence: CouplingEvidence;
  readonly heldOutPaths: readonly string[];
}

/** Repository hydration and coupling scans run in a fresh preparation sandbox. */
export async function buildReviewMaterial(
  store: ArtifactStore,
  task: AuthoredTask,
  signal?: AbortSignal,
): Promise<ReviewMaterial> {
  const files = await taskOperation(
    "material",
    [
      { path: "/work/task.tar.gz", contents: await store.get(task.bundle) },
      { path: "/work/definition.json", contents: await store.get(task.definition) },
    ],
    ["/work/material.json"],
    signal,
  );
  const bytes = files["/work/material.json"];
  if (!bytes) throw new Error("Sandbox returned no verifier material");
  return JSON.parse(Buffer.from(bytes).toString()) as ReviewMaterial;
}
