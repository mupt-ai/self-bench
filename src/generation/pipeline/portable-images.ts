import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { AuthoredTask } from "../../contracts/index.js";
import { harborPython, harborPythonPath } from "../../harnesses/harbor/command.js";
import { authoredImageBuildFailure } from "../../harnesses/harbor/image-build.js";

import { googleAccessToken } from "../../lib/google-access-token.js";
import { runCommand } from "../../lib/process.js";
import { imageConfig } from "../task/image-registry.js";
import { unpackTask } from "./remote-gate.js";
import { dockerfileImageConfig } from "./task-image-export.js";

export class PortableImageBuildError extends Error {}

/**
 * The dedicated builder account, then the managed offering's Modal account, then the worker's own.
 * Each pair is taken whole, so an ID and a secret never come from different accounts.
 */
function builderToken(base: NodeJS.ProcessEnv) {
  for (const [id, secret, environment] of [
    [
      "SELFBENCH_TASK_IMAGE_BUILDER_MODAL_TOKEN_ID",
      "SELFBENCH_TASK_IMAGE_BUILDER_MODAL_TOKEN_SECRET",
      "SELFBENCH_TASK_IMAGE_BUILDER_MODAL_ENVIRONMENT",
    ],
    [
      "SELFBENCH_MANAGED_MODAL_TOKEN_ID",
      "SELFBENCH_MANAGED_MODAL_TOKEN_SECRET",
      "SELFBENCH_MANAGED_MODAL_ENVIRONMENT",
    ],
    ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_ENVIRONMENT"],
  ] as const) {
    if (base[id]?.trim() && base[secret]?.trim())
      return { id: base[id]?.trim(), secret: base[secret]?.trim(), environment: base[environment] };
  }
  return {};
}

/** Deployments without a builder keep verifying source builds rather than failing every task. */
export function portableBuilderConfigured(base: NodeJS.ProcessEnv): boolean {
  const { id, secret } = builderToken(base);
  return !!id && !!secret;
}

/** The builder is deployment infrastructure, never the run's chosen verification account. */
export function portableBuilderEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { id, secret, environment } = builderToken(base);
  if (!id || !secret)
    throw new Error("Portable task images require a configured Modal image builder.");
  return {
    PATH: base.PATH,
    HOME: base.HOME,
    PYTHONPATH: harborPythonPath(),
    MODAL_TOKEN_ID: id,
    MODAL_TOKEN_SECRET: secret,
    ...(environment ? { MODAL_ENVIRONMENT: environment } : {}),
  };
}

/** Build portable images first; verification must run these digests, not a second source build. */
export async function preparePortableImages(
  store: ArtifactStore,
  task: AuthoredTask,
  repository: string,
  signal: AbortSignal,
  options: {
    env?: NodeJS.ProcessEnv;
    command?: typeof runCommand;
    token?: () => Promise<string>;
    configFor?: typeof imageConfig;
  } = {},
): Promise<AuthoredTask> {
  if (task.images?.registry?.verifier) return task;
  const env = portableBuilderEnvironment(options.env ?? process.env);
  const command = options.command ?? runCommand;
  const root = await mkdtemp(join(tmpdir(), "selfbench-portable-images-"));
  const tokenFile = join(root, "registry-token");
  const refresh = async () => {
    await writeFile(`${tokenFile}.new`, await (options.token ?? googleAccessToken)(), {
      mode: 0o600,
    });
    await rename(`${tokenFile}.new`, tokenFile);
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await refresh();
    timer = setInterval(() => void refresh().catch(() => {}), 10 * 60_000);
    await mkdir(join(root, "source"));
    const directory = await unpackTask(store, task.bundle, join(root, "source"), signal);
    const python = await harborPython(env);
    const name = `task-${task.bundle.sha256}`;
    const [host, ...path] = repository.split("/");
    const images: string[] = [];
    for (const context of ["environment", "tests"]) {
      signal.throwIfAborted();
      const dockerfile = await readFile(join(directory, context, "Dockerfile"), "utf8");
      const config = await dockerfileImageConfig(dockerfile, options.configFor ?? imageConfig);
      const result = await command(
        python,
        [join(harborPythonPath(), "selfbench_build_export.py"), join(directory, context), name],
        {
          env: {
            ...env,
            SELFBENCH_EXPORT_REGISTRY: `https://${host}/v2/${path.join("/")}`,
            SELFBENCH_EXPORT_TOKEN_FILE: tokenFile,
            SELFBENCH_EXPORT_CONFIG: JSON.stringify(config),
          },
          timeoutMs: 2 * 60 * 60_000,
          signal,
        },
      ).catch(async (error: unknown) => {
        signal.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        const authored = await authoredImageBuildFailure(message, env, signal);
        if (authored) throw new PortableImageBuildError(authored);
        throw error;
      });
      const digest = result.stdout.trim().split("\n").at(-1) ?? "";
      if (!/^sha256:[a-f0-9]{64}$/.test(digest))
        throw new Error(`No ${context} image digest returned`);
      images.push(`${repository}/${name}@${digest}`);
    }
    const [agent, verifier] = images;
    if (!agent || !verifier) throw new Error("Both portable task images are required");
    return { ...task, images: { provider: "oci", registry: { agent, verifier } } };
  } finally {
    if (timer) clearInterval(timer);
    await rm(root, { recursive: true, force: true });
  }
}
