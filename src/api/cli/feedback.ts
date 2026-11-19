import { readFileSync } from "node:fs";
import { EVAL_OWNER } from "../../contracts/evals.js";
import { apiOrigin, requestJson } from "./api-client.js";
import {
  flag,
  parse,
  repositoryPath,
  taskArguments,
  taskPath,
  textOption,
  type Values,
} from "./args.js";
import { GENERATION, generation } from "./generation.js";
import { print } from "./output.js";

const USAGE =
  'usage: self-bench feedback TASK_URL "TEXT" | feedback OWNER/NAME RUN_ID TASK_ID "TEXT"';

interface Task {
  runId: string;
  taskId: string;
  state: string;
  pipelineStatus: string;
}

interface Target {
  /** The benchmark's stored `owner/name`: a repository, or `evals/<name>` for a custom one. */
  repo: string;
  runId: string;
  taskId: string;
  rest: string[];
}

/**
 * A task page's address, as the app shows it: `/repos/OWNER/NAME/tasks/RUN/TASK`,
 * `/custom/NAME/tasks/RUN/TASK`, or the older `/repos/evals/NAME/tasks/RUN/TASK`.
 */
function taskFromUrl(address: string): Omit<Target, "rest"> | undefined {
  let path: string;
  try {
    path = new URL(address).pathname;
  } catch {
    return undefined;
  }
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const at = parts.indexOf("tasks");
  const [kind, ...name] = parts.slice(0, at);
  const [runId, taskId] = parts.slice(at + 1);
  if (at < 0 || !runId || !taskId) return undefined;
  if (kind === "repos" && name.length === 2) return { repo: name.join("/"), runId, taskId };
  if (kind === "custom" && name.length === 1)
    return { repo: `${EVAL_OWNER}/${name[0]}`, runId, taskId };
  return undefined;
}

/** The task: a URL, `--repo`/`--custom` with `RUN_ID/TASK_ID`, or `OWNER/NAME RUN_ID TASK_ID`. */
function target(values: Values, positionals: string[]): Target {
  const [first = "", ...rest] = positionals;
  const fromUrl = /^https?:\/\//.test(first) ? taskFromUrl(first) : undefined;
  if (fromUrl) return { ...fromUrl, rest };
  if (/^https?:\/\//.test(first)) throw new Error(`not a task page: ${first}`);
  if (flag(values, "repo") || flag(values, "custom"))
    return { repo: "", ...taskArguments(positionals) };
  if (!first.includes("/")) throw new Error(USAGE);
  return { repo: first, ...taskArguments(rest) };
}

/** The feedback: `-` reads stdin, `--feedback-file` a file, else the words after the task. */
async function feedbackText(values: Values, words: string[]): Promise<string | undefined> {
  if (words.length === 1 && words[0] === "-") return readFileSync(0, "utf8").trim() || undefined;
  return (await textOption(values, "feedback")) ?? (words.join(" ").trim() || undefined);
}

/** The app's page for a task, from its repository path (`/api/orgs/<org>/repos/<owner>/<name>`). */
export function taskPageUrl(repository: string, runId: string, taskId: string): string {
  const [owner = "", name = ""] = repository.split("/repos/")[1]?.split("/") ?? [];
  const page =
    decodeURIComponent(owner) === EVAL_OWNER ? `/custom/${name}` : `/repos/${owner}/${name}`;
  return new URL(
    `${page}/tasks/${encodeURIComponent(runId)}/${encodeURIComponent(taskId)}`,
    apiOrigin(),
  ).toString();
}

/**
 * `feedback TASK TEXT`: tells a task what to change. While it is still generating, its author reads
 * the note at its next turn (`task steer`); once it has finished, a revision starts from the
 * feedback (`task revise`). `--from-audit` sends the task's latest fairness audit, after any text.
 */
export async function feedbackCommand(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, {
    ...GENERATION,
    feedback: { type: "string" },
    "feedback-file": { type: "string" },
    "from-audit": { type: "boolean", default: false },
  });
  const { repo, runId, taskId, rest } = target(values, positionals);
  const repository = repositoryPath(repo ? { ...values, repo, custom: undefined } : values);
  const task = taskPath(repository, runId, taskId);
  const written = await feedbackText(values, rest);
  const audit = values["from-audit"] === true ? await auditText(repository, runId, taskId) : "";
  const feedback = [written, audit].filter(Boolean).join("\n\n");
  if (!feedback) throw new Error(`no feedback given\n${USAGE}`);
  const current = (await requestJson(task)).task as Task;
  if (current.pipelineStatus === "in_progress") {
    const reply = await requestJson(`${task}/steering`, "POST", { feedback });
    return print(
      values,
      { action: "steer", ...reply },
      () => `${runId}/${taskId} is still generating; its author reads this at its next turn.`,
    );
  }
  const reply = await requestJson(`${task}/feedback`, "POST", {
    feedback,
    ...(await generation(values, repository)),
  });
  const revision = reply.task as Task;
  const url = taskPageUrl(repository, revision.runId, revision.taskId);
  print(
    values,
    { action: "revise", url, ...reply },
    () => `Revising as ${revision.runId}/${revision.taskId} (${revision.state}).\n${url}`,
  );
}

/** The task's latest fairness audit, as feedback for its author. */
async function auditText(repository: string, runId: string, taskId: string): Promise<string> {
  const query = new URLSearchParams({ runId, taskId });
  const reply = await requestJson(`${repository}/evaluations/audit?${query}`);
  const audit = reply.audit as { verdict: string; text: string } | undefined;
  if (!audit)
    throw new Error(
      "this task has no audit yet; run self-bench task audit TASK --model ID --credential ID --wait",
    );
  return `A fairness audit of this task (verdict: ${audit.verdict}) found:\n\n${audit.text}`;
}
