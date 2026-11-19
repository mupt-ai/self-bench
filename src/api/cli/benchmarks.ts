import { EVAL_OWNER } from "../../contracts/evals.js";
import { requestJson } from "./api-client.js";
import { flag, org, parse, repositoryPath } from "./args.js";
import { print, table } from "./output.js";
import { listRepos, orgPath, type Repo, repoAction } from "./workspace.js";

const CUSTOM_USAGE = "self-bench custom list | custom create NAME | custom show|update|delete NAME";

const slugOf = (repo: Repo) => repo.fullName.slice(EVAL_OWNER.length + 1);

/**
 * `custom list|create|show|update|delete`: the workspace's Custom Benchmarks, collections of tasks
 * written from descriptions with no repository behind them. Each is stored as the repository
 * `evals/<slug>`, so `--custom NAME` and `--repo evals/NAME` name the same one.
 */
export async function customCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const { values, positionals } = parse(rest, { "agent-minutes": { type: "string" } });
  if (action === "list") {
    const customs = await listRepos(values, "eval");
    return print(values, { repos: customs }, () =>
      table(customs, [
        ["CUSTOM BENCHMARK", slugOf],
        ["AGENT MINUTES", (repo) => repo.agentMinutes],
      ]),
    );
  }
  const name = positionals.join(" ") || flag(values, "custom");
  if (!name) throw new Error(`usage: ${CUSTOM_USAGE}`);
  if (action === "create") {
    const reply = await requestJson(`${await orgPath(values)}/evals`, "POST", { name });
    const slug = slugOf(reply.repo as Repo);
    return print(values, reply, () => `Created ${slug}; pass it as --custom ${slug}.`);
  }
  const path = repositoryPath({ ...values, repo: undefined, custom: name });
  if (!(await repoAction(action, values, path, `self-bench custom update ${name}`)))
    throw new Error(`usage: ${CUSTOM_USAGE}`);
}

/** `eval create NAME`, the older name of `custom create`. */
export async function evalCommand(args: string[]): Promise<void> {
  if (args[0] !== "create") throw new Error("usage: self-bench custom create NAME");
  await customCommand(args);
}

interface Benchmark {
  name: string;
  ref: string;
  tasks: number;
  status: string;
}

const PUBLIC_USAGE =
  "self-bench public list | public add ORG/NAME[@REF] | public show|tasks|remove ORG/NAME";

/**
 * `public list|add|show|tasks|remove`: the Public Benchmarks (Harbor registry datasets) the
 * workspace added, whose tasks are frozen when added. `benchmark`, the older name, runs the same.
 */
export async function publicCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const { values, positionals } = parse(rest);
  const base = `/api/orgs/${encodeURIComponent(org(values))}/benchmarks`;
  if (action === "list") {
    const reply = await requestJson(base);
    return print(values, reply, () =>
      table(reply.benchmarks as Benchmark[], [
        ["PUBLIC BENCHMARK", (benchmark) => benchmark.name],
        ["REF", (benchmark) => benchmark.ref],
        ["TASKS", (benchmark) => benchmark.tasks],
        ["STATUS", (benchmark) => benchmark.status],
      ]),
    );
  }
  const name = positionals[0] ?? flag(values, "public") ?? flag(values, "benchmark");
  if (!name) throw new Error(`usage: ${PUBLIC_USAGE}`);
  if (action === "add") {
    const reply = await requestJson(base, "POST", { reference: name });
    return print(values, reply, () => {
      const added = reply.benchmark as Benchmark;
      return `Added ${added.name} (${added.status}); pass it as --public ${added.name}.`;
    });
  }
  const path = `${base}/${name.split("/").map(encodeURIComponent).join("/")}`;
  if (action === "show") return print(values, await requestJson(path));
  if (action === "tasks") return print(values, await requestJson(`${path}/tasks`));
  if (action === "remove") return print(values, await requestJson(path, "DELETE"));
  throw new Error(`usage: ${PUBLIC_USAGE}`);
}
