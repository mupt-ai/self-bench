#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import {
  taskDefinitionSchema,
  taskDraftDefinitionSchema,
  taskEnvironmentSchema,
} from "../../contracts.js";
import { assertEnvironmentPolicy } from "../../environment.js";

const [draftDefinitionPath, environmentPath, outputDefinition] = process.argv.slice(2);
if (!draftDefinitionPath || !environmentPath || !outputDefinition) {
  throw new Error("usage: sandbox-environment DRAFT.json ENVIRONMENT.json OUTPUT-DEFINITION.json");
}
const [draftBytes, environmentBytes] = await Promise.all([
  readFile(draftDefinitionPath),
  readFile(environmentPath),
]);
const draft = taskDraftDefinitionSchema.parse(JSON.parse(draftBytes.toString("utf8")));
const environment = taskEnvironmentSchema.parse(JSON.parse(environmentBytes.toString("utf8")));
assertEnvironmentPolicy(environment);
const definition = taskDefinitionSchema.parse({ ...draft, environment });
await writeFile(outputDefinition, `${JSON.stringify(definition, null, 2)}\n`);
