#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { packageExport } from "../export-package.js";

const operation = process.argv[2];
const root = "/work/scratch";
await mkdir(root, { recursive: true });
switch (operation) {
  case "export":
    await packageExport();
    break;
  default:
    throw Error("Unknown task operation");
}
