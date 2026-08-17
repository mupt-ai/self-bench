#!/usr/bin/env node

import { parseArgs } from "node:util";
import { smokeAllAdapters } from "./agent-smoke.js";
import { isHarborEnvironment } from "./providers.js";

const parsed = parseArgs({
  options: {
    task: { type: "string" },
    jobs: { type: "string" },
    harbor: { type: "string" },
    environment: { type: "string", default: "modal" },
    concurrency: { type: "string", default: "4" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});
if (parsed.values.help) {
  console.log(`Attempt installation and instantiation of every pinned Harbor adapter.

Usage:
  self-bench-agent-smoke --task DIRECTORY --jobs DIRECTORY [options]

Options:
  --harbor PATH              Harbor executable (default: harbor)
  --environment docker|modal Execution environment (default: modal)
  --concurrency N            Concurrent adapter checks (default: 4)
  -h, --help                 Show this help`);
  process.exit(0);
}
const environment = parsed.values.environment ?? "modal";
if (!isHarborEnvironment(environment)) {
  throw new Error("--environment must be docker or modal");
}
const results = await smokeAllAdapters({
  taskDirectory: parsed.values.task ?? fail("--task is required"),
  jobsDirectory: parsed.values.jobs ?? fail("--jobs is required"),
  environment,
  concurrency: positiveInteger(parsed.values.concurrency, "--concurrency"),
  ...(parsed.values.harbor ? { harborPath: parsed.values.harbor } : {}),
});
console.log(
  JSON.stringify(
    {
      adapters: results.length,
      installed: results.filter((result) => result.installed).length,
      failed: results.filter((result) => !result.installed).length,
    },
    null,
    2,
  ),
);

function fail(message: string): never {
  throw new Error(message);
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}
