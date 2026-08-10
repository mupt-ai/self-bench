import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { archiveIncompleteHarborJob, tryReadHarborJobResult } from "./harbor-results.js";
import { parallelMap } from "./parallel.js";
import { runCommand } from "./process.js";
import { assertCodexSubscriptionAuth } from "./subscription-auth.js";

export const MATRIX_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
const CODEX_VERSION = "0.146.1";

export interface MatrixOptions {
  readonly exportPath?: string;
  readonly tasksPath?: string;
  readonly jobsDirectory: string;
  readonly harborPath?: string;
  readonly environment?: "docker" | "modal";
  readonly concurrency?: number;
  readonly authPath?: string;
}

export interface MatrixTrialSummary {
  readonly taskId: string;
  readonly model: (typeof MATRIX_MODELS)[number];
  readonly jobName: string;
  readonly passed: boolean;
  readonly rewards: Readonly<Record<string, number>>;
  readonly exception?: string;
}

export async function runMatrix(options: MatrixOptions): Promise<readonly MatrixTrialSummary[]> {
  const root = resolve(options.jobsDirectory);
  const tasksDirectory = join(root, "tasks");
  await mkdir(root, { recursive: true });
  const taskDirectories = await resolveMatrixTasks(options, tasksDirectory);
  const authPath = resolve(options.authPath ?? join(homedir(), ".codex/auth.json"));
  await assertSubscriptionAuth(authPath);
  const work = MATRIX_MODELS.flatMap((model) =>
    taskDirectories.map((taskDirectory) => ({ model, taskDirectory })),
  );
  const summaries = await parallelMap(work, options.concurrency ?? 3, async (item) => {
    return await runTrial({
      jobsDirectory: root,
      harborPath: options.harborPath ?? "harbor",
      environment: options.environment ?? "modal",
      authPath,
      ...item,
    });
  });
  await writeFile(
    join(root, "summary.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        agent: "codex",
        agentVersion: CODEX_VERSION,
        auth: "codex-subscription",
        reasoningEffort: "high",
        models: MATRIX_MODELS,
        taskCount: taskDirectories.length,
        trials: summaries,
      },
      null,
      2,
    )}\n`,
  );
  return summaries;
}

async function resolveMatrixTasks(
  options: MatrixOptions,
  materializedTasksDirectory: string,
): Promise<string[]> {
  if (options.exportPath && options.tasksPath) {
    throw new Error("provide exactly one of exportPath or tasksPath");
  }
  if (options.tasksPath) {
    const tasks = await taskDirectories(resolve(options.tasksPath));
    if (tasks.length < 1) {
      throw new Error(`found no Harbor tasks in ${resolve(options.tasksPath)}`);
    }
    return tasks;
  }
  if (!options.exportPath) {
    throw new Error("provide exactly one of exportPath or tasksPath");
  }
  const tasks = await materializeExport(resolve(options.exportPath), materializedTasksDirectory);
  if (tasks.length < 1) {
    throw new Error(`found no Harbor tasks in ${resolve(options.exportPath)}`);
  }
  return tasks;
}

async function runTrial(input: {
  readonly taskDirectory: string;
  readonly model: (typeof MATRIX_MODELS)[number];
  readonly jobsDirectory: string;
  readonly harborPath: string;
  readonly environment: "docker" | "modal";
  readonly authPath: string;
}): Promise<MatrixTrialSummary> {
  const taskId = basename(input.taskDirectory);
  const jobName = `${taskId}-${input.model}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const existing = await tryReadHarborJobResult(input.jobsDirectory, jobName);
  if (existing) {
    return summarizeResult(taskId, input.model, jobName, existing.trial);
  }
  await archiveIncompleteHarborJob(input.jobsDirectory, jobName);

  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  environment.CODEX_FORCE_AUTH_JSON = "1";
  environment.CODEX_AUTH_JSON_PATH = input.authPath;
  const result = await runCommand(
    input.harborPath,
    [
      "run",
      "--path",
      input.taskDirectory,
      "--agent",
      "codex",
      "--model",
      input.model,
      "--ak",
      `version=${CODEX_VERSION}`,
      "--ak",
      "reasoning_effort=high",
      "--env",
      input.environment,
      "--job-name",
      jobName,
      "--jobs-dir",
      input.jobsDirectory,
      "--n-concurrent",
      "1",
      "--max-retries",
      "1",
      "--delete",
      "--yes",
      "--quiet",
    ],
    { allowFailure: true, env: environment, timeoutMs: 4 * 60 * 60 * 1000 },
  );
  const completed = await tryReadHarborJobResult(input.jobsDirectory, jobName);
  if (!completed) {
    throw new Error(
      `Harbor produced no result for ${taskId}/${input.model} (exit ${result.exitCode}): ${result.stderr.slice(-1000)}`,
    );
  }
  return summarizeResult(taskId, input.model, jobName, completed.trial);
}

export function summarizeResult(
  taskId: string,
  model: (typeof MATRIX_MODELS)[number],
  jobName: string,
  result: unknown,
): MatrixTrialSummary {
  const trial =
    isRecord(result) && Array.isArray(result.trial_results) ? result.trial_results[0] : result;
  if (!isRecord(trial)) {
    throw new Error(`invalid Harbor result for ${taskId}/${model}`);
  }
  const rawRewards =
    isRecord(trial.verifier_result) && isRecord(trial.verifier_result.rewards)
      ? trial.verifier_result.rewards
      : {};
  const rewards = Object.fromEntries(
    Object.entries(rawRewards).flatMap(([key, value]) =>
      typeof value === "number" ? [[key, value] as const] : [],
    ),
  );
  const exception = exceptionText(trial.exception_info ?? trial.exception);
  return {
    taskId,
    model,
    jobName,
    passed:
      !exception &&
      Object.keys(rewards).length > 0 &&
      Object.values(rewards).every((reward) => reward >= 1),
    rewards,
    ...(exception ? { exception } : {}),
  };
}

async function materializeExport(exportPath: string, tasksDirectory: string): Promise<string[]> {
  const existing = await taskDirectories(tasksDirectory);
  if (existing.length > 0) {
    return existing;
  }
  return await withTemporaryDirectory("selfbench-matrix-", async (temporary) => {
    await runCommand("tar", ["-xzf", exportPath, "-C", temporary]);
    const archivesRoot = join(temporary, "tasks");
    const archives = (await readdir(archivesRoot))
      .filter((name) => name.endsWith(".tar.gz"))
      .sort();
    await mkdir(tasksDirectory, { recursive: true });
    for (const archive of archives) {
      const taskId = archive.slice(0, -".tar.gz".length);
      const expanded = join(temporary, `expanded-${taskId}`);
      await mkdir(expanded);
      await runCommand("tar", ["-xzf", join(archivesRoot, archive), "-C", expanded]);
      await cp(join(expanded, "harbor-task"), join(tasksDirectory, taskId), { recursive: true });
    }
    return await taskDirectories(tasksDirectory);
  });
}

async function taskDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(root, entry.name);
    if (await readFile(join(path, "task.toml")).catch(() => undefined)) {
      paths.push(path);
    }
  }
  return paths.sort();
}

async function assertSubscriptionAuth(path: string): Promise<void> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  assertCodexSubscriptionAuth(parsed, path);
}

async function withTemporaryDirectory<T>(
  prefix: string,
  action: (root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function exceptionText(value: unknown): string | undefined {
  if (typeof value === "string" && value) {
    return value;
  }
  if (isRecord(value)) {
    return typeof value.message === "string" ? value.message : JSON.stringify(value);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
