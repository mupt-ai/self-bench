#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "../../process.js";

const [tasksRoot, outputArchive, outputDefinition] = process.argv.slice(2);
if (!tasksRoot || !outputArchive || !outputDefinition) {
  throw new Error("usage: sandbox-author TASKS_ROOT OUTPUT.tar.gz OUTPUT-DEFINITION.json");
}

// The worker's trusted compiler validates the definition, environment policy, and patches; every
// failure there becomes a round report the author can act on. This program only packages the
// single submission and confirms it is well-formed JSON with a task ID.
const entries = await readdir(tasksRoot, { withFileTypes: true });
const taskDirectories = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(tasksRoot, entry.name));
if (taskDirectories.length !== 1) {
  throw new Error(`authoring must produce exactly one task; found ${taskDirectories.length}`);
}
const taskDirectory = taskDirectories[0] as string;
const definitionBytes = await readFile(join(taskDirectory, "definition.json"));
const definition = JSON.parse(definitionBytes.toString("utf8")) as { taskId?: unknown };
if (typeof definition.taskId !== "string" || definition.taskId.length === 0) {
  throw new Error("submitted definition has no taskId");
}
await runCommand("tar", ["-czf", outputArchive, "-C", taskDirectory, "."]);
await writeFile(outputDefinition, definitionBytes);
