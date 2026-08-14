#!/usr/bin/env node

import { parseArgs } from "node:util";
import { MATRIX_MODELS, type MatrixModel, runMatrix } from "./evaluate.js";

const parsed = parseArgs({
  options: {
    export: { type: "string" },
    tasks: { type: "string" },
    jobs: { type: "string" },
    harbor: { type: "string" },
    environment: { type: "string", default: "modal" },
    concurrency: { type: "string", default: "3" },
    auth: { type: "string" },
    model: { type: "string", multiple: true },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
});
if (parsed.values.help) {
  console.log(`Run Harbor tasks through the fixed Codex model matrix.

Usage:
  self-bench-eval (--export FILE.tar.gz | --tasks DIRECTORY) --jobs DIRECTORY [options]

Options:
  --tasks DIRECTORY          Expanded Harbor tasks (one or more)
  --harbor PATH              Harbor executable (default: harbor)
  --environment docker|modal Execution environment (default: modal)
  --concurrency N            Concurrent trials (default: 3)
  --model MODEL              Run only this model; may be repeated
  --auth FILE                Optional Codex ChatGPT auth.json fallback
  -h, --help                 Show this help`);
  process.exit(0);
}
const environment = parsed.values.environment;
if (environment !== "docker" && environment !== "modal") {
  throw new Error("--environment must be docker or modal");
}
const concurrency = positiveInteger(parsed.values.concurrency, "--concurrency");
const models = evaluationModels(parsed.values.model);
const summaries = await runMatrix({
  ...(parsed.values.export ? { exportPath: parsed.values.export } : {}),
  ...(parsed.values.tasks ? { tasksPath: parsed.values.tasks } : {}),
  jobsDirectory: parsed.values.jobs ?? fail("--jobs is required"),
  environment,
  concurrency,
  ...(parsed.values.harbor ? { harborPath: parsed.values.harbor } : {}),
  ...(parsed.values.auth ? { authPath: parsed.values.auth } : {}),
  ...(models ? { models } : {}),
  onTrialComplete: (summary, completed, total) => {
    const status = summary.passed ? "passed" : summary.exception ? "error" : "failed";
    console.error(`[${completed}/${total}] ${summary.model} ${summary.taskId}: ${status}`);
  },
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

function evaluationModels(values: string[] | undefined): readonly MatrixModel[] | undefined {
  if (!values) {
    return undefined;
  }
  const allowed = new Set<string>(MATRIX_MODELS);
  const invalid = values.filter((value) => !allowed.has(value));
  if (invalid.length > 0) {
    throw new Error(
      `--model must be one of ${MATRIX_MODELS.join(", ")}; got ${invalid.join(", ")}`,
    );
  }
  return [...new Set(values)] as MatrixModel[];
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}
