import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractRegularArchive } from "../../archive.js";
import { taskDefinitionSchema } from "../../contracts.js";
import { compileHarborTask } from "../../harbor-task.js";
import { runCommand } from "../../process.js";
import { withTemporaryDirectory } from "./runtime.js";

export class TaskCompilerInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskCompilerInfrastructureError";
  }
}

/**
 * Trusted compiler: unpacks a sandbox submission (definition.json, test.patch, gold.patch),
 * clones the pinned repository on the worker, and renders the native Harbor task bundle.
 * Models never hand-write task.toml, Dockerfiles, or scripts.
 */
export interface TaskCompilerInput {
  readonly taskId: string;
  readonly repositoryUrl: string;
  readonly definitionBytes: Uint8Array;
  readonly sourceBundle: Uint8Array;
  readonly token?: string;
  readonly signal?: AbortSignal;
}

export interface TaskCompilerServices {
  cloneRepository(
    repositoryUrl: string,
    commit: string,
    destination: string,
    token?: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export async function compileSubmittedTask(
  input: TaskCompilerInput,
  services: TaskCompilerServices = defaultCompilerServices,
): Promise<Uint8Array> {
  return await withTemporaryDirectory(`selfbench-compile-${input.taskId}-`, async (root) => {
    const authored = join(root, "authored");
    const repository = join(root, "repository");
    const output = join(root, "harbor-task");
    const archive = join(root, "source-task.tar.gz");
    await mkdir(authored);
    await writeFile(archive, input.sourceBundle);
    await extractRegularArchive(archive, authored, input.signal ? { signal: input.signal } : {});
    await writeFile(join(authored, "definition.json"), input.definitionBytes);

    const definition = taskDefinitionSchema.parse(
      JSON.parse(Buffer.from(input.definitionBytes).toString("utf8")),
    );
    await services
      .cloneRepository(
        input.repositoryUrl,
        definition.baseCommit,
        repository,
        input.token,
        input.signal,
      )
      .catch((error: unknown) => {
        throw new TaskCompilerInfrastructureError("failed to materialize source repository", {
          cause: error,
        });
      });
    await compileHarborTask(authored, repository, output);
    const bundle = join(root, "harbor-task.tar.gz");
    await runCommand(
      "tar",
      ["-czf", bundle, "-C", root, "harbor-task"],
      input.signal ? { signal: input.signal } : {},
    );
    return await readFile(bundle);
  });
}

const defaultCompilerServices: TaskCompilerServices = {
  async cloneRepository(repositoryUrl, commit, destination, token, signal): Promise<void> {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...(token ? { GH_TOKEN: token } : {}),
    };
    await withTemporaryDirectory("selfbench-git-auth-", async (root) => {
      if (token) {
        const askpass = join(root, "git-askpass.sh");
        await writeFile(
          askpass,
          '#!/bin/sh\ncase "$1" in *Username*) printf x-access-token;; *) printf %s "$GH_TOKEN";; esac\n',
          { mode: 0o700 },
        );
        environment.GIT_ASKPASS = askpass;
        environment.GIT_TERMINAL_PROMPT = "0";
      }
      await runCommand(
        "git",
        ["clone", "--no-checkout", "--filter=blob:none", repositoryUrl, destination],
        { env: environment, ...(signal ? { signal } : {}) },
      );
      await runCommand("git", ["-C", destination, "fetch", "origin", commit], {
        env: environment,
        ...(signal ? { signal } : {}),
      });
      await runCommand("git", ["-C", destination, "checkout", "--detach", commit], {
        env: environment,
        ...(signal ? { signal } : {}),
      });
    });
  },
};
