import { expect, test } from "bun:test";
import { loadWorkerConfig } from "../../src/contracts/config/index.js";
import type { RunRequest } from "../../src/contracts/index.js";
import type { AdmissionRequest, AdmissionStore } from "../../src/db/admissions.js";
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

test("managed agents share the platform E2B pool while Harbor uses the stamped Modal pool", async () => {
  const requests: AdmissionRequest[] = [];
  const store = {
    acquire: async (request: AdmissionRequest) => {
      requests.push(request);
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
  // The local Docker deployment is never limited.
  expect(await admission.acquireSandboxSlot({ id: "d", run, kind: "agent", ...execution })).toBe(
    true,
  );
  expect(requests).toEqual([
    { id: "a", pool: "e2b:managed", orgId: "42", kind: "agent", ...execution },
    { id: "h", pool: "modal:managed", orgId: "42", kind: "harbor", ...execution },
  ]);
});
