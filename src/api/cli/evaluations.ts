import { randomUUID } from "node:crypto";
import { MAX_SUMMARY_CONFIGURATIONS } from "../../contracts/model-summary-limit.js";
import type { ResultsReport } from "../../evaluation/results-report.js";
import type { TaskAudit } from "../../evaluation/task-audit.js";
import { requestJson } from "./api-client.js";
import {
  flag,
  jsonOption,
  list,
  parse,
  positional,
  scopePath,
  taskRef,
  type Values,
} from "./args.js";
import { percent, print, table, usd } from "./output.js";
import { waitFor } from "./wait.js";

const SELECTION = {
  model: { type: "string", multiple: true },
  harness: { type: "string", multiple: true },
  thinking: { type: "string" },
  credential: { type: "string" },
  sandbox: { type: "string" },
  "sandbox-credential": { type: "string" },
  task: { type: "string", multiple: true },
  "skip-completed": { type: "boolean", default: false },
  "judge-credential": { type: "string" },
  selection: { type: "string" },
} as const;

/** `catalog`: the models, harnesses' sandboxes, and managed offer evaluations can use. */
export async function catalogCommand(args: string[]): Promise<void> {
  const { values } = parse(args);
  const reply = await requestJson(`${scopePath(values)}/evaluations/catalog`);
  const models = reply.models as { id: string; label: string; vendor?: string }[];
  print(values, reply, () =>
    table(models, [
      ["MODEL", (model) => model.id],
      ["NAME", (model) => model.label],
      ["VENDOR", (model) => model.vendor],
    ]),
  );
}

/**
 * `compare`: runs models on the scope's tasks (every approved task unless `--task` names some),
 * as Run Evaluation does in the app. `--selection` sends a full comparison body instead.
 */
export async function compareCommand(args: string[]): Promise<void> {
  const { values } = parse(args, SELECTION);
  const scope = scopePath(values);
  const body = (await jsonOption(values, "selection")) ?? selectionFromFlags(values);
  const reply = await requestJson(`${scope}/evaluations/comparisons`, "POST", body);
  print(values, reply, () => comparisonView(reply as unknown as Comparison));
}

export function selectionFromFlags(values: Values): Record<string, unknown> {
  const models = list(values, "model");
  if (models.length === 0) throw new Error("compare needs --model (repeat it to compare several)");
  const harnesses = list(values, "harness");
  const thinking = flag(values, "thinking");
  const judge = flag(values, "judge-credential");
  const tasks = list(values, "task").map(taskRef);
  return {
    id: randomUUID(),
    models: models.map((catalogId) => ({
      catalogId,
      credentialId: flag(values, "credential") ?? "managed-model",
      ...(thinking ? { thinking } : {}),
      harnesses: harnesses.length ? harnesses : ["pi"],
    })),
    sandbox: flag(values, "sandbox") ?? "managed",
    sandboxCredentialId: flag(values, "sandbox-credential") ?? "managed-sandbox",
    ...(values["skip-completed"] === true ? { skipCompleted: true } : {}),
    ...(tasks.length ? { tasks } : {}),
    ...(judge ? { judgeCredentialId: judge } : {}),
  };
}

interface Comparison {
  id: string;
  createdAt: string;
  submissionError?: string;
  runs: {
    id: string;
    model: string;
    harnesses: string[];
    status: string;
    completed: number;
    trials: number;
  }[];
}

function comparisonView(comparison: Comparison): string {
  const runs = table(comparison.runs, [
    ["EVALUATION", (run) => run.id],
    ["MODEL", (run) => run.model],
    ["HARNESSES", (run) => run.harnesses.join(", ")],
    ["STATUS", (run) => run.status],
    ["TRIALS", (run) => `${run.completed}/${run.trials}`],
  ]);
  const error = comparison.submissionError ? `\n${comparison.submissionError}` : "";
  return `Comparison ${comparison.id}\n${runs}${error}`;
}

/** `comparisons`; `comparison show|resume|cancel ID`. */
export async function comparisonCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  const { values, positionals } = parse(rest);
  const base = `${scopePath(values)}/evaluations/comparisons`;
  if (action === "list") {
    const reply = await requestJson(base);
    const comparisons = reply.comparisons as Comparison[];
    return print(values, reply, () => comparisons.map(comparisonView).join("\n\n") || "(none)");
  }
  const path = `${base}/${encodeURIComponent(positional(positionals, 0, "comparison ID"))}`;
  if (action !== "show" && action !== "resume" && action !== "cancel")
    throw new Error("usage: self-bench comparison show|resume|cancel ID");
  const reply = await requestJson(
    action === "show" ? path : `${path}/${action}`,
    action === "show" ? "GET" : "POST",
  );
  print(values, reply, () => comparisonView(reply as unknown as Comparison));
}

