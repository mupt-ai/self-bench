#!/usr/bin/env node

import { runCli } from "./main.js";
import { err } from "./style.js";

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(err.on() ? `${err.red("✗")} ${message}` : `self-bench: ${message}`);
  process.exitCode = 1;
}
