#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  taskDefinitionSchema,
  taskDraftDefinitionSchema,
  taskEnvironmentSchema,
} from "../../contracts.js";
import { assertEnvironmentEvidence, assertEnvironmentPolicy } from "../../environment.js";
import { compileHarborTask } from "../../harbor-task.js";
import { runCommand } from "../../process.js";

const [
  sourceArchive,
  draftDefinitionPath,
  environmentPath,
  repository,
  outputArchive,
  outputDefinition,
] = process.argv.slice(2);
if (
  !sourceArchive ||
  !draftDefinitionPath ||
  !environmentPath ||
  !repository ||
  !outputArchive ||
  !outputDefinition
) {
  throw new Error(
    "usage: sandbox-environment SOURCE.tar.gz DRAFT.json ENVIRONMENT.json REPOSITORY OUTPUT.tar.gz OUTPUT-DEFINITION.json",
  );
}

const root = await mkdtemp(join(tmpdir(), "selfbench-environment-"));
const source = join(root, "source");
const output = join(root, "harbor-task");
await mkdir(source, { recursive: true });
await runCommand("tar", ["-xzf", sourceArchive, "-C", source]);
const [draftBytes, environmentBytes] = await Promise.all([
  readFile(draftDefinitionPath),
  readFile(environmentPath),
]);
const draft = taskDraftDefinitionSchema.parse(JSON.parse(draftBytes.toString("utf8")));
const environment = taskEnvironmentSchema.parse(JSON.parse(environmentBytes.toString("utf8")));
assertEnvironmentPolicy(environment);
const repositoryFiles = await runCommand("git", ["-C", repository, "ls-files", "-z"]);
assertEnvironmentEvidence(environment, new Set(repositoryFiles.stdout.split("\0").filter(Boolean)));
const definition = taskDefinitionSchema.parse({ ...draft, environment });
await writeFile(join(source, "definition.json"), `${JSON.stringify(definition, null, 2)}\n`);
await compileHarborTask(source, repository, output);
await runCommand("tar", ["-czf", outputArchive, "-C", root, "harbor-task"]);
await writeFile(outputDefinition, `${JSON.stringify(definition, null, 2)}\n`);
