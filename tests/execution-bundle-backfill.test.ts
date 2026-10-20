import { expect, test } from "bun:test";
import { migrateExecutionBundle } from "../maintenance/backfill-execution-bundles.js";
import type { ArtifactStore } from "../src/artifacts/index.js";

const task = {
  id: 1,
  runId: "old-run",
  taskId: "task-1",
  bundleKey: "runs/old-run/compile/harbor-task.tar.gz",
  images: { provider: "e2b" as const, agent: "template-agent", verifier: "template-verifier" },
};
const bundle = { uri: `gs://bucket/${task.bundleKey}`, sha256: "a".repeat(64), sizeBytes: 100 };
const registry = {
  agent: `registry/agent@sha256:${"b".repeat(64)}`,
  verifier: `registry/verifier@sha256:${"c".repeat(64)}`,
};
const key = "runs/old-run/compile/execution-123/execution-task.tar.gz";

test("dry run does not read bundles, resolve credentials, export or update", async () => {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected side effect");
  };
  const result = await migrateExecutionBundle({} as ArtifactStore, task, {
    apply: false,
    repository: "registry",
    environment: unexpected,
    save: unexpected,
  });
  expect(result.status).toBe("planned");
});

test("already migrated and incomplete tasks are skipped", async () => {
  const options = {
    apply: true,
    repository: "registry",
    environment: async () => ({}),
    save: async () => true,
  };
  expect(
    (await migrateExecutionBundle({} as ArtifactStore, { ...task, bundleKey: key }, options))
      .status,
  ).toBe("skipped");
  expect(
    (await migrateExecutionBundle({} as ArtifactStore, { ...task, images: null }, options)).status,
  ).toBe("skipped");
});

test("export and publication finish before the row is switched", async () => {
  const calls: string[] = [];
  const result = await migrateExecutionBundle(
    { stat: async () => bundle } as unknown as ArtifactStore,
    task,
    {
      apply: true,
      repository: "registry",
      environment: async () => {
        calls.push("credentials");
        return {};
      },
      exportImages: async (_store, input) => {
        calls.push("export");
        return { ...input, images: { ...task.images, registry } };
      },
      publish: async (_store, input) => {
        calls.push("publish");
        return {
          ...input,
          bundle: { ...bundle, uri: `gs://bucket/${key}`, contentType: "application/gzip" },
        };
      },
      save: async (savedKey, images) => {
        calls.push("save");
        expect(savedKey).toBe(key);
        expect(images.registry).toEqual(registry);
        return true;
      },
    },
  );
  expect(result.status).toBe("migrated");
  expect(calls).toEqual(["credentials", "export", "publish", "save"]);
});

test("failed exports never switch the task row", async () => {
  let saved = false;
  await expect(
    migrateExecutionBundle({ stat: async () => bundle } as unknown as ArtifactStore, task, {
      apply: true,
      repository: "registry",
      environment: async () => ({}),
      exportImages: async () => {
        throw new Error("image gone");
      },
      save: async () => {
        saved = true;
        return true;
      },
    }),
  ).rejects.toThrow("image gone");
  expect(saved).toBe(false);
});
