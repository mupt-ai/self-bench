import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { AGENT_MINUTES } from "../../contracts/agent-limit.js";
import { registryReference } from "../../contracts/harbor-registry.js";
import type { runCommand } from "../../lib/process.js";
import { isRecord } from "../../lib/util.js";
import { type JudgeNeeds, judgeNeeds } from "./host-variables.js";
import { assertHostSafePublishedTask, UnsafeHarborTaskError } from "./task-safety.js";

/** One downloaded registry task: its package name, content digest, and directory. */
export interface RegistryTask {
  readonly name: string;
  readonly digest: string;
  readonly directory: string;
}

// A large dataset is many small downloads; Harbor runs them side by side.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Downloads every task `reference` names (one task, or a dataset's tasks) under `root`. Harbor
 * runs with a HOME of its own and no other variables than PATH: it holds no one's Harbor login,
 * so only public packages resolve, and its cache then holds exactly this download, each task at
 * `tasks/packages/<org>/<name>/<digest>`.
 */
export async function downloadRegistryTasks(
  reference: string,
  root: string,
  options: { command: typeof runCommand; path: string },
): Promise<RegistryTask[]> {
  const home = join(root, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await options.command("harbor", ["download", registryReference(reference), "--cache"], {
    env: { PATH: options.path, HOME: home, HARBOR_TELEMETRY: "off" },
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  const cache = join(home, ".cache", "harbor", "tasks");
  if ((await readdir(cache).catch(() => [])).some((entry) => entry !== "packages"))
    throw new Error(`${reference} includes tasks from outside Harbor's package registry`);
  const tasks: RegistryTask[] = [];
  const packages = join(cache, "packages");
  for (const org of await directories(packages))
    for (const name of await directories(join(packages, org)))
      for (const digest of await directories(join(packages, org, name))) {
        if (!/^[a-f0-9]{64}$/.test(digest))
          throw new Error(`${reference} downloaded an unexpected cache layout`);
        tasks.push({
          name: `${org}/${name}`,
          digest: `sha256:${digest}`,
          directory: join(packages, org, name, digest),
        });
      }
  if (tasks.length === 0) throw new Error(`${reference} has no tasks`);
  return tasks.sort((left, right) => left.name.localeCompare(right.name));
}

async function directories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** Harbor's own defaults for a task that leaves a limit out (harbor/models/task/config.py). */
const HARBOR_DEFAULT_SECONDS = { build: 600, verifier: 600 } as const;

/**
 * Checks a downloaded registry task as published and changes nothing in it: its files are regular
 * files, and nothing in it reaches the host (assertHostSafePublishedTask, against `harborEnv`).
 * Returns the most minutes a trial of it can take by its own limits (build, agent, and verifier),
 * which bounds the `harbor run` around it, and the judge variables it needs (an LLM judge's key).
 * A task that sets no agent limit gets SelfBench's default for that bound only; Harbor itself
 * still runs the task as published.
 */
export async function checkRegistryTask(
  directory: string,
  harborEnv: NodeJS.ProcessEnv,
): Promise<{ minutes: number; judge: JudgeNeeds }> {
  await assertRegularTree(directory);
  await assertHostSafePublishedTask(directory, harborEnv);
  const config = parse(await readFile(join(directory, "task.toml"), "utf8"));
  const seconds = (section: unknown, key: string, fallback: number) => {
    const value = isRecord(section) ? section[key] : undefined;
    return typeof value === "number" && value > 0 ? value : fallback;
  };
  const total =
    seconds(config.environment, "build_timeout_sec", HARBOR_DEFAULT_SECONDS.build) +
    seconds(config.agent, "timeout_sec", AGENT_MINUTES.default * 60) +
    seconds(config.verifier, "timeout_sec", HARBOR_DEFAULT_SECONDS.verifier);
  return { minutes: Math.ceil(total / 60), judge: judgeNeeds(config) };
}

async function assertRegularTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const stats = await lstat(path);
    if (!stats.isFile() && !stats.isDirectory())
      throw new UnsafeHarborTaskError("task contains a symlink or unsupported file");
  }
}
