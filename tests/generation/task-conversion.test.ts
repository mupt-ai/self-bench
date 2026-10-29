import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import type { TaskImages } from "../../src/contracts/index.js";
import { notRunGates } from "../../src/generation/pipeline/harbor-gates.js";
import { submittedDraft } from "../../src/generation/tasks/revision.js";
import { convertTask } from "../../src/generation/tasks/task-conversion.js";
import type { RebuildDependencies } from "../../src/generation/tasks/task-image-rebuild.js";
import type { ReviewedTask } from "../../src/generation/tasks/task-images.js";
import { goldPatch, testPatch } from "../support/submission-fixture.js";
import { gzippedTar, tarEntries } from "../support/tar.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const attempt = "runs/run-1/verify/cand/authoring-round-1/compile/attempt-1";
const images: TaskImages = {
  agent: `us-central1-docker.pkg.dev/p/selfbench-tasks/run-1/cand/agent@sha256:${"a".repeat(64)}`,
  verifier: `us-central1-docker.pkg.dev/p/selfbench-tasks/run-1/cand/verifier@sha256:${"b".repeat(64)}`,
};
const task: ReviewedTask = {
  id: 7,
  runId: "run-1",
  candidateId: "cand",
  taskId: "task",
  pipelineStatus: "accepted",
  bundleKey: `${attempt}/harbor-task.tar.gz`,
  images: null,
  reviewDecision: "approve",
  deletedAt: null,
};
const definition = {
  difficulty: "easy",
  repo: "example/repo",
  baseCommit: "a".repeat(40),
  sourcePr: 1,
  workdir: ".",
  testCommand: "bun test {tests}",
  failToPass: ["tests/feature.test.ts"],
  passToPass: [],
  environment: {
    baseImage: `oven/bun:1@sha256:${"c".repeat(64)}`,
    rootSetupCommand: "apt-get update && apt-get install -y git procps",
    setupCommand: "bun install --frozen-lockfile",
    smokeCommand: "bun --version",
    environmentVariables: { CI: "1" },
    services: [] as unknown[],
  },
};

/** A task compiled from definition.json: its full bundle, and no gate task beside it. */
async function legacy(environment = definition.environment) {
  const root = await mkdtemp(join(tmpdir(), "selfbench-conversion-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const files = {
    "harbor-task/definition.json": JSON.stringify({ ...definition, environment }),
    "harbor-task/instruction.md": "Implement the feature.\n",
    "harbor-task/task.toml": 'schema_version = "1.4"\n',
    "harbor-task/tests/test.sh": "test",
    "harbor-task/tests/test.patch": testPatch,
    "harbor-task/solution/solve.sh": "solve",
    "harbor-task/solution/gold.patch": goldPatch,
    "harbor-task/environment/Dockerfile": "FROM base\nCOPY repo.tar.gz /tmp/\n",
    "harbor-task/tests/Dockerfile": "FROM base\nCOPY repo.tar.gz /tmp/\n",
    "harbor-task/environment/repo.tar.gz": "repo",
    "harbor-task/tests/repo.tar.gz": "repo",
  };
  await store.put(`${attempt}/harbor-task.tar.gz`, await gzippedTar(files), "application/gzip");
  return store;
}

function deps() {
  const saved: { bundleKey: string; recorded: TaskImages }[] = [];
  const builds: unknown[] = [];
  const value: RebuildDependencies = {
    builder: { build: async () => ({ images }) },
    verification: { provider: "e2b", env: {}, orgId: 1, credentialId: "c" },
    serving: { env: {} },
    save: async (bundleKey, recorded) => {
      saved.push({ bundleKey, recorded });
      return true;
    },
    discardImages: async () => {},
    signal: new AbortController().signal,
    now: () => new Date("2026-10-28T00:00:00Z"),
    gates: async (_store, _task, _provider, _prefix, _signal, built) => {
      builds.push(built?.build);
      const gates = notRunGates();
      for (const name of ["build", "smoke", "nop", "oracle"] as const) gates[name].ok = true;
      return { ...gates, images };
    },
  };
  return { value, saved, builds };
}

test("a legacy task is compiled from native files and takes them once its gates pass", async () => {
  const store = await legacy();
  const { value, saved, builds } = deps();
  expect(await convertTask(store, task, value)).toMatchObject({ status: "rebuilt", images });

  const directory = "runs/run-1/conversion/cand/2026-10-28T00-00-00-000Z";
  expect(builds).toMatchObject([
    { runId: "run-1", candidateId: "cand", prefix: expect.any(String) },
  ]);
  expect(saved).toEqual([
    {
      bundleKey: expect.stringMatching(
        new RegExp(`^${directory}/execution-[0-9a-f]+/execution-task.tar.gz$`),
      ),
      recorded: images,
    },
  ]);
  const compiled = await tarEntries(
    Buffer.from((await store.getByKey(`${directory}/harbor-task.tar.gz`)) ?? []),
  );
  const file = (path: string) => compiled.find((entry) => entry.path === path)?.text ?? "";
  expect(file("harbor-task/environment/Dockerfile")).toStartWith(
    `FROM ${definition.environment.baseImage}\nRUN ["/bin/sh","-eu","-c","apt-get update`,
  );
  expect(file("harbor-task/tests/run-tests.sh")).toContain(
    "fail-to-pass) bun test 'tests/feature.test.ts' ;;",
  );
  expect(compiled.some((entry) => entry.path.endsWith("definition.json"))).toBe(false);
  // The snapshot is shared, not stored again.
  expect(await store.stat(`${directory}/repo.tar.gz`)).toBeUndefined();
  expect(await store.stat(`${directory}/repo.json`)).toBeDefined();

  // A revision of the converted task starts from its native files.
  const bundleKey = saved[0]?.bundleKey;
  const draft = await submittedDraft(store, { ...task, bundleKey: bundleKey ?? "" });
  if (!draft) throw new Error("The converted task has no draft");
  const source = await tarEntries(Buffer.from(await store.get(draft.sourceBundle)));
  expect(source.map((entry) => entry.path.replace(/^\.\//, "")).sort()).toEqual([
    "Dockerfile",
    "gold.patch",
    "instruction.md",
    "run-tests.sh",
    "smoke.sh",
    "test.patch",
  ]);
});

test("a task with services is left for an author, and nothing is built", async () => {
  const store = await legacy({ ...definition.environment, services: [{ name: "postgres" }] });
  const { value, saved, builds } = deps();
  expect(await convertTask(store, task, value)).toEqual({
    status: "unconvertible",
    reason: "it declares services, which now run inside its image (services.sh)",
  });
  expect(saved).toEqual([]);
  expect(builds).toEqual([]);
});
