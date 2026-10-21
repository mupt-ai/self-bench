import { expect, test } from "bun:test";
import type { Vault } from "../../src/db/vault.js";
import { exportEnvironment, removeRegistryImage } from "../../src/generation/tasks/task-images.js";

const registry = {
  agent: "us-central1-docker.pkg.dev/p/selfbench-tasks/task-1@sha256:" + "b".repeat(64),
  verifier: "us-central1-docker.pkg.dev/p/selfbench-tasks/task-1@sha256:" + "c".repeat(64),
};

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
