import { expect, test } from "bun:test";
import type { ArtifactStore } from "../../src/artifacts/index.js";
import { registryImageExists } from "../../src/generation/tasks/task-image-registry.js";
import {
  type ReviewedTask,
  reconcileTaskImages,
  type TaskImageDependencies,
} from "../../src/generation/tasks/task-images.js";

const compiled = "runs/run-1/verify/task-1/compile/attempt-1/harbor-task.tar.gz";
const delivered = "runs/run-1/verify/task-1/compile/attempt-1/execution-abc/execution-task.tar.gz";
const bundle = { uri: `gs://bucket/${compiled}`, sha256: "a".repeat(64), sizeBytes: 100 };
const repository = "us-central1-docker.pkg.dev/p/selfbench-tasks";
const registry = {
  agent: `${repository}/task-1@sha256:${"b".repeat(64)}`,
  verifier: `${repository}/task-1@sha256:${"c".repeat(64)}`,
};
const unexported = { provider: "modal" as const, agent: "im-agent", verifier: "im-verifier" };
const exportedTask: ReviewedTask = {
  id: 1,
  runId: "run-1",
  taskId: "task-1",
  bundleKey: delivered,
  images: { ...unexported, registry },
  pipelineStatus: "accepted",
  reviewDecision: "approve",
  deletedAt: null,
};
const statted: string[] = [];
const store = {
  stat: async (key: string) => {
    statted.push(key);
    return bundle;
  },
} as unknown as ArtifactStore;

function deps(overrides: Partial<TaskImageDependencies> = {}): TaskImageDependencies {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected side effect");
  };
  return {
    apply: true,
    repository,
    environment: unexpected,
    save: unexpected,
    referenced: unexpected,
    current: async () => ({ ...exportedTask, images: unexported, bundleKey: compiled }),
    imageExists: unexpected,
    removeImage: unexpected,
    exportImages: unexpected,
    publish: unexpected,
    ...overrides,
  };
}

const freshExport = {
  environment: async () => ({}),
  exportImages: async (_store: ArtifactStore, input: { images?: unknown }) => ({
    ...input,
    images: { ...unexported, registry },
  }),
  publish: async (_store: ArtifactStore, input: object) => ({
    ...input,
    bundle: { ...bundle, uri: `gs://bucket/${delivered}` },
  }),
} as unknown as Partial<TaskImageDependencies>;

test("an approved task whose claimed images are in the registry is left alone", async () => {
  const result = await reconcileTaskImages(
    store,
    exportedTask,
    deps({ imageExists: async () => true }),
  );
  expect(result.status).toBe("skipped");
});

test("an approved task whose claimed images are gone is exported again from its compiled bundle", async () => {
  statted.length = 0;
  let exportedFrom: unknown;
  const result = await reconcileTaskImages(
    store,
    exportedTask,
    deps({
      ...freshExport,
      imageExists: async (image) => image !== registry.verifier,
      exportImages: (async (_store: ArtifactStore, input: { images?: { registry?: unknown } }) => {
        exportedFrom = input.images?.registry;
        return { ...input, images: { ...unexported, registry } };
      }) as unknown as NonNullable<TaskImageDependencies["exportImages"]>,
      save: async () => true,
    }),
  );
  expect(result).toEqual({ status: "exported", bundleKey: delivered });
  // The stale claim is dropped before exporting, and the export reads the compiled bundle.
  expect(exportedFrom).toBeUndefined();
  expect(statted).toEqual([compiled]);
  expect(
    await reconcileTaskImages(
      store,
      exportedTask,
      deps({ apply: false, imageExists: async () => false }),
    ),
  ).toEqual({ status: "planned", action: "export" });
});

test("a raced fresh export removes the images it pushed, unless something else names them", async () => {
  for (const pinned of [false, true]) {
    const removed: string[] = [];
    await expect(
      reconcileTaskImages(
        store,
        { ...exportedTask, bundleKey: compiled, images: unexported },
        deps({
          ...freshExport,
          save: async () => false,
          referenced: async (_digests, exceptTaskId) => {
            expect(exceptTaskId).toBe(exportedTask.id);
            return pinned;
          },
          removeImage: async (image) => {
            removed.push(image);
          },
        }),
      ),
    ).rejects.toThrow("Task changed during export");
    expect(removed).toEqual(pinned ? [] : [registry.agent, registry.verifier]);
  }
});

test("removal keeps images another task row still names", async () => {
  const result = await reconcileTaskImages(
    store,
    { ...exportedTask, reviewDecision: "reject" },
    deps({ referenced: async () => true }),
  );
  expect(result.status).toBe("kept");
});

test("the registry check reads the version and fails closed on other answers", async () => {
  const answer = (status: number) =>
    (async () => new Response(null, { status })) as unknown as typeof fetch;
  expect(await registryImageExists(registry.agent, async () => "t", answer(200))).toBe(true);
  expect(await registryImageExists(registry.agent, async () => "t", answer(404))).toBe(false);
  await expect(registryImageExists(registry.agent, async () => "t", answer(403))).rejects.toThrow(
    "answered 403",
  );
});

test("a cleanup never removes an image the row names by the time it runs", async () => {
  const removed: string[] = [];
  await expect(
    reconcileTaskImages(
      store,
      { ...exportedTask, bundleKey: compiled, images: unexported },
      deps({
        ...freshExport,
        save: async () => false,
        // A concurrent reconcile saved the agent image into this row meanwhile.
        current: async () => ({
          ...exportedTask,
          bundleKey: delivered,
          images: { ...unexported, registry: { agent: registry.agent } },
        }),
        referenced: async () => false,
        removeImage: async (image) => {
          removed.push(image);
        },
      }),
    ),
  ).rejects.toThrow("Task changed during export");
  expect(removed).toEqual([registry.verifier]);
});
