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

/** The builder is deployment infrastructure, never the run's chosen verification account. */
export function portableBuilderEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const id = base.SELFBENCH_MANAGED_MODAL_TOKEN_ID || base.MODAL_TOKEN_ID;
  const secret = base.SELFBENCH_MANAGED_MODAL_TOKEN_SECRET || base.MODAL_TOKEN_SECRET;
  if (!id || !secret)
    throw new Error("Portable task images require a configured Modal image builder.");
  return {
    PATH: base.PATH,
    HOME: base.HOME,
    PYTHONPATH: harborPythonPath(),
    MODAL_TOKEN_ID: id,
    MODAL_TOKEN_SECRET: secret,
    ...(base.SELFBENCH_MANAGED_MODAL_ENVIRONMENT
      ? { MODAL_ENVIRONMENT: base.SELFBENCH_MANAGED_MODAL_ENVIRONMENT }
      : {}),
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
