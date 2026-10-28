import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import type { TaskStore } from "../../src/db/tasks.js";
import { createTaskActivities } from "../../src/generation/tasks/activities.js";
import { gzippedTar, tarEntries } from "../support/tar.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("an accepted task with images settles onto its execution bundle, with no approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfbench-accepted-images-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const attempt = "runs/run-1/verify/cand/authoring-round-1/compile/attempt-1";
  const files = {
    "harbor-task/instruction.md": "Fix it.\n",
    "harbor-task/task.toml": 'schema_version = "1.4"\n',
    "harbor-task/tests/test.sh": "test",
    "harbor-task/tests/test.patch": "hidden",
    "harbor-task/solution/solve.sh": "solve",
    "harbor-task/solution/gold.patch": "gold",
    "harbor-task/environment/Dockerfile": "FROM base\nCOPY repo.tar.gz /tmp/\n",
    "harbor-task/tests/Dockerfile": "FROM base\nCOPY repo.tar.gz /tmp/\n",
  };
  const bundle = await store.put(
    `${attempt}/harbor-task.tar.gz`,
    await gzippedTar({ ...files, "harbor-task/environment/repo.tar.gz": "repo" }),
    "application/gzip",
  );
  await store.put(`${attempt}/gate-task.tar.gz`, await gzippedTar(files), "application/gzip");
  const sourceBundle = await store.put(
    "runs/run-1/authoring/cand/round-1/source-task.tar.gz",
    await gzippedTar({ "instruction.md": "Fix it." }),
    "application/gzip",
  );
  const images = {
    agent: `us-central1-docker.pkg.dev/p/selfbench-tasks/run-1/cand/agent@sha256:${"a".repeat(64)}`,
    verifier: `us-central1-docker.pkg.dev/p/selfbench-tasks/run-1/cand/verifier@sha256:${"b".repeat(64)}`,
  };
  const verdicts: unknown[] = [];
  const tasks = {
    settle: async (_runId: string, _candidateId: string, verdict: unknown) => {
      verdicts.push(verdict);
      return true;
    },
  } as unknown as TaskStore;

  await createTaskActivities({ tasks, artifacts: store }).settleTask({
    runId: "run-1",
    candidateId: "cand",
    result: {
      progress: { candidateId: "cand", taskId: "task", difficulty: "easy", status: "accepted" },
      task: {
        candidateId: "cand",
        taskId: "task",
        sourceBundle,
        bundle,
        images,
      },
    },
  });

  const [verdict] = verdicts as { bundleKey: string; images: unknown }[];
  expect(verdict).toMatchObject({ pipelineStatus: "accepted", stage: "accepted", images });
  expect(verdict?.bundleKey).toMatch(
    new RegExp(`^${attempt}/execution-[0-9a-f]+/execution-task.tar.gz$`),
  );
  const delivered = await tarEntries(
    Buffer.from((await store.getByKey(verdict?.bundleKey ?? "")) ?? []),
  );
  expect(delivered.find((entry) => entry.path === "harbor-task/environment/Dockerfile")?.text).toBe(
    `FROM ${images.agent}\n`,
  );
  expect(delivered.some((entry) => entry.path.endsWith("repo.tar.gz"))).toBe(false);
});
