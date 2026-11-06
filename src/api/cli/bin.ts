#!/usr/bin/env node

import { runCli } from "./main.js";

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  console.error(`self-bench: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
