#!/usr/bin/env node

import { parseArgs } from "node:util";
import { runMatrix } from "./evaluate.js";

const parsed = parseArgs({
  options: {
    export: { type: "string" },
    tasks: { type: "string" },
    jobs: { type: "string" },
    harbor: { type: "string" },
    environment: { type: "string", default: "modal" },
    concurrency: { type: "string", default: "3" },
    auth: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});
if (parsed.values.help) {
  console.log(`Run Harbor tasks through the fixed Codex subscription model matrix.

Usage:
  selfbench-eval (--export FILE.tar.gz | --tasks DIRECTORY) --jobs DIRECTORY [options]

Options:
  --tasks DIRECTORY          Expanded Harbor tasks (one or more)
  --harbor PATH              Harbor executable (default: harbor)
  --environment docker|modal Execution environment (default: modal)
  --concurrency N            Concurrent trials (default: 3)
  --auth FILE                Codex ChatGPT auth.json path
  -h, --help                 Show this help`);
  process.exit(0);
}
const environment = parsed.values.environment;
if (environment !== "docker" && environment !== "modal") {
  throw new Error("--environment must be docker or modal");
}
const concurrency = positiveInteger(parsed.values.concurrency, "--concurrency");
const summaries = await runMatrix({
  ...(parsed.values.export ? { exportPath: parsed.values.export } : {}),
  ...(parsed.values.tasks ? { tasksPath: parsed.values.tasks } : {}),
  jobsDirectory: parsed.values.jobs ?? fail("--jobs is required"),
  environment,
  concurrency,
  ...(parsed.values.harbor ? { harborPath: parsed.values.harbor } : {}),
  ...(parsed.values.auth ? { authPath: parsed.values.auth } : {}),
});
console.log(
  JSON.stringify(
    {
      trials: summaries.length,
      passed: summaries.filter((summary) => summary.passed).length,
      failed: summaries.filter((summary) => !summary.passed).length,
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
