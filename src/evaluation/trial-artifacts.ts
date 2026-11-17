import type { ArtifactStore } from "../artifacts/index.js";
import type { EvaluationScope } from "./scope.js";
import { evaluationPrefix } from "./store.js";
import type { EvaluationRun } from "./types.js";

/** Stores a trial's clean output files as its artifacts, returning their names. */
export async function saveTrialArtifacts(
  store: ArtifactStore,
  run: EvaluationRun & EvaluationScope,
  index: number,
  clean: Map<string, string>,
): Promise<string[]> {
  const names: string[] = [];
  for (const [name, text] of clean) {
    const artifactName = `${index}/${name}`;
    await store.put(
      `${evaluationPrefix(run, run.id)}artifacts/${artifactName}`,
      Buffer.from(text),
      "text/plain",
    );
    names.push(artifactName);
  }
  return names;
}
