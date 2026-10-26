import { expect, test } from "bun:test";
import type { ArtifactStore } from "../../src/artifacts/index.js";
import {
  compiledBundleKey,
  type ReviewedTask,
  reconcileTaskImages,
  removesImages,
  type TaskImageDependencies,
} from "../../src/generation/tasks/task-images.js";

const compiled = "runs/run-1/verify/task-1/compile/attempt-1/harbor-task.tar.gz";
const delivered = "runs/run-1/verify/task-1/compile/attempt-1/execution-abc/execution-task.tar.gz";
const bundle = { uri: `gs://bucket/${compiled}`, sha256: "a".repeat(64), sizeBytes: 100 };
const repository = "us-central1-docker.pkg.dev/p/selfbench-tasks";
const images = {
  agent: `${repository}/run-1/task-1/agent@sha256:${"b".repeat(64)}`,
  verifier: `${repository}/run-1/task-1/verifier@sha256:${"c".repeat(64)}`,
};
const task: ReviewedTask = {
  id: 1,
  runId: "run-1",
  taskId: "task-1",
  bundleKey: delivered,
  images,
  reviewDecision: "reject",
  deletedAt: null,
};
const store = { stat: async () => bundle } as unknown as ArtifactStore;

function deps(overrides: Partial<TaskImageDependencies> = {}): TaskImageDependencies {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected side effect");
  };
  return { save: unexpected, referenced: unexpected, removeImage: unexpected, ...overrides };
}

test("only a rejection or deletion gives up a task's images", () => {
  expect(removesImages(task)).toBe(true);
  expect(removesImages({ ...task, reviewDecision: null, deletedAt: new Date() })).toBe(true);
  expect(removesImages({ ...task, reviewDecision: "approve" })).toBe(false);
  expect(removesImages({ ...task, reviewDecision: null })).toBe(false);
  expect(removesImages({ ...task, images: null })).toBe(false);
});

test("a rejected task's images go before its row returns to the compiled bundle", async () => {
  const steps: string[] = [];
  const outcome = await reconcileTaskImages(
    store,
    task,
    deps({
      referenced: async (digests, except) => {
        expect(digests).toEqual([`sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`]);
        expect(except).toBe(1);
        return false;
      },
      removeImage: async (image) => {
        steps.push(`remove ${image}`);
      },
      save: async (bundleKey) => {
        steps.push(`save ${bundleKey}`);
        return true;
      },
    }),
  );
  expect(outcome).toEqual({ status: "removed", bundleKey: compiled });
  expect(steps).toEqual([
    `remove ${images.agent}`,
    `remove ${images.verifier}`,
    `save ${compiled}`,
  ]);
});

test("pinned images stay; a failed or raced removal throws for the next review", async () => {
  expect(await reconcileTaskImages(store, task, deps({ referenced: async () => true }))).toEqual({
    status: "kept",
    reason: "A comparison, a release or another task pins these images",
  });
  const saves: string[] = [];
  await expect(
    reconcileTaskImages(
      store,
      task,
      deps({
        referenced: async () => false,
        removeImage: async () => {
          throw new Error("Artifact Registry answered 503");
        },
        save: async (key) => {
          saves.push(key);
          return true;
        },
      }),
    ),
  ).rejects.toThrow("503");
  // The row still names the images, so the retry deletes them again.
  expect(saves).toEqual([]);
  await expect(
    reconcileTaskImages(
      store,
      task,
      deps({ referenced: async () => false, removeImage: async () => {}, save: async () => false }),
    ),
  ).rejects.toThrow("Task changed during removal");
  expect(await reconcileTaskImages(store, { ...task, reviewDecision: "approve" }, deps())).toEqual({
    status: "skipped",
    reason: "Nothing to change for this review",
  });
});

test("the compiled bundle sits beside its execution bundle", () => {
  expect(compiledBundleKey(delivered)).toBe(compiled);
  expect(compiledBundleKey(compiled)).toBe(compiled);
});
