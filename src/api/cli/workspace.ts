import { requestJson } from "./api-client.js";
import { flag, parse, positional, repositoryPath, type Values } from "./args.js";
import { readConfig } from "./config.js";
import { GENERATION, generation } from "./generation.js";
import { print, table } from "./output.js";

/** The workspace: `--org`, SELFBENCH_ORG, or else the key owner's personal workspace. */
async function workspace(values: Values): Promise<string> {
  const named = flag(values, "org") ?? process.env.SELFBENCH_ORG ?? readConfig().org;
  if (named) return named;
  const me = await requestJson("/api/me");
  const orgs = me.orgs as { login: string; kind: string }[];
  return orgs.find((entry) => entry.kind === "user")?.login ?? (me.user as { login: string }).login;
}

const orgPath = async (values: Values) =>
  `/api/orgs/${encodeURIComponent(await workspace(values))}`;

/** `whoami`: the key's owner, its workspaces and roles, and the key's scope. */
export async function whoamiCommand(args: string[]): Promise<void> {
  const { values } = parse(args);
  const me = await requestJson("/api/me");
  const orgs = me.orgs as { login: string; role: string }[];
  const key = me.apiKey as { name: string; scope: string } | undefined;
  print(values, me, () =>
    [
      `${(me.user as { login: string }).login}${key ? ` (key ${key.name}, ${key.scope})` : ""}`,
      table(orgs, [
        ["WORKSPACE", (entry) => entry.login],
        ["ROLE", (entry) => entry.role],
      ]),
    ].join("\n"),
  );
}

interface Repo {
  kind: string;
  fullName: string;
  private: boolean;
  agentMinutes: number;
}

/** `repos`: connected repositories and evals; `repo connect|show|set|disconnect OWNER/NAME`. */
export async function repoCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  const { values, positionals } = parse(rest, { "agent-minutes": { type: "string" } });
  if (action === "list") {
    const reply = await requestJson(`${await orgPath(values)}/repos`);
    return print(values, reply, () =>
      table(reply.repos as Repo[], [
        ["REPOSITORY", (repo) => repo.fullName],
        ["KIND", (repo) => repo.kind],
        ["PRIVATE", (repo) => (repo.private ? "yes" : "no")],
        ["AGENT MINUTES", (repo) => repo.agentMinutes],
      ]),
    );
  }
  const name = flag(values, "repo") ?? positional(positionals, 0, "OWNER/NAME");
  const repository = repositoryPath({ ...values, repo: name });
  if (action === "connect") {
    const base = repository.slice(0, repository.indexOf("/repos/") + "/repos".length);
    return print(values, await requestJson(base, "POST", { fullName: name }));
  }
  if (action === "show") return print(values, await requestJson(repository));
  if (action === "disconnect") return print(values, await requestJson(repository, "DELETE"));
  if (action === "set") {
    const minutes = flag(values, "agent-minutes");
    if (!minutes) throw new Error("repo set needs --agent-minutes N");
    return print(values, await requestJson(repository, "PATCH", { agentMinutes: Number(minutes) }));
  }
  throw new Error("usage: self-bench repo connect|show|set|disconnect OWNER/NAME");
}

/** `eval create NAME`: a workspace eval, whose tasks are scenarios with authored workspaces. */
export async function evalCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const { values, positionals } = parse(rest);
  if (action !== "create") throw new Error("usage: self-bench eval create NAME");
  const name = positionals.join(" ");
  if (!name) throw new Error("NAME is required");
  const reply = await requestJson(`${await orgPath(values)}/evals`, "POST", { name });
  print(values, reply, () => `Created ${(reply.repo as Repo).fullName}; pass it as --repo.`);
}

/** `prs`: a repository's merged pull requests, which `task add-pr` and `generate` draw on. */
export async function prsCommand(args: string[]): Promise<void> {
  const { values } = parse(args, { page: { type: "string" } });
  const page = flag(values, "page") ?? "1";
  const reply = await requestJson(`${repositoryPath(values)}/pull-requests?page=${page}`);
  const pulls = reply.pullRequests as { number: number; title: string; author?: string }[];
  print(values, reply, () =>
    table(pulls, [
      ["PR", (pull) => `#${pull.number}`],
      ["TITLE", (pull) => pull.title],
      ["AUTHOR", (pull) => pull.author],
    ]),
  );
}

/** `generate`: a batch that picks merged PRs and turns them into tasks. */
export async function generateCommand(args: string[]): Promise<void> {
  const { values } = parse(args, {
    ...GENERATION,
    easy: { type: "string" },
    medium: { type: "string" },
    hard: { type: "string" },
    focus: { type: "string" },
  });
  const repository = repositoryPath(values);
  const count = (name: string) => Number(flag(values, name) ?? 0);
  const candidateCounts = { easy: count("easy"), medium: count("medium"), hard: count("hard") };
  if (candidateCounts.easy + candidateCounts.medium + candidateCounts.hard === 0)
    throw new Error("generate needs --easy, --medium, or --hard counts");
  const focus = flag(values, "focus");
  const reply = await requestJson(`${repository}/batches`, "POST", {
    candidateCounts,
    ...(focus ? { focus } : {}),
    ...(await generation(values, repository)),
  });
  print(values, reply, () => `Started batch ${String(reply.runId)}.`);
}

/** `batches`; `batch show|cancel RUN_ID`. */
export async function batchCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  const { values, positionals } = parse(rest);
  const base = `${repositoryPath(values)}/batches`;
  if (action === "list") {
    const reply = await requestJson(base);
    const batches = reply.batches as { runId: string; attachedBy: string; attachedAt: string }[];
    return print(values, reply, () =>
      table(batches, [
        ["BATCH", (batch) => batch.runId],
        ["STARTED BY", (batch) => batch.attachedBy],
        ["STARTED", (batch) => batch.attachedAt],
      ]),
    );
  }
  const path = `${base}/${encodeURIComponent(positional(positionals, 0, "RUN_ID"))}`;
  if (action === "show") return print(values, await requestJson(path));
  if (action === "cancel") return print(values, await requestJson(`${path}/cancel`, "POST"));
  throw new Error("usage: self-bench batch show|cancel RUN_ID");
}
