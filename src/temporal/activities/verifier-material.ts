import type { ArtifactStore } from "../../artifacts.js";
import type { AuthoredTask, TaskDefinition } from "../../contracts.js";
import type { CouplingEvidence } from "../../coupling.js";
import { taskOperation } from "../../sandbox/task-operation.js";
export interface VerifierMaterial {
  readonly definition: TaskDefinition;
  readonly instruction: string;
  readonly testPatch: string;
  readonly goldPatch: string;
  readonly couplingEvidence: CouplingEvidence;
  readonly heldOutPaths: readonly string[];
}

/** Repository hydration and coupling scans run in a fresh preparation sandbox. */
export async function buildVerifierMaterial(
  store: ArtifactStore,
  task: AuthoredTask,
  signal?: AbortSignal,
): Promise<VerifierMaterial> {
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
  return JSON.parse(Buffer.from(bytes).toString()) as VerifierMaterial;
}
