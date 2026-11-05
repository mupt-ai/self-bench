import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PullRequestCandidate, ScenarioCandidate } from "../contracts/index.js";
import { compileHarborTask } from "../generation/task/compiler.js";
import { pinBaseImages } from "../generation/task/dockerfile.js";
import type { RegistryOptions } from "../generation/task/image-registry.js";
import type { TaskIdentity } from "../generation/task/render.js";
import {
  WORKSPACE_DIRECTORY,
  workspaceProblems,
  workspaceRepository,
} from "../generation/task/scenario-workspace.js";
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

/** What the compiler needs of the candidate: its tier, and where its snapshot comes from. */
export type CompileCandidate =
  | (Pick<PullRequestCandidate, "sourcePr" | "baseCommit" | "difficulty"> & {
      readonly kind?: "pull_request";
    })
  | Pick<ScenarioCandidate, "kind" | "title" | "difficulty" | "baseCommit">;

export interface SubmissionCompileInput {
  readonly repositoryUrl: string;
  /** Where the submission bundle was unpacked. */
  readonly directory: string;
  readonly taskId: string;
  readonly candidate: CompileCandidate;
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
 * over the repository cloned at the candidate's base commit (a PR's or a repository scenario's),
 * or over a workspace scenario's workspace. What the author must fix comes back as errors; a clone
 * or registry that fails throws, for the caller to retry.
 */
export async function compileSubmission(
  input: SubmissionCompileInput,
  services: TaskCompilerServices = defaultCompilerServices,
): Promise<SubmissionCompileResult> {
  const { candidate } = input;
  const scenario = candidate.kind === "scenario";
  const workspaceScenario = scenario && !candidate.baseCommit;
  const submission = await readSubmission(input.directory);
  const check = checkSubmission(
    submission,
    candidate.difficulty,
    scenario ? "scenario" : "pull_request",
  );
  const workspace = join(input.directory, WORKSPACE_DIRECTORY);
  const errors = [
    ...check.errors,
    ...(workspaceScenario ? await workspaceProblems(workspace) : []),
  ];
  if (errors.length > 0) return { compileErrors: errors, auditBlockers: [] };
  const signal = input.signal ? { signal: input.signal } : {};
  const pinned = await pinBaseImages(submission.Dockerfile, { ...services.registry, ...signal });
  if (pinned.problems.length > 0) {
    return { compileErrors: pinned.problems, auditBlockers: check.blockers };
  }
  const repo = githubRepository(input.repositoryUrl);
  const bundle = await withTemporaryDirectory(
    `selfbench-compile-${input.taskId}-`,
    async (root) => {
      const repository = join(root, "repository");
      let task: TaskIdentity;
      let commit: string;
      const baseCommit = candidate.baseCommit;
      if (!baseCommit) {
        if (candidate.kind !== "scenario") throw new Error("a pull request needs a base commit");
        const workspaceCommit = await workspaceRepository(workspace, repository, input.signal);
        commit = workspaceCommit;
        task = {
          taskId: input.taskId,
          difficulty: check.difficulty,
          repo,
          scenario: { title: candidate.title, workspaceCommit },
        };
      } else {
        commit = baseCommit;
        task = {
          taskId: input.taskId,
          difficulty: check.difficulty,
          repo,
          ...(candidate.kind === "scenario"
            ? { scenario: { title: candidate.title, baseCommit } }
            : { baseCommit, sourcePr: candidate.sourcePr }),
        };
        await services
          .cloneRepository(input.repositoryUrl, baseCommit, repository, input.token, input.signal)
          .catch((error: unknown) => {
            throw new TaskCompilerInfrastructureError("failed to materialize source repository", {
              cause: error,
            });
          });
      }
      // The snapshot holds no Git history, as the solver gets the repository.
      const snapshot = join(root, "repo.tar.gz");
      await runCommand(
        "git",
        ["-C", repository, "archive", "--format=tar.gz", `--output=${snapshot}`, commit],
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
