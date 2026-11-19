import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { requestJson } from "./api-client.js";
import { flag, list, parse, repositoryPath, textOption, type Values } from "./args.js";
import { GENERATION, generation } from "./generation.js";
import { print } from "./output.js";

const FLAGS = {
  ...GENERATION,
  pr: { type: "string" },
  title: { type: "string" },
  description: { type: "string" },
  "description-file": { type: "string" },
  // `scenario create`'s names for the description, still taken.
  scenario: { type: "string" },
  "scenario-file": { type: "string" },
  difficulty: { type: "string" },
  attach: { type: "string", multiple: true },
  commit: { type: "string" },
} as const;

const USAGE =
  "task create needs --pr NUMBER|URL, or --title and --description (or --description-file)";

/**
 * `task create`: one task, from a merged pull request (`--pr`, Repo Benchmarks only) or written
 * from a description (`--title` with `--description`), which is a custom task. A custom task in a
 * repository starts from it at `--commit` (the default branch without one); in a Custom Benchmark,
 * the author writes the starting files.
 */
export async function createTask(args: string[], prPositional = false): Promise<void> {
  const { values, positionals } = parse(args, FLAGS);
  const repository = repositoryPath(values);
  // `task add-pr`, the older form, took the pull request as its argument.
  const pr = flag(values, "pr") ?? (prPositional ? positionals[0] : undefined);
  if (pr && flag(values, "title")) throw new Error("name --pr or --title, not both");
  const body = pr ? { pr } : await customTask(values);
  const reply = await requestJson(
    `${repository}/tasks/${pr ? "from-pr" : "from-scenario"}`,
    "POST",
    {
      ...body,
      ...(await generation(values, repository)),
    },
  );
  print(values, reply, () =>
    startedLine(reply.task as { runId: string; taskId: string; state: string }),
  );
}

export const startedLine = (task: { runId: string; taskId: string; state: string }) =>
  `Started ${task.runId}/${task.taskId} (${task.state}).`;

/** The body of a custom task: its title, description, and any commit, difficulty, and files. */
async function customTask(values: Values): Promise<Record<string, unknown>> {
  const title = flag(values, "title");
  const scenario =
    (await textOption(values, "description")) ?? (await textOption(values, "scenario"));
  if (!title || !scenario) throw new Error(USAGE);
  const attachments = await Promise.all(
    list(values, "attach").map(async (path) => ({
      name: basename(path),
      content: (await readFile(path)).toString("base64"),
    })),
  );
  const difficulty = flag(values, "difficulty");
  const commit = flag(values, "commit");
  return {
    title,
    scenario,
    ...(difficulty ? { difficulty } : {}),
    ...(commit ? { commit } : {}),
    attachments,
  };
}

/** `scenario create`, the older name of `task create --title … --description …`. */
export async function scenarioCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "create")
    throw new Error("usage: self-bench task create --repo R --title TEXT --description TEXT");
  await createTask(rest);
}
