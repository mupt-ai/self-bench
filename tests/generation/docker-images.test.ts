import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/local.js";
import { taskImageBuilder } from "../../src/generation/images/builder.js";
import type { runCommand } from "../../src/lib/process.js";
import { gzippedTar } from "../support/tar.js";

const REPOSITORY = "localhost:5000/selfbench-tasks";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function attempt() {
  const root = await mkdtemp(join(tmpdir(), "selfbench-docker-images-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const prefix = "runs/run-1/verify/cand/attempt-1";
  const gate = await store.put(
    `${prefix}/gate-task.tar.gz`,
    await gzippedTar({
      "harbor-task/task.toml": "[environment]\nbuild_timeout_sec = 60.0\n",
      "harbor-task/environment/Dockerfile": "FROM busybox\nCOPY repo.tar.gz /tmp/\n",
      "harbor-task/tests/Dockerfile": "FROM busybox\nCOPY repo.tar.gz /tmp/\n",
    }),
    "application/gzip",
  );
  const snapshot = await store.put(
    `${prefix}/repo.tar.gz`,
    Buffer.from("repo"),
    "application/gzip",
  );
  return { store, build: { runId: "run-1", candidateId: "cand", gate, snapshot, prefix } };
}

test("the local builder builds each context with its snapshot and pushes it by digest", async () => {
  const { store, build } = await attempt();
  const calls: string[][] = [];
  const snapshots: string[] = [];
  const command = (async (_name: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "build")
      snapshots.push(await readFile(join(args.at(-1) ?? "", "repo.tar.gz"), "utf8"));
    const role = args[1]?.includes("/agent:") ? "a" : "b";
    return {
      exitCode: 0,
      stdout: args[0] === "push" ? `latest: digest: sha256:${role.repeat(64)} size: 1` : "",
      stderr: "",
    };
  }) as unknown as typeof runCommand;
  const builder = taskImageBuilder(
    { repository: REPOSITORY, builder: { kind: "docker" } },
    { command },
  );
  const result = await builder?.build(store, build, new AbortController().signal);
  expect(result).toEqual({
    images: {
      agent: `${REPOSITORY}/run-1/cand/agent@sha256:${"a".repeat(64)}`,
      verifier: `${REPOSITORY}/run-1/cand/verifier@sha256:${"b".repeat(64)}`,
    },
  });
  expect(snapshots).toEqual(["repo", "repo"]);
  expect(calls.map((args) => args[0])).toEqual(["build", "push", "build", "push"]);
});

test("a failing Dockerfile step is the author's; a daemon failure retries", async () => {
  const { store, build } = await attempt();
  const failing = (stderr: string) =>
    (async () => ({ exitCode: 1, stdout: "", stderr })) as unknown as typeof runCommand;
  const run = (command: typeof runCommand) =>
    taskImageBuilder({ repository: REPOSITORY, builder: { kind: "docker" } }, { command })?.build(
      store,
      build,
      new AbortController().signal,
    );
  expect(
    await run(failing('process "/bin/sh -c setup.sh" did not complete successfully: exit code: 1')),
  ).toEqual({ failure: expect.stringContaining("--- agent image build ---") });
  await expect(run(failing("Cannot connect to the Docker daemon"))).rejects.toThrow(
    "docker build of the agent image failed",
  );
});
