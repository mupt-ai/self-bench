#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { compileHarborTask } from "../../harbor-task.js";

const [tasksRoot, repositoryDirectory, outputDirectory] = process.argv.slice(2);
if (!tasksRoot || !repositoryDirectory || !outputDirectory) {
  throw new Error("usage: sandbox-author TASKS_ROOT REPOSITORY OUTPUT");
}

const entries = await readdir(tasksRoot, { withFileTypes: true });
const taskDirectories = entries
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(tasksRoot, entry.name));
if (taskDirectories.length !== 1) {
  throw new Error(`authoring must produce exactly one task; found ${taskDirectories.length}`);
}
await compileHarborTask(taskDirectories[0] as string, repositoryDirectory, outputDirectory);
