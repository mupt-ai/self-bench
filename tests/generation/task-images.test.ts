import { expect, test } from "bun:test";
import type { ArtifactStore } from "../../src/artifacts/index.js";
import type { Vault } from "../../src/db/vault.js";
import {
  compiledBundleKey,
  exportEnvironment,
  imageAction,
  type ReviewedTask,
  reconcileTaskImages,
  removeRegistryImage,
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
const task: ReviewedTask = {
  id: 1,
  runId: "run-1",
  taskId: "task-1",
  bundleKey: compiled,
  images: { provider: "modal", agent: "im-agent", verifier: "im-verifier" },
  pipelineStatus: "accepted",
  reviewDecision: "approve",
  deletedAt: null,
};
const exportedTask: ReviewedTask = {
  ...task,
  bundleKey: delivered,
  images: { provider: "modal", agent: "im-agent", verifier: "im-verifier", registry },
};
const store = { stat: async () => bundle } as unknown as ArtifactStore;

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
    removeImage: unexpected,
    exportImages: unexpected,
    publish: unexpected,
    ...overrides,
  };
}

test("only a human review decides what happens to a task's images", () => {
  expect(imageAction(task)).toBe("export");
  expect(imageAction({ ...task, reviewDecision: null })).toBeUndefined();
  expect(imageAction({ ...task, reviewDecision: "reject" })).toBeUndefined();
  expect(imageAction({ ...task, pipelineStatus: "rejected" })).toBeUndefined();
  expect(imageAction({ ...task, images: null })).toBeUndefined();
  expect(imageAction(exportedTask)).toBeUndefined();
  expect(imageAction({ ...exportedTask, reviewDecision: null })).toBeUndefined();
  expect(imageAction({ ...exportedTask, reviewDecision: "reject" })).toBe("remove");
  expect(imageAction({ ...exportedTask, deletedAt: new Date() })).toBe("remove");
  // Exported at acceptance, before execution bundles: only publication remains.
  expect(imageAction({ ...exportedTask, bundleKey: compiled })).toBe("export");
  expect(
    imageAction({
      ...exportedTask,
      bundleKey: compiled,
      images: { provider: "modal", agent: "im-agent", registry: { agent: registry.agent } },
    }),
  ).toBeUndefined();
});

test("a dry run touches nothing", async () => {
  expect(await reconcileTaskImages({} as ArtifactStore, task, deps({ apply: false }))).toEqual({
    status: "planned",
    action: "export",
  });
});

test("an approved task is exported and published before its row switches", async () => {
  const calls: string[] = [];
  const result = await reconcileTaskImages(
    store,
    task,
    deps({
      environment: async () => {
        calls.push("credentials");
        return {};
      },
      exportImages: async (_store, input) => {
        calls.push("export");
        return {
          ...input,
          images: { provider: "modal", agent: "im-agent", verifier: "im-verifier", registry },
        };
      },
      publish: async (_store, input) => {
        calls.push("publish");
        return { ...input, bundle: { ...bundle, uri: `gs://bucket/${delivered}` } };
      },
      save: async (key, images) => {
        calls.push("save");
        expect(key).toBe(delivered);
        expect(images.registry).toEqual(registry);
        return true;
      },
    }),
  );
  expect(result).toEqual({ status: "exported", bundleKey: delivered });
  expect(calls).toEqual(["credentials", "export", "publish", "save"]);
});

test("already exported images are published without provider access", async () => {
  const result = await reconcileTaskImages(
    store,
    { ...exportedTask, bundleKey: compiled },
    deps({
      publish: async (_store, input) => ({
        ...input,
        bundle: { ...bundle, uri: `gs://bucket/${delivered}` },
      }),
      save: async () => true,
    }),
  );
  expect(result.status).toBe("exported");
});

test("failed or raced exports leave the row alone", async () => {
  let saved = false;
  await expect(
    reconcileTaskImages(
      store,
      task,
      deps({
        environment: async () => ({}),
        exportImages: async () => {
          throw new Error("image gone");
        },
        save: async () => {
          saved = true;
          return true;
        },
      }),
    ),
  ).rejects.toThrow("image gone");
  expect(saved).toBe(false);
  await expect(
    reconcileTaskImages(
      store,
      { ...exportedTask, bundleKey: compiled },
      deps({
        publish: async (_store, input) => ({
          ...input,
          bundle: { ...bundle, uri: `gs://bucket/${delivered}` },
        }),
        save: async () => false,
      }),
    ),
  ).rejects.toThrow("Task changed during export");
});

