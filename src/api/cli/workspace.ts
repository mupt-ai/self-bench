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

export const orgPath = async (values: Values) =>
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

export interface Repo {
  kind: "github" | "eval";
  fullName: string;
  private: boolean;
  agentMinutes: number;
}

/** The workspace's connected repositories and custom benchmarks, of one kind. */
export async function listRepos(values: Values, kind: Repo["kind"]): Promise<Repo[]> {
  const reply = await requestJson(`${await orgPath(values)}/repos`);
  return (reply.repos as Repo[]).filter((repo) => repo.kind === kind);
}

/** `repo show|update|disconnect` on `path`, which a repository or custom benchmark names. */
export async function repoAction(
  action: string | undefined,
  values: Values,
  path: string,
  usage: string,
): Promise<boolean> {
  if (action === "show") print(values, await requestJson(path));
  else if (action === "disconnect" || action === "delete")
    print(values, await requestJson(path, "DELETE"));
  else if (action === "update" || action === "set") {
    const minutes = flag(values, "agent-minutes");
    if (!minutes) throw new Error(`usage: ${usage} --agent-minutes N`);
    print(values, await requestJson(path, "PATCH", { agentMinutes: Number(minutes) }));
  } else return false;
  return true;
}

const REPO_USAGE = "self-bench repo list | repo connect|show|update|disconnect OWNER/NAME";

/** `repo list|connect|show|update|disconnect`: the workspace's Repo Benchmarks. */
export async function repoCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const { values, positionals } = parse(rest, { "agent-minutes": { type: "string" } });
  if (action === "list") {
    const repos = await listRepos(values, "github");
    return print(values, { repos }, () =>
      table(repos, [
        ["REPOSITORY", (repo) => repo.fullName],
        ["PRIVATE", (repo) => (repo.private ? "yes" : "no")],
        ["AGENT MINUTES", (repo) => repo.agentMinutes],
      ]),
    );
  }
  const name = flag(values, "repo") ?? positionals[0];
  if (!name) throw new Error(`usage: ${REPO_USAGE}`);
  const repository = repositoryPath({ ...values, repo: name });
  if (action === "connect") {
    const base = repository.slice(0, repository.indexOf("/repos/") + "/repos".length);
    return print(values, await requestJson(base, "POST", { fullName: name }));
  }
  if (!(await repoAction(action, values, repository, `self-bench repo update ${name}`)))
    throw new Error(`usage: ${REPO_USAGE}`);
}

/** `pr list`: a repository's merged pull requests, which `task create --pr` and batches draw on. */
export async function prCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args[0] === "list" ? args : ["list", ...args];
  if (action !== "list") throw new Error("usage: self-bench pr list --repo OWNER/NAME [--page N]");
  const { values } = parse(rest, { page: { type: "string" } });
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

/**
 * `batch create` (once `generate`): a batch that picks merged PRs and turns them into tasks, or
 * with --features, features built over several merged PRs, each tested end to end. With
 * --features, --focus names the feature to find.
 */
async function createBatch(args: string[]): Promise<void> {
  const { values } = parse(args, {
    ...GENERATION,
    easy: { type: "string" },
    medium: { type: "string" },
    hard: { type: "string" },
    focus: { type: "string" },
    features: { type: "boolean" },
  });
  const repository = repositoryPath(values);
  const count = (name: string) => Number(flag(values, name) ?? 0);
  const candidateCounts = { easy: count("easy"), medium: count("medium"), hard: count("hard") };
  if (candidateCounts.easy + candidateCounts.medium + candidateCounts.hard === 0)
    throw new Error("batch create needs --easy, --medium, or --hard counts");
  const focus = flag(values, "focus");
  const reply = await requestJson(`${repository}/batches`, "POST", {
    candidateCounts,
    ...(focus ? { focus } : {}),
    ...(values.features ? { unit: "feature" } : {}),
    ...(await generation(values, repository)),
  });
  print(values, reply, () => `Started batch ${String(reply.runId)}.`);
}

/** `batch create|list|show|cancel`: generation batches, each turning merged PRs into tasks. */
export async function batchCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === "create") return await createBatch(rest);
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
  const path = `${base}/${encodeURIComponent(positional(positionals, 0, "BATCH"))}`;
  if (action === "show") return print(values, await requestJson(path));
  if (action === "cancel") return print(values, await requestJson(`${path}/cancel`, "POST"));
  throw new Error(
    "usage: self-bench batch create|list --repo R | batch show|cancel BATCH --repo R",
  );
}
