import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { WORKSPACE_DIRECTORY } from "../../generation/task/scenario-workspace.js";
import { SUBMISSION_FILES } from "../../generation/task/submission.js";
import { extractRegularArchive } from "../../lib/archive.js";
import { runCommand } from "../../lib/process.js";
import { requestBytes, requestJson } from "./api-client.js";
import {
  flag,
  list,
  parse,
  positional,
  repositoryPath,
  taskPath,
  textOption,
  type Values,
} from "./args.js";
import { GENERATION, generation } from "./generation.js";
import { print, table } from "./output.js";
import { taskEvaluationCommand } from "./task-evaluation.js";

const TASK_FLAGS = {
  ...GENERATION,
  note: { type: "string" },
  feedback: { type: "string" },
  "feedback-file": { type: "string" },
  draft: { type: "string" },
  pr: { type: "string" },
  state: { type: "string" },
} as const;

/**
 * `scenario create`: one described scenario becomes one task. With --commit, the agent starts from
 * the repository at that commit or branch; without it, the author writes the workspace.
 */
export async function scenarioCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "create") throw new Error("usage: self-bench scenario create --repo OWNER/NAME …");
  const { values } = parse(rest, {
    ...GENERATION,
    title: { type: "string" },
    scenario: { type: "string" },
    "scenario-file": { type: "string" },
    difficulty: { type: "string" },
    attach: { type: "string", multiple: true },
    commit: { type: "string" },
  });
  const scenario = await textOption(values, "scenario");
  const title = flag(values, "title");
  if (!title || !scenario)
    throw new Error("scenario create needs --title and --scenario or --scenario-file");
  const attachments = await Promise.all(
    list(values, "attach").map(async (path) => ({
      name: basename(path),
      content: (await readFile(path)).toString("base64"),
    })),
  );
  const repository = repositoryPath(values);
  const difficulty = flag(values, "difficulty");
  const commit = flag(values, "commit");
  const reply = await requestJson(`${repository}/tasks/from-scenario`, "POST", {
    title,
    scenario,
    ...(difficulty ? { difficulty } : {}),
    ...(commit ? { commit } : {}),
    attachments,
    ...(await generation(values, repository)),
  });
  print(values, reply, () => taskLine(reply.task as Task));
}

interface Task {
  runId: string;
  taskId: string;
  state: string;
  difficulty: string;
  title?: string;
  sourcePr?: number;
  reasonSummary?: string;
  review?: { decision: string; note?: string };
}

const taskLine = (task: Task) => `Started ${task.runId}/${task.taskId} (${task.state}).`;

/** `tasks`: a repository's tasks; `task <action> RUN_ID TASK_ID`. */
export async function taskCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  if (action === "results" || action === "explain" || action === "audit")
    return await taskEvaluationCommand(action, rest);
  const { values, positionals } = parse(rest, TASK_FLAGS);
  const repository = repositoryPath(values);
  if (action === "list") return await listTasks(values, repository);
  if (action === "add-pr") {
    const pr = flag(values, "pr") ?? positionals[0];
    if (!pr) throw new Error("task add-pr needs --pr NUMBER or a pull request URL");
    const reply = await requestJson(`${repository}/tasks/from-pr`, "POST", {
      pr,
      ...(await generation(values, repository)),
    });
    return print(values, reply, () => taskLine(reply.task as Task));
  }
  const runId = positional(positionals, 0, "RUN_ID");
  const taskId = positional(positionals, 1, "TASK_ID");
  const task = taskPath(repository, runId, taskId);
  switch (action) {
    case "show":
      return print(values, await requestJson(task));
    case "pull":
      return await pullDraft(values, `${task}/draft`, positionals[2] ?? taskId);
    case "revise": {
      const feedback = await textOption(values, "feedback");
      if (!feedback) throw new Error("task revise needs --feedback or --feedback-file");
      const draft = flag(values, "draft");
      const reply = await requestJson(`${task}/feedback`, "POST", {
        feedback,
        ...(await generation(values, repository)),
        ...(draft ? { draft: await packDraft(draft) } : {}),
      });
      return print(values, reply, () => taskLine(reply.task as Task));
    }
    case "approve":
    case "reject": {
      const note = flag(values, "note");
      const reply = await requestJson(`${task}/review`, "PUT", {
        decision: action,
        ...(note ? { note } : {}),
      });
      return print(values, reply, () => `${runId}/${taskId}: ${(reply.task as Task).state}`);
    }
    case "unreview":
      return print(values, await requestJson(`${task}/review`, "DELETE"));
    case "cancel":
      return print(values, await requestJson(`${task}/cancel`, "POST"));
    case "delete":
      return print(values, await requestJson(task, "DELETE"));
    default:
      throw new Error(`unknown task command: ${action ?? ""}`);
  }
}

async function listTasks(values: Values, repository: string): Promise<void> {
  const reply = await requestJson(`${repository}/tasks`);
  const state = flag(values, "state");
  const tasks = (reply.tasks as Task[]).filter((task) => !state || task.state === state);
  print(values, { tasks }, () =>
    table(tasks, [
      ["TASK", (task) => `${task.runId}/${task.taskId}`],
      ["STATE", (task) => task.state],
      ["DIFFICULTY", (task) => task.difficulty],
      ["SOURCE", (task) => task.title ?? (task.sourcePr ? `PR #${task.sourcePr}` : "")],
      ["NOTE", (task) => task.review?.note ?? task.reasonSummary],
    ]),
  );
}

/** Downloads the task's draft and unpacks it into a new or empty directory. */
async function pullDraft(values: Values, path: string, directory: string): Promise<void> {
  const destination = resolve(directory);
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length > 0)
    throw new Error(`${destination} is not empty; pull into a new directory`);
  const scratch = await mkdtemp(join(tmpdir(), "selfbench-draft-"));
  try {
    const archive = join(scratch, "draft.tar.gz");
    await writeFile(archive, await requestBytes(path));
    await extractRegularArchive(archive, destination);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  print(values, { draft: destination }, () => `Pulled into ${destination}`);
}

/** The author's files in `directory` (as `pull` left them) as a base64 tar.gz. */
async function packDraft(directory: string): Promise<string> {
  const root = resolve(directory);
  const present = new Set(await readdir(root));
  const files = [...SUBMISSION_FILES, WORKSPACE_DIRECTORY].filter((name) => present.has(name));
  if (files.length === 0) throw new Error(`${root} holds none of the task's files`);
  const scratch = await mkdtemp(join(tmpdir(), "selfbench-draft-"));
  try {
    const archive = join(scratch, "draft.tar.gz");
    // macOS tar would otherwise add AppleDouble `._` files, which the server refuses.
    await runCommand("tar", ["-czf", archive, "--exclude=.git", "-C", root, ...files], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return (await readFile(archive)).toString("base64");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
