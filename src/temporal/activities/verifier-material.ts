import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractRegularArchive, REPOSITORY_SNAPSHOT_ARCHIVE_OPTIONS } from "../../archive.js";
import type { ArtifactStore } from "../../artifacts.js";
import { type AuthoredTask, type TaskDefinition, taskDefinitionSchema } from "../../contracts.js";
import {
  buildCouplingEvidence,
  type CouplingEvidence,
  discoverContractArtifacts,
  scanBaseContractArtifacts,
} from "../../coupling.js";
import { patchPaths } from "../../repair.js";
import { withTaskBundle } from "./runtime.js";

export interface VerifierMaterial {
  readonly definition: TaskDefinition;
  readonly instruction: string;
  readonly testPatch: string;
  readonly goldPatch: string;
  readonly couplingEvidence: CouplingEvidence;
  readonly heldOutPaths: readonly string[];
}

/**
 * Everything the verification agent judges, gathered from the green bundle on the worker: the
 * instruction, both patches, the environment contract, and the deterministic coupling evidence
 * computed against the exact base snapshot.
 */
export async function buildVerifierMaterial(
  store: ArtifactStore,
  task: AuthoredTask,
): Promise<VerifierMaterial> {
  return await withTaskBundle(store, task, async (taskDirectory, root) => {
    const [definitionBytes, instruction, testPatch, goldPatch] = await Promise.all([
      store.get(task.definition),
      readFile(join(taskDirectory, "instruction.md"), "utf8"),
      readFile(join(taskDirectory, "tests/test.patch"), "utf8"),
      readFile(join(taskDirectory, "solution/gold.patch"), "utf8"),
    ]);
    const definition = taskDefinitionSchema.parse(
      JSON.parse(Buffer.from(definitionBytes).toString("utf8")),
    );
    const baseDirectory = join(root, "verifier-base");
    await mkdir(baseDirectory);
    await extractRegularArchive(
      join(taskDirectory, "environment/repo.tar.gz"),
      baseDirectory,
      REPOSITORY_SNAPSHOT_ARCHIVE_OPTIONS,
    );
    const candidates = discoverContractArtifacts(testPatch);
    const baseArtifacts = await scanBaseContractArtifacts(baseDirectory, root, candidates);
    const couplingEvidence = buildCouplingEvidence({
      prompt: definition.prompt,
      testPatch,
      goldPatch,
      baseArtifacts,
    });
    return {
      definition,
      instruction,
      testPatch,
      goldPatch,
      couplingEvidence,
      heldOutPaths: patchPaths(testPatch),
    };
  });
}
