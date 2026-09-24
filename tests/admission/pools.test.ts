import { expect, test } from "bun:test";
import { loadWorkerConfig } from "../../src/contracts/config/index.js";
import type { RunRequest } from "../../src/contracts/index.js";
import type { AdmissionLimits, AdmissionRequest, AdmissionStore } from "../../src/db/admissions.js";
import { createSandboxAdmission } from "../../src/generation/pipeline/admission.js";
import { sandboxPoolLimit } from "../../src/sandbox/admission.js";
import { run } from "../support/workflow-fixture.js";

test("managed accounts default to measured limits; unmanaged accounts are unlimited unless set", () => {
  expect(sandboxPoolLimit("e2b", "managed", {})).toBe(18);
  expect(sandboxPoolLimit("modal", "managed", {})).toBe(100);
  expect(sandboxPoolLimit("e2b", "managed", { SELFBENCH_MANAGED_E2B_SANDBOX_LIMIT: "95" })).toBe(
    95,
  );
  expect(sandboxPoolLimit("e2b", "deployment", {})).toBeUndefined();
  expect(sandboxPoolLimit("e2b", "deployment", { SELFBENCH_E2B_SANDBOX_LIMIT: "5" })).toBe(5);
  expect(sandboxPoolLimit("docker", "deployment", { SELFBENCH_DOCKER_SANDBOX_LIMIT: "5" })).toBe(
    undefined,
  );
  expect(sandboxPoolLimit("e2b", { credentialId: "c" }, {})).toBeUndefined();
  expect(() =>
    sandboxPoolLimit("e2b", "managed", { SELFBENCH_MANAGED_E2B_SANDBOX_LIMIT: "0" }),
  ).toThrow("positive integer");
});

test("managed agents share the platform E2B pool; Harbor uses the stamped pool and shared capacity", async () => {
  const requests: [AdmissionRequest, AdmissionLimits][] = [];
  const store = {
    acquire: async (request: AdmissionRequest, limits: AdmissionLimits) => {
      requests.push([request, limits]);
      return true;
    },
    release: async () => {},
    holders: async () => [],
    drainEnded: async () => {},
  } satisfies AdmissionStore;
  const execution = { workflowId: "w", workflowRunId: "r" };
  const admission = createSandboxAdmission(
    loadWorkerConfig({ SELFBENCH_SANDBOX_SECRET: "s".repeat(32) }),
    store,
    10,
    { SELFBENCH_ORG_HARBOR_LIMIT: "3", SELFBENCH_HARBOR_WORKERS: "2" },
  );
  const managed: RunRequest = {
    ...run,
    version: { ...run.version, executionBackend: "e2b", harborEnvironment: "modal" },
    generation: {
      ownerId: 7,
      orgId: 42,
      repoId: 1,
      settings: {
        sandbox: "managed",
        modelAccess: "managed",
        authorModel: "m",
        verifierModel: "m",
      },
    } as RunRequest["generation"],
  };
  expect(
    await admission.acquireSandboxSlot({ id: "a", run: managed, kind: "agent", ...execution }),
  ).toBe(true);
  expect(
    await admission.acquireSandboxSlot({ id: "h", run: managed, kind: "harbor", ...execution }),
  ).toBe(true);
  // Local Docker agents are never limited, but Harbor capacity is shared by everyone.
  expect(await admission.acquireSandboxSlot({ id: "d", run, kind: "agent", ...execution })).toBe(
    true,
  );
  expect(await admission.acquireSandboxSlot({ id: "dh", run, kind: "harbor", ...execution })).toBe(
    true,
  );
  const org = { agent: 12, harbor: 3 };
  expect(requests).toEqual([
    [
      { id: "a", pool: "e2b:managed", orgId: "42", kind: "agent", ...execution },
      { pool: 18, org, harbor: 30 },
    ],
    [
      { id: "h", pool: "modal:managed", orgId: "42", kind: "harbor", ...execution },
      { pool: 100, org, harbor: 30 },
    ],
    [
      { id: "dh", pool: "docker:deployment", orgId: "deployment", kind: "harbor", ...execution },
      { org, harbor: 30 },
    ],
  ]);
});
