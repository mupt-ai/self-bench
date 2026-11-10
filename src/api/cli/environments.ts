import { readFile } from "node:fs/promises";
import type { EnvironmentItem, EnvironmentTaskItem } from "../../contracts/variants.js";
import { requestJson } from "./api-client.js";
import { flag, jsonOption, list, parse, positional, repositoryPath, type Values } from "./args.js";
import { GENERATION, generation } from "./generation.js";
import { print, table } from "./output.js";

const FLAGS = {
  ...GENERATION,
  name: { type: "string" },
  package: { type: "string", multiple: true },
  directory: { type: "string" },
  file: { type: "string", multiple: true },
  replace: { type: "boolean", default: false },
  delete: { type: "string", multiple: true },
  environment: { type: "string" },
} as const;

const coverage = (environment: EnvironmentItem) =>
  `${environment.tasks.ready}/${environment.tasks.total} ready` +
  (environment.tasks.checking ? `, ${environment.tasks.checking} checking` : "") +
  (environment.tasks.failed ? `, ${environment.tasks.failed} failed` : "");

/**
 * `environments`; `environment create|show|build|delete [ID]`: a repository's changes to its tasks'
 * files, each approved task built and checked once, for run conditions to run (environments.ts).
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

/**
 * The environment `--environment JSON|@FILE` gives whole, or `--name` with `--package NAME@SPEC`,
 * `--file DEST=SOURCE`, and `--delete PATH`, each repeatable: packages install under
 * `--directory`, and files append unless `--replace`.
 */
async function environmentFromFlags(values: Values): Promise<unknown> {
  const whole = await jsonOption(values, "environment");
  if (whole !== undefined) return whole;
  const name = flag(values, "name");
  if (!name) throw new Error("environment create needs --name, or --environment JSON|@FILE");
  const directory = flag(values, "directory") ?? "";
  const packages = list(values, "package").map((given) => {
    // A scoped name starts with @, so the version follows the last @.
    const at = given.lastIndexOf("@");
    if (at < 1) throw new Error(`--package must be NAME@SPEC: ${given}`);
    return { name: given.slice(0, at), spec: given.slice(at + 1), directory };
  });
  const mode = values.replace === true ? "replace" : "append";
  const files = [
    ...(await Promise.all(
      list(values, "file").map(async (given) => {
        const at = given.indexOf("=");
        if (at < 1) throw new Error(`--file must be DEST=SOURCE: ${given}`);
        return {
          path: given.slice(0, at),
          mode,
          content: await readFile(given.slice(at + 1), "utf8"),
        };
      }),
    )),
    ...list(values, "delete").map((path) => ({ path, mode: "delete" as const, content: "" })),
  ];
  if (packages.length + files.length === 0)
    throw new Error("environment create needs --package, --file, or --delete");
  return { name, packages, files };
}
