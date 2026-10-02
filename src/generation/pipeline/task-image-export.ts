import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../../artifacts/index.js";
import { executionEnvironment } from "../../contracts/config/execution-environment.js";
import type { HarborEnvironment } from "../../contracts/config/providers.js";
import type { AuthoredTask, RunRequest } from "../../contracts/index.js";
import {
  harborProcessEnvironment,
  harborPython,
  harborPythonPath,
} from "../../harnesses/harbor/command.js";
import { googleAccessToken } from "../../lib/google-access-token.js";
import { runCommand } from "../../lib/process.js";
import { providerEnvironment } from "../../sandbox/provider-environment.js";
import { type ImageConfig, imageConfig } from "../task/image-registry.js";
import { withHeartbeats } from "./helpers.js";
import { unpackTask } from "./remote-gate.js";

const EXPORT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const ROLES = [
  { role: "agent", context: "environment" },
  { role: "verifier", context: "tests" },
] as const;

export interface ExportTaskImagesInput {
  readonly run: RunRequest;
  readonly task: AuthoredTask;
}

/**
 * The accepted task with its verified images exported, when this deployment has a task image
 * repository and the task was verified on Modal; otherwise the task as it is. Runs with the run's
 * own Modal credentials, which can read the images its verification built.
 */
export async function exportAcceptedTask(
  store: ArtifactStore,
  environment: HarborEnvironment,
  task: AuthoredTask,
  repository: string | undefined,
): Promise<AuthoredTask> {
  if (!repository || environment !== "modal" || !task.images || task.images.registry) return task;
  return await withHeartbeats(`exporting ${task.taskId}'s images`, (signal) =>
    exportTaskImages(store, task, {
      repository,
      env: harborProcessEnvironment(providerEnvironment(executionEnvironment(), environment)),
      token: googleAccessToken,
      signal,
    }),
  );
}

export interface TaskImageExportOptions {
  /** `<region>-docker.pkg.dev/<project>/<repository>` */
  readonly repository: string;
  /** The Harbor process environment with the Modal credentials that verified the task. */
  readonly env: NodeJS.ProcessEnv;
  /** An access token that may push to the repository. */
  readonly token: () => Promise<string>;
  readonly signal: AbortSignal;
  readonly command?: typeof runCommand;
  readonly registryApi?: string;
  readonly configFor?: (image: string) => Promise<ImageConfig>;
}

/**
 * Exports the Modal images an accepted task's verification ran on into SelfBench's task image
 * repository (see runtime/selfbench_export.py), and returns the task with them by digest beside
 * its Modal pins. A task without pins, or already exported, is returned as it is.
 */
export async function exportTaskImages(
  store: ArtifactStore,
  task: AuthoredTask,
  options: TaskImageExportOptions,
): Promise<AuthoredTask> {
  const images = task.images;
  if (!images || images.registry) return task;
  const command = options.command ?? runCommand;
  const root = await mkdtemp(join(tmpdir(), `selfbench-export-${task.taskId}-`));
  try {
    const directory = await unpackTask(store, task.bundle, root, options.signal);
    const python = await harborPython(options.env);
    const [host, ...path] = options.repository.split("/");
    const name = imageName(task.taskId);
    const exported: Partial<Record<"agent" | "verifier", string>> = {};
    for (const { role, context } of ROLES) {
      const pin = images[role];
      if (!pin) continue;
      const dockerfile = await readFile(join(directory, context, "Dockerfile"), "utf8");
      const config = await dockerfileImageConfig(dockerfile, options.configFor ?? imageConfig);
      const result = await command(
        python,
        [join(harborPythonPath(), "selfbench_export.py"), pin, name],
        {
          env: {
            ...options.env,
            SELFBENCH_EXPORT_REGISTRY:
              options.registryApi ?? `https://${host}/v2/${path.join("/")}`,
            SELFBENCH_EXPORT_TOKEN: await options.token(),
            SELFBENCH_EXPORT_CONFIG: JSON.stringify(config),
          },
          timeoutMs: EXPORT_TIMEOUT_MS,
          signal: options.signal,
        },
      );
      const digest = result.stdout.trim().split("\n").at(-1) ?? "";
      if (!/^sha256:[0-9a-f]{64}$/.test(digest))
        throw new Error(`exporting ${task.taskId}'s ${role} image printed no digest`);
      exported[role] = `${options.repository}/${name}@${digest}`;
    }
    if (!exported.agent) throw new Error(`${task.taskId} has no agent image to export`);
    return {
      ...task,
      images: {
        ...images,
        registry: {
          agent: exported.agent,
          ...(exported.verifier ? { verifier: exported.verifier } : {}),
        },
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The config a Dockerfile leaves its image with: its base image's, then each ENV, USER and
 * WORKDIR in order. A Modal sandbox's own environment carries Modal's variables too, so the
 * exported image takes its config from here rather than from the running image.
 */
export async function dockerfileImageConfig(
  dockerfile: string,
  baseConfig: (image: string) => Promise<ImageConfig>,
): Promise<{ Env: string[]; User?: string; WorkingDir?: string }> {
  const lines = dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const from = lines.map((line) => /^\s*FROM\s+(\S+)/i.exec(line)?.[1]).find(Boolean);
  if (!from) throw new Error("the Dockerfile names no base image");
  const base = await baseConfig(from);
  const env = new Map(
    (base.Env ?? []).map((entry) => [
      entry.slice(0, entry.indexOf("=")),
      entry.slice(entry.indexOf("=") + 1),
    ]),
  );
  let user = base.User;
  let workdir = base.WorkingDir;
  for (const line of lines) {
    const match = /^\s*(ENV|USER|WORKDIR)\s+(.+?)\s*$/i.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const [instruction, rest] = [match[1].toUpperCase(), match[2]];
    if (instruction === "USER") user = rest;
    else if (instruction === "WORKDIR") workdir = rest;
    else if (!/^\S+=/.test(rest)) {
      const [key, ...value] = rest.split(/\s+/);
      if (key) env.set(key, expand(value.join(" "), env));
    } else {
      for (const pair of rest.matchAll(/([^\s=]+)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g)) {
        const [, key, raw = ""] = pair;
        if (key) env.set(key, unquote(raw, env));
      }
    }
  }
  return {
    Env: [...env].map(([key, value]) => `${key}=${value}`),
    ...(user ? { User: user } : {}),
    ...(workdir ? { WorkingDir: workdir } : {}),
  };
}

function unquote(raw: string, env: ReadonlyMap<string, string>): string {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('"')) return expand(JSON.parse(raw) as string, env);
  return expand(raw, env);
}

/** Docker's `$NAME` and `${NAME}` substitution against the environment so far. */
function expand(value: string, env: ReadonlyMap<string, string>): string {
  return value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_, braced: string | undefined, bare: string | undefined) =>
      env.get(braced ?? bare ?? "") ?? "",
  );
}

/** A task id as an image name: lowercase letters and digits, joined by single dashes. */
function imageName(taskId: string): string {
  return (
    taskId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 128)
      .replace(/^-+|-+$/g, "") || "task"
  );
}