/** `runs`; `run show|cancel|delete EVALUATION_ID`. */
export async function evaluationRunCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  const { values, positionals } = parse(rest);
  const base = `${scopePath(values)}/evaluations`;
  if (action === "list") {
    const reply = await requestJson(base);
    const runs = reply.runs as {
      id: string;
      modelLabel: string;
      harnesses: string[];
      status: string;
      createdAt: string;
      trials: unknown[];
    }[];
    return print(values, reply, () =>
      table(runs, [
        ["EVALUATION", (run) => run.id],
        ["MODEL", (run) => run.modelLabel],
        ["HARNESSES", (run) => run.harnesses.join(", ")],
        ["STATUS", (run) => run.status],
        ["TRIALS", (run) => run.trials.length],
        ["STARTED", (run) => run.createdAt],
      ]),
    );
  }
  const path = `${base}/${encodeURIComponent(positional(positionals, 0, "evaluation ID"))}`;
  if (action === "show") return print(values, await requestJson(path));
  if (action === "cancel" || action === "delete")
    return print(values, await requestJson(`${path}/${action}`, "POST"));
  throw new Error("usage: self-bench run show|cancel|delete EVALUATION_ID");
}

/** `results`: each configuration's score on the tasks results count on. */
export async function resultsCommand(args: string[]): Promise<void> {
  const { values } = parse(args);
  const report = await results(values);
  print(values, report, () => resultsView(report));
}

/** The scope's results, or one task's with its latest fairness audit. */
export async function results(
  values: Values,
  task?: { runId: string; taskId: string },
): Promise<ResultsReport & { audit?: TaskAudit }> {
  const query = task ? `?${new URLSearchParams(task)}` : "";
  const reply = await requestJson(`${scopePath(values)}/evaluations/results${query}`);
  return reply as unknown as ResultsReport & { audit?: TaskAudit };
}

function resultsView(report: ResultsReport): string {
  const configurations = table(report.configurations, [
    ["CONFIGURATION", (row) => row.name],
    ["PASS RATE", (row) => percent(row.passRate)],
    ["PASSED", (row) => `${row.passed}/${row.scored}`],
    ["BLOCKED", (row) => `${row.blocked}/${row.scored}`],
    ["COST / TASK", (row) => usd(row.costPerTaskUsd)],
    ["KEY", (row) => row.key],
  ]);
  const tasks = table(report.taskResults, [
    ["TASK", (task) => `${task.runId}/${task.taskId}`],
    ["DIFFICULTY", (task) => task.difficulty],
    ["PASSED", (task) => `${task.passed}/${task.scored}`],
  ]);
  return `${report.tasks} tasks\n\n${configurations}\n\nTasks, hardest first\n${tasks}`;
}

/** `summaries`: the latest Model Summaries report; `summaries create` writes a new one. */
export async function summariesCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args[0] === "create" ? args : ["show", ...args];
  const { values } = parse(rest, {
    config: { type: "string", multiple: true },
    model: { type: "string" },
    credential: { type: "string" },
    wait: { type: "boolean", default: false },
  });
  const path = `${scopePath(values)}/evaluations/summaries`;
  const show = async () => {
    const [reply, report] = await Promise.all([requestJson(path), results(values)]);
    const names = new Map(report.configurations.map((row) => [row.key, row.name]));
    print(values, reply, () => summariesView(reply, names));
  };
  if (action === "show") return await show();
  const model = flag(values, "model");
  const credentialId = flag(values, "credential");
  if (!model || !credentialId) throw new Error("summaries create needs --model and --credential");
  let configurations = list(values, "config");
  if (configurations.length === 0) {
    const { configurations: scored } = await results(values);
    configurations = scored.slice(0, MAX_SUMMARY_CONFIGURATIONS).map((row) => row.key);
  }
  const started = await requestJson(path, "POST", {
    configurations,
    summary: { credentialId, model },
  });
  if (values.wait !== true)
    return print(values, started, () => "Summarizing. Run `self-bench summaries` to read it.");
  await waitFor("model summaries", async () => {
    const state = await requestJson(path);
    return (state.running as unknown[]).length ? undefined : true;
  });
  await show();
}

function summariesView(reply: Record<string, unknown>, names: ReadonlyMap<string, string>): string {
  const report = reply.report as
    | {
        overview: string;
        summaries: { configuration: string; text: string; passed: number; tasks: number }[];
      }
    | undefined;
  const failure = reply.failure as { message: string } | undefined;
  if (!report)
    return failure ? `No summary: ${failure.message}` : String(reply.reason ?? "No summaries yet.");
  const sections = report.summaries.map(
    (summary) =>
      `## ${names.get(summary.configuration) ?? summary.configuration} (${summary.passed}/${summary.tasks} passed)\n${summary.text}`,
  );
  return [`## Overall\n${report.overview}`, ...sections].join("\n\n");
}
