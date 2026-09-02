#!/usr/bin/env node

import { prepareTaskWorkspace } from "./prepare-task.js";

const [archivePath] = process.argv.slice(2);
if (!archivePath) {
  throw new Error("usage: sandbox-verifier TASK.tar.gz");
}

const prepared = await prepareTaskWorkspace(archivePath);
process.stdout.write(
  `prepared verifier workspace: task=${prepared.taskDirectory} repo=${prepared.repositoryDirectory}\n`,
);
