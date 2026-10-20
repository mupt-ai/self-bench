import { expect, test } from "bun:test";
import { exportEnvironment } from "../maintenance/backfill-execution-bundles.js";
import type { Vault } from "../src/db/vault.js";

for (const orgId of [undefined, 42]) {
  test(`historical provider access uses ${orgId ? "the explicit organization" : "the owner organization"}`, async () => {
    const lookups: number[] = [];
    const vault = {
      records: {
        read: async () => ({
          value: {
            ownerId: 7,
            orgId,
            settings: { sandbox: "e2b", sandboxCredentialId: "original-key" },
          },
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
    const environment = await exportEnvironment(vault, "old-run", "e2b", {
      PATH: "/usr/bin",
      E2B_API_KEY: "worker-secret",
      SELFBENCH_HARBOR_E2B_API_KEY: "worker-override",
    });
    expect(lookups).toEqual([orgId ?? 7, orgId ?? 7]);
    expect(environment.E2B_API_KEY).toBe("original-secret");
    expect(environment.SELFBENCH_HARBOR_E2B_API_KEY).toBeUndefined();
  });
}