test("a rejected task's images go after its row returns to the compiled bundle", async () => {
  const calls: string[] = [];
  const result = await reconcileTaskImages(
    store,
    { ...exportedTask, reviewDecision: "reject" },
    deps({
      referenced: async (digests) => {
        expect(digests).toEqual([`sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`]);
        return false;
      },
      save: async (key, images) => {
        calls.push("save");
        expect(key).toBe(compiled);
        expect(images.registry).toBeUndefined();
        expect(images.agent).toBe("im-agent");
        return true;
      },
      removeImage: async (image) => {
        calls.push(image);
      },
    }),
  );
  expect(result).toEqual({ status: "removed", bundleKey: compiled });
  expect(calls).toEqual([registry.agent, registry.verifier, "save"]);
});

test("images a comparison or release pinned are kept", async () => {
  const result = await reconcileTaskImages(
    store,
    { ...exportedTask, deletedAt: new Date() },
    deps({ referenced: async () => true }),
  );
  expect(result.status).toBe("kept");
});

test("a failed image delete keeps the row's digests for the retry", async () => {
  let saved = false;
  await expect(
    reconcileTaskImages(
      store,
      { ...exportedTask, reviewDecision: "reject" },
      deps({
        referenced: async () => false,
        removeImage: async () => {
          throw new Error("registry answered 500");
        },
        save: async () => {
          saved = true;
          return true;
        },
      }),
    ),
  ).rejects.toThrow("registry answered 500");
  expect(saved).toBe(false);
});

test("a raced removal throws after deleting; the next review reconciles the row", async () => {
  const deleted: string[] = [];
  await expect(
    reconcileTaskImages(
      store,
      { ...exportedTask, reviewDecision: "reject" },
      deps({
        referenced: async () => false,
        removeImage: async (image) => {
          deleted.push(image);
        },
        save: async () => false,
      }),
    ),
  ).rejects.toThrow("the next review reconciles it");
  expect(deleted).toEqual([registry.agent, registry.verifier]);
});

test("the compiled bundle sits beside its execution bundle", () => {
  expect(compiledBundleKey(delivered)).toBe(compiled);
  expect(compiledBundleKey(compiled)).toBe(compiled);
});

test("image removal deletes the Artifact Registry version and tolerates a missing one", async () => {
  const requests: { url: string; method?: string; auth: string | undefined }[] = [];
  for (const status of [200, 404]) {
    await removeRegistryImage(registry.agent, async () => "token", (async (
      url: string,
      init: RequestInit,
    ) => {
      requests.push({
        url,
        ...(init.method ? { method: init.method } : {}),
        auth: (init.headers as Record<string, string>).authorization,
      });
      return new Response(null, { status });
    }) as typeof fetch);
  }
  expect(requests[0]).toEqual({
    url: `https://artifactregistry.googleapis.com/v1/projects/p/locations/us-central1/repositories/selfbench-tasks/packages/task-1/versions/sha256:${"b".repeat(64)}?force=true`,
    method: "DELETE",
    auth: "Bearer token",
  });
  await expect(
    removeRegistryImage(
      registry.agent,
      async () => "token",
      (async () => new Response(null, { status: 403 })) as unknown as typeof fetch,
    ),
  ).rejects.toThrow("answered 403");
  await expect(
    removeRegistryImage(`docker.io/library/rust@sha256:${"d".repeat(64)}`),
  ).rejects.toThrow("Not an Artifact Registry image");
});

for (const orgId of [undefined, 42]) {
  test(`provider access uses ${orgId ? "the explicit organization" : "the owner organization"}`, async () => {
    const lookups: number[] = [];
    const vault = {
      records: {
        read: async () => ({
          value: { ownerId: 7, orgId, settings: { sandbox: "e2b", sandboxCredentialId: "key" } },
        }),
      },
      credentials: {
        find: async (org: number) => {
          lookups.push(org);
          return { kind: "e2b", auth: "api-key" };
        },
        secret: async (org: number) => {
          lookups.push(org);
          return { value: "original-secret" };
        },
      },
    } as unknown as Vault;
    const environment = await exportEnvironment(vault, "run-1", "e2b", {
      PATH: "/usr/bin",
      E2B_API_KEY: "worker-secret",
      SELFBENCH_HARBOR_E2B_API_KEY: "worker-override",
    });
    expect(lookups).toEqual([orgId ?? 7, orgId ?? 7]);
    expect(environment.E2B_API_KEY).toBe("original-secret");
    expect(environment.SELFBENCH_HARBOR_E2B_API_KEY).toBeUndefined();
  });
}
