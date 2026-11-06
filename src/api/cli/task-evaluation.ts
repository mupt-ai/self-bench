import type { ResultsReport, TaskResults } from "../../evaluation/results-report.js";
import type { TaskAudit } from "../../evaluation/task-audit.js";
import { requestJson } from "./api-client.js";
import { flag, parse, positional, scopePath, type Values } from "./args.js";
import { results } from "./evaluations.js";
import { print, table, usd } from "./output.js";
import { waitFor } from "./wait.js";

const FLAGS = {
  config: { type: "string" },
  model: { type: "string" },
  credential: { type: "string" },
  wait: { type: "boolean", default: false },
} as const;

type TaskReport = ResultsReport & { audit?: TaskAudit };

/**
 * `task results|explain|audit RUN_ID TASK_ID`: how every configuration did on one task, why the
 * failures failed, and whether the task itself is fair.
 */
export async function taskEvaluationCommand(action: string, args: string[]): Promise<void> {
  const { values, positionals } = parse(args, FLAGS);
  const task = {
    runId: positional(positionals, 0, "RUN_ID"),
    taskId: positional(positionals, 1, "TASK_ID"),
  };
  if (action === "explain") await explain(values, task);
  else if (action === "audit") await audit(values, task);
  const report = await results(values, task);
  print(values, report, () => taskView(report));
}

/** The model a request pays with, when `--model` and `--credential` name one. */
function selection(values: Values): { credentialId: string; model: string } | undefined {
  const model = flag(values, "model");
  const credentialId = flag(values, "credential");
  if (!model && !credentialId) return undefined;
  if (!model || !credentialId) throw new Error("name both --model and --credential");
  return { credentialId, model };
}

/** Explains the task's unexplained failures (or `--config`'s), and with `--wait`, waits for them. */
async function explain(values: Values, task: { runId: string; taskId: string }): Promise<void> {
  const config = flag(values, "config");
  const [found] = (await results(values, task)).taskResults;
  const failures = (found?.results ?? []).filter(
    (result) =>
      !result.passed && !result.failureSummary && (!config || result.configuration === config),
  );
  if (failures.length === 0) throw new Error("no unexplained failure to explain on this task");
  const chosen = selection(values);
  const base = `${scopePath(values)}/evaluations`;
  const pathOf = (evaluationId: string) => `${base}/${encodeURIComponent(evaluationId)}/explain`;
  for (const failure of failures)
    await requestJson(pathOf(failure.evaluationId), "POST", {
      ...task,
      harness: failure.harness,
      ...(chosen ? { explanation: chosen } : {}),
    });
  if (values.wait !== true) return;
  await waitFor("failure explanations", async () => {
    const states = await Promise.all(
      failures.map(async (failure) => {
        const query = new URLSearchParams({ ...task, harness: failure.harness });
        return await requestJson(`${pathOf(failure.evaluationId)}?${query}`);
      }),
    );
    return states.some((state) => state.running === true) ? undefined : true;
  });
}

/** Starts a fairness audit of the task, and with `--wait`, waits for its verdict. */
async function audit(values: Values, task: { runId: string; taskId: string }): Promise<void> {
  const chosen = selection(values);
  if (!chosen) return;
  const path = `${scopePath(values)}/evaluations/audit`;
  await requestJson(path, "POST", { ...task, audit: chosen });
  if (values.wait !== true) return;
  const state = await waitFor("the audit", async () => {
    const reply = await requestJson(`${path}?${new URLSearchParams(task)}`);
    return reply.running === true ? undefined : reply;
  });
  const failure = state.failure as { message: string } | undefined;
  if (failure) throw new Error(`the audit gave no verdict: ${failure.message}`);
}

function taskView(report: TaskReport): string {
  const [task] = report.taskResults as [TaskResults];
  const names = new Map(report.configurations.map((row) => [row.key, row.name]));
  const name = (key: string) => names.get(key) ?? key;
  const lines = [
    `${task.runId}/${task.taskId}${task.difficulty ? ` (${task.difficulty})` : ""}: passed by ${task.passed} of ${task.scored} configurations`,
  ];
  if (report.audit)
    lines.push(
      `Fairness: ${report.audit.verdict} (${report.audit.failures} of ${report.audit.attempts} attempts failed)\n${report.audit.text}`,
    );
  lines.push(
    "",
    table(task.results, [
      ["CONFIGURATION", (result) => name(result.configuration)],
      ["RESULT", (result) => (result.passed ? "pass" : "FAIL")],
      ["COST", (result) => usd(result.costUsd)],
      ["EVALUATION", (result) => result.evaluationId],
    ]),
  );
  for (const result of task.results)
    if (!result.passed)
      lines.push(
        "",
        `${name(result.configuration)} failed:`,
        result.failureSummary ?? "(not explained yet)",
      );
  return lines.join("\n");
}
