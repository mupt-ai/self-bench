import type { EnvironmentItem, EnvironmentTaskItem } from "../../contracts/variants.js";
import { requestJson } from "./api-client.js";
import { flag, parse, positional, repositoryPath, textOption, type Values } from "./args.js";
import { GENERATION, generation } from "./generation.js";
import { print, table } from "./output.js";

const FLAGS = {
  ...GENERATION,
  name: { type: "string" },
  script: { type: "string" },
  "script-file": { type: "string" },
} as const;

const coverage = (environment: EnvironmentItem) =>
  `${environment.tasks.ready}/${environment.tasks.total} ready` +
  (environment.tasks.checking ? `, ${environment.tasks.checking} checking` : "") +
  (environment.tasks.failed ? `, ${environment.tasks.failed} failed` : "");

/**
 * `environments`; `environment create|show|build|delete [ID]`: a repository's scripts that change
 * its tasks' files, each approved task built and checked once, for run conditions to run
 * (environments.ts).
 */
export async function environmentCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  const { values, positionals } = parse(rest, FLAGS);
  const repository = repositoryPath(values);
  const base = `${repository}/environments`;
  const one = () => `${base}/${encodeURIComponent(positional(positionals, 0, "ID"))}`;
  switch (action) {
    case "list": {
      const reply = await requestJson(base);
      return print(values, reply, () =>
        table(reply.environments as EnvironmentItem[], [
          ["ID", (environment) => environment.id],
          ["NAME", (environment) => environment.name],
          ["TASKS", coverage],
        ]),
      );
    }
    case "create": {
      const reply = await requestJson(base, "POST", {
        environment: await environmentFromFlags(values),
        ...(await generation(values, repository)),
      });
      const environment = reply.environment as EnvironmentItem;
      return print(
        values,
        reply,
        () => `Building ${environment.name} (${environment.id}): ${coverage(environment)}.`,
      );
    }
    case "show": {
      const reply = await requestJson(one());
      return print(values, reply, () =>
        [
          `${(reply.environment as EnvironmentItem).name}: ${coverage(reply.environment as EnvironmentItem)}`,
          table(reply.tasks as EnvironmentTaskItem[], [
            ["TASK", (task) => `${task.task.runId}/${task.task.taskId}`],
            ["STATE", (task) => task.state],
            ["NOTE", (task) => task.reasonSummary],
          ]),
        ].join("\n"),
      );
    }
    case "build":
      return print(
        values,
        await requestJson(`${one()}/build`, "POST", await generation(values, repository)),
      );
    case "delete":
      return print(values, await requestJson(one(), "DELETE"));
    default:
      throw new Error(
        "usage: self-bench environments --repo R | environment create|show|build|delete [ID] --repo R",
      );
  }
}

/** `--name` with the script, as `--script TEXT` or `--script-file PATH`. */
async function environmentFromFlags(values: Values): Promise<unknown> {
  const name = flag(values, "name");
  const script = await textOption(values, "script");
  if (!name || script === undefined)
    throw new Error("environment create needs --name, and --script or --script-file");
  return { name, script };
}
