import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Candidate } from "../contracts/index.js";
import { compileHarborTask } from "../generation/task/compiler.js";
import { pinBaseImages } from "../generation/task/dockerfile.js";
import type { RegistryOptions } from "../generation/task/image-registry.js";
import { checkSubmission, readSubmission } from "../generation/task/submission.js";
import { runCommand } from "../lib/process.js";
import { githubRepository } from "../third_party/github/repository.js";
import { withTemporaryDirectory } from "./temporary.js";

export class TaskCompilerInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskCompilerInfrastructureError";
  }
}

export interface TaskCompilerServices {
  cloneRepository(
    repositoryUrl: string,
    commit: string,
    destination: string,
    token?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** How base images are pinned; a test answers for the registries. */
  readonly registry?: RegistryOptions;
}

export interface SubmissionCompileInput {
  readonly repositoryUrl: string;
  /** Where the submission bundle was unpacked. */
  readonly directory: string;
  readonly taskId: string;
  readonly candidate: Pick<Candidate, "sourcePr" | "baseCommit" | "difficulty">;
  readonly token?: string;
  readonly signal?: AbortSignal;
}

export interface SubmissionCompileResult {
  readonly compileErrors: readonly string[];
  readonly auditBlockers: readonly string[];
  /** The compiled Harbor task, once the submission compiles. */
  readonly bundle?: Uint8Array;
}

/**
 * Trusted compiler: checks a submission, pins its base images, and renders it as a Harbor task
 * over the repository cloned at the candidate's base commit. What the author must fix comes back
 * as errors; a clone or registry that fails throws, for the caller to retry.
 */
export async function compileSubmission(
  input: SubmissionCompileInput,
  services: TaskCompilerServices = defaultCompilerServices,
): Promise<SubmissionCompileResult> {
  const submission = await readSubmission(input.directory);
  const check = checkSubmission(submission, input.candidate.difficulty);
  if (check.errors.length > 0) return { compileErrors: check.errors, auditBlockers: [] };
  const signal = input.signal ? { signal: input.signal } : {};
  const pinned = await pinBaseImages(submission.Dockerfile, { ...services.registry, ...signal });
  if (pinned.problems.length > 0) {
    return { compileErrors: pinned.problems, auditBlockers: check.blockers };
  }
  const task = {
    taskId: input.taskId,
    difficulty: check.difficulty,
    repo: githubRepository(input.repositoryUrl),
    baseCommit: input.candidate.baseCommit,
    sourcePr: input.candidate.sourcePr,
  };
  const bundle = await withTemporaryDirectory(
    `selfbench-compile-${input.taskId}-`,
    async (root) => {
      const repository = join(root, "repository");
      await services
        .cloneRepository(
          input.repositoryUrl,
          task.baseCommit,
          repository,
          input.token,
          input.signal,
        )
        .catch((error: unknown) => {
          throw new TaskCompilerInfrastructureError("failed to materialize source repository", {
            cause: error,
          });
        });
      // The snapshot holds no Git history, as the solver gets the repository.
      const snapshot = join(root, "repo.tar.gz");
      await runCommand(
        "git",
        ["-C", repository, "archive", "--format=tar.gz", `--output=${snapshot}`, task.baseCommit],
        signal,
      );
      const compiled = { ...submission, Dockerfile: pinned.dockerfile };
      await compileHarborTask(compiled, task, snapshot, join(root, "harbor-task"));
      const archive = join(root, "harbor-task.tar.gz");
      await runCommand("tar", ["-czf", archive, "-C", root, "harbor-task"], signal);
      return await readFile(archive);
    },
  );
  return { compileErrors: [], auditBlockers: check.blockers, bundle };
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
