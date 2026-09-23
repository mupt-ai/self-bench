#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractRegularArchive } from "../../lib/archive.js";
import { runCommand } from "../../lib/process.js";
import { packageExport } from "../export-package.js";
import { verifierMaterial } from "../verifier-material.js";

const operation = process.argv[2];
const root = "/work/scratch";
await mkdir(root, { recursive: true });
switch (operation) {
  case "export":
    await packageExport();
    break;
  case "material":
    await verifierMaterial(root);
    break;
  case "unpack": {
    await extractRegularArchive("/work/source-task.tar.gz", root);
    const [testPatch, goldPatch] = await Promise.all([
      readFile(join(root, "test.patch"), "utf8"),
      readFile(join(root, "gold.patch"), "utf8"),
    ]);
    await writeFile("/work/patches.json", JSON.stringify({ testPatch, goldPatch }));
    break;
  }
  case "draft": {
    const directory = join(root, "authored");
    await mkdir(directory);
    for (const name of ["definition.json", "test.patch", "gold.patch"])
      await writeFile(join(directory, name), await readFile(`/work/${name}`));
    await runCommand("tar", ["-czf", "/work/source-task.tar.gz", "-C", directory, "."]);
    break;
  }
  default:
    throw Error("Unknown task operation");
}
