import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractRegularArchive, REPOSITORY_SNAPSHOT_ARCHIVE_OPTIONS } from "../archive.js";
import { taskDefinitionSchema } from "../contracts.js";
import {
  buildCouplingEvidence,
  discoverContractArtifacts,
  scanBaseContractArtifacts,
} from "../coupling.js";
import { repositoryRelativePath } from "../harbor-task/paths.js";
import { patchPaths } from "../repair.js";
export async function verifierMaterial(root: string): Promise<void> {
  await extractRegularArchive("/work/task.tar.gz", root);
  const taskDirectory = join(root, "harbor-task");
  const [definitionBytes, instruction, testPatch, goldPatch] = await Promise.all([
    readFile("/work/definition.json"),
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
  const material = {
    definition,
    instruction,
    testPatch,
    goldPatch,
    couplingEvidence,
    heldOutPaths: [
      ...new Set([
        ...patchPaths(testPatch),
        ...definition.testPaths.map((path) => repositoryRelativePath(definition, path)),
      ]),
    ],
  };

  await writeFile("/work/material.json", JSON.stringify(material));
}
