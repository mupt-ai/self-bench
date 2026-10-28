import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/lib/process.js";
import {
  compileSubmission,
  TaskCompilerInfrastructureError,
  type TaskCompilerServices,
} from "../src/sandbox/task-compiler.js";
import { submission } from "./support/submission-fixture.js";

const roots: string[] = [];
const digest = `sha256:${"d".repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A registry that serves every tag at `digest`, and nothing named `missing`. */
const registry = {
  fetch: (async (input: string | URL | Request) =>
    String(input).includes("/missing/")
      ? new Response(null, { status: 404 })
      : new Response(null, {
          status: 200,
          headers: { "docker-content-digest": digest },
        })) as typeof fetch,
};

/** The submission's files in a directory, as the compiler program unpacks them. */
async function submitted(files = submission): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-task-compiler-"));
  roots.push(root);
  const directory = join(root, "submission");
  await mkdir(directory);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents);
  }
  return { root, directory };
}

const candidate = { sourcePr: 1, baseCommit: "a".repeat(40), difficulty: "medium" as const };

test("the trusted compiler pins the base image and compiles against the candidate's commit", async () => {
  const { root, directory } = await submitted();
  const repository = join(root, "repository");
  await mkdir(repository);
  await runCommand("git", ["init", "-q", repository]);
  await runCommand("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", repository, "config", "user.name", "Test"]);
  await writeFile(join(repository, "package.json"), "{}\n");
  await runCommand("git", ["-C", repository, "add", "."]);
  await runCommand("git", ["-C", repository, "commit", "-qm", "base"]);
  const commit = (await runCommand("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const services: TaskCompilerServices = {
    cloneRepository: async (_url, requested, destination) => {
      expect(requested).toBe(commit);
      await cp(repository, destination, { recursive: true });
    },
    registry,
  };

  const result = await compileSubmission(
    {
      repositoryUrl: "https://github.com/example/repo.git",
      directory,
      taskId: "trusted-compile",
      candidate: { ...candidate, baseCommit: commit },
    },
    services,
  );

  expect(result).toMatchObject({ compileErrors: [], auditBlockers: [] });
  const output = join(root, "output");
  await mkdir(output);
  await writeFile(join(output, "bundle.tar.gz"), result.bundle ?? new Uint8Array());
  await runCommand("tar", ["-xzf", join(output, "bundle.tar.gz"), "-C", output]);
  const task = join(output, "harbor-task");
  expect(await readFile(join(task, "environment/Dockerfile"), "utf8")).toStartWith(
    `FROM oven/bun:1@${digest}\n`,
  );
  // The gold reaches easy, the hardest tier it can up to the candidate's medium.
  expect(await readFile(join(task, "task.toml"), "utf8")).toContain('difficulty = "easy"');
  expect(await Bun.file(join(task, "environment/repo.tar.gz")).exists()).toBe(true);
});

test("the author's problems come back as errors, before anything is cloned", async () => {
  const cloneRepository = async () => {
    throw new Error("nothing should be cloned");
  };
  const incomplete = await submitted({ ...submission, "run-tests.sh": "" });
  expect(
    await compileSubmission(
      {
        repositoryUrl: "https://github.com/example/repo.git",
        directory: incomplete.directory,
        taskId: "t",
        candidate,
      },
      { cloneRepository, registry },
    ),
  ).toEqual({ compileErrors: ["run-tests.sh is missing or empty"], auditBlockers: [] });

  const unknownImage = await submitted({
    ...submission,
    Dockerfile: "FROM ghcr.io/example/missing:1\nADD repo.tar.gz /app/\n",
  });
  const { compileErrors } = await compileSubmission(
    {
      repositoryUrl: "https://github.com/example/repo.git",
      directory: unknownImage.directory,
      taskId: "t",
      candidate,
    },
    { cloneRepository, registry },
  );
  expect(compileErrors).toEqual([expect.stringContaining("ghcr.io/example/missing:1")]);
});

test("the trusted compiler classifies repository failures as infrastructure", async () => {
  const { directory } = await submitted();
  await expect(
    compileSubmission(
      {
        repositoryUrl: "https://github.com/example/repo.git",
        directory,
        taskId: "clone-failure",
        candidate,
      },
      { cloneRepository: async () => Promise.reject(new Error("network down")), registry },
    ),
  ).rejects.toBeInstanceOf(TaskCompilerInfrastructureError);
});
