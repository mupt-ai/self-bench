import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { WORKSPACE_DIRECTORY } from "../../generation/task/scenario-workspace.js";
import { SUBMISSION_FILES } from "../../generation/task/submission.js";
import { extractRegularArchive } from "../../lib/archive.js";
import { runCommand } from "../../lib/process.js";
import { passthrough, requestBytes, requestJson } from "./api-client.js";

/** Flags every task command takes: the repository, and its org when that isn't the owner. */
const REPOSITORY = { repo: { type: "string" }, org: { type: "string" } } as const;
/** How the generation runs; omitted flags take the app's defaults (managed models and sandbox). */
const GENERATION = {
  model: { type: "string" },
  "verifier-model": { type: "string" },
  reasoning: { type: "string" },
  "model-credential": { type: "string" },
  sandbox: { type: "string" },
  "sandbox-credential": { type: "string" },
  harbor: { type: "string" },
  "harbor-credential": { type: "string" },
  generation: { type: "string" },
} as const;

type Values = Record<string, string | boolean | string[] | undefined>;

/**
 * `scenario create`: one described scenario becomes one task. With --commit, the agent starts from
 * the repository at that commit or branch; without it, the author writes the workspace.
 */
export async function scenarioCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action !== "create") throw new Error("usage: self-bench scenario create --repo OWNER/NAME …");
  const { values } = parseArgs({
    args: rest,
    options: {
      ...REPOSITORY,
      ...GENERATION,
      title: { type: "string" },
      scenario: { type: "string" },
      "scenario-file": { type: "string" },
      difficulty: { type: "string" },
      attach: { type: "string", multiple: true },
      commit: { type: "string" },
    },
    strict: true,
  });
  const scenario = await textOption(values, "scenario");
  if (!values.title || !scenario)
    throw new Error("scenario create needs --title and --scenario or --scenario-file");
  const attachments = await Promise.all(
    (values.attach ?? []).map(async (path) => ({
      name: basename(path),
      content: (await readFile(path)).toString("base64"),
    })),
  );
  const repository = repositoryPath(values);
  await passthrough("POST", `${repository}/tasks/from-scenario`, {
    title: values.title,
    scenario,
    ...(values.difficulty ? { difficulty: values.difficulty } : {}),
    ...(values.commit ? { commit: values.commit } : {}),
    attachments,
    ...(await generation(values, repository)),
  });
}

/** `tasks`: a repository's tasks; `task show|pull|revise|approve|reject|unreview|cancel|delete`. */
export async function taskCommand(args: string[], list: boolean): Promise<void> {
  const [action, ...rest] = list ? ["list", ...args] : args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      ...REPOSITORY,
      ...GENERATION,
      note: { type: "string" },
      feedback: { type: "string" },
      "feedback-file": { type: "string" },
      draft: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const tasks = `${repositoryPath(values)}/tasks`;
  if (action === "list") return await passthrough("GET", tasks);
  const [runId, taskId, directory] = positionals;
  if (!runId || !taskId) throw new Error(`usage: self-bench task ${action} RUN_ID TASK_ID …`);
  const task = `${tasks}/${encodeURIComponent(runId)}/${encodeURIComponent(taskId)}`;
  switch (action) {
    case "show":
      return await passthrough("GET", task);
    case "pull":
      return await pullDraft(`${task}/draft`, directory ?? taskId);
    case "revise": {
      const feedback = await textOption(values, "feedback");
      if (!feedback) throw new Error("task revise needs --feedback or --feedback-file");
      return await passthrough("POST", `${task}/feedback`, {
        feedback,
        ...(await generation(values, repositoryPath(values))),
        ...(typeof values.draft === "string" ? { draft: await packDraft(values.draft) } : {}),
      });
    }
    case "approve":
    case "reject":
      return await passthrough("PUT", `${task}/review`, {
        decision: action,
        ...(values.note ? { note: values.note } : {}),
      });
    case "unreview":
      return await passthrough("DELETE", `${task}/review`);
    case "cancel":
      return await passthrough("POST", `${task}/cancel`);
    case "delete":
      return await passthrough("DELETE", task);
    default:
      throw new Error(`unknown task command: ${action ?? ""}`);
  }
}

function repositoryPath(values: Values): string {
  const repo = typeof values.repo === "string" ? values.repo : "";
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra !== undefined) throw new Error("--repo OWNER/NAME is required");
  const org = typeof values.org === "string" ? values.org : owner;
  return `/api/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** `--NAME TEXT`, or `--NAME-file PATH` read as UTF-8. */
async function textOption(values: Values, name: string): Promise<string | undefined> {
  const file = values[`${name}-file`];
  if (typeof file === "string") return await readFile(file, "utf8");
  const text = values[name];
  return typeof text === "string" ? text : undefined;
}

/**
 * `{generation}` from `--generation JSON` or `--generation @FILE`, else from the flags. A
 * deployment that stores no credentials takes no settings, which generation-options says.
 */
async function generation(
  values: Values,
  repository: string,
): Promise<{ generation?: Record<string, unknown> }> {
  if (typeof values.generation === "string") {
    const text = values.generation.startsWith("@")
      ? await readFile(values.generation.slice(1), "utf8")
      : values.generation;
    return { generation: JSON.parse(text) as Record<string, unknown> };
  }
  const offered = await requestJson(`${repository}/generation-options`);
  return offered.available === false ? {} : { generation: generationFromFlags(values) };
}

/** The settings the flags describe; omitted ones take the app's defaults. */
export function generationFromFlags(values: Values): Record<string, unknown> {
  const flag = (name: string) => {
    const value = values[name];
    return typeof value === "string" ? value : undefined;
  };
  const model = flag("model") ?? "gpt-6.1-sol";
  const modelCredential = flag("model-credential");
  const optional = {
    sandboxCredentialId: flag("sandbox-credential"),
    harborEnvironment: flag("harbor"),
    harborCredentialId: flag("harbor-credential"),
  };
  return {
    authorModel: model,
    verifierModel: flag("verifier-model") ?? model,
    reasoning: flag("reasoning") ?? "high",
    modelAccess: modelCredential ? "credential" : "managed",
    ...(modelCredential ? { modelCredentialId: modelCredential } : {}),
    sandbox: flag("sandbox") ?? "managed",
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  };
}

/** Downloads the task's draft and unpacks it into a new or empty directory. */
async function pullDraft(path: string, directory: string): Promise<void> {
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
  console.log(JSON.stringify({ draft: destination }, null, 2));
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
