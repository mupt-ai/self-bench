import { expect, test } from "bun:test";
import { migrateExecutionBundle } from "../maintenance/backfill-execution-bundles.js";
import type { ArtifactStore } from "../src/artifacts/index.js";

const registry = { agent: "agent", verifier: "verifier" };
const task = {
  id: 1,
  runId: "old-run",
  taskId: "task-1",
  bundleKey: "runs/old-run/compile/harbor-task.tar.gz",
  images: { provider: "modal" as const, agent: "im-agent", verifier: "im-verifier", registry },
};
const bundle = { uri: `gs://bucket/${task.bundleKey}`, sha256: "a".repeat(64), sizeBytes: 100 };

test("already exported images need neither provider credentials nor re-export", async () => {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected re-export");
  };
  const result = await migrateExecutionBundle(
    { stat: async () => bundle } as unknown as ArtifactStore,
    task,
    {
      apply: true,
      repository: "registry",
      environment: unexpected,
      exportImages: unexpected,
      publish: async (_store, input) => ({
        ...input,
        bundle: {
          ...bundle,
          uri: "gs://bucket/runs/old-run/execution-task.tar.gz",
          contentType: "application/gzip",
        },
      }),
      save: async () => true,
    },
  );
  expect(result.status).toBe("migrated");
});

test("concurrent row changes are not overwritten", async () => {
  await expect(
    migrateExecutionBundle({ stat: async () => bundle } as unknown as ArtifactStore, task, {
      apply: true,
      repository: "registry",
      environment: async () => ({}),
      publish: async (_store, input) => ({
        ...input,
        bundle: {
          ...bundle,
          uri: "gs://bucket/runs/old-run/execution-task.tar.gz",
          contentType: "application/gzip",
        },
      }),
      save: async () => false,
    }),
  ).rejects.toThrow("Task changed during migration");
});
