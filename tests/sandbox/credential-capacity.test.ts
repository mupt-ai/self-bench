import { expect, test } from "bun:test";
import { ApplicationFailure } from "@temporalio/common";
import { orgRecords } from "../../src/db/encrypted-records.js";
import { readSandboxGrant, signSandboxGrant } from "../../src/sandbox/callback-grant.js";
import { withCredentialCapacity } from "../../src/sandbox/capacity-wait.js";
import {
  SandboxCapacityError,
  type SandboxExecutor,
  type StartedSandbox,
} from "../../src/sandbox/contracts.js";
import {
  capacityLimitedSandbox,
  credentialCapacity,
} from "../../src/sandbox/credential-capacity.js";
import { MemoryRecords } from "../support/evaluation-vault.js";

const request = { runId: "batch-test", stage: "discover", command: ["true"], timeoutMs: 60_000 };

// Independent executor objects represent activities in different workers; the shared record
// store enforces admission, not the fake provider. Regressions release the slot at start return
// or strip the lease from the signed callback, allowing a second sandbox or leaking capacity.
test("detached sandboxes share credential capacity until stop, including signed callbacks", async () => {
  const records = new MemoryRecords();
  const provider: SandboxExecutor = {
    async start(_request, secretsFor) {
      const started: StartedSandbox = {
        sandboxId: crypto.randomUUID(),
        stage: "discover",
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      if (secretsFor) secretsFor(started);
      return started;
    },
    async run() {
      throw new Error("not used");
    },
    async stop() {},
    close() {},
  };
  const executor = () =>
    capacityLimitedSandbox(provider, credentialCapacity(orgRecords(records, 1), "e2b-key", 2));
  let callbackToken = "";
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      executor().start(request, (sandbox) => {
        callbackToken = signSandboxGrant(
          { taskToken: "token", prefix: "runs/test", sandbox, expiresAt: Date.now() + 60_000 },
          "secret",
        );
        return {};
      }),
    ),
  );
  const started = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  expect(started).toHaveLength(2);
  for (const r of results)
    if (r.status === "rejected") expect(r.reason).toBeInstanceOf(SandboxCapacityError);
  const callback = readSandboxGrant(callbackToken, "secret");
  expect(callback?.sandbox.capacityLeaseId).toBeDefined();
  if (!callback) throw new Error("Missing callback grant");
  await executor().stop(callback.sandbox);
  await executor().start(request);
  await expect(executor().start(request)).rejects.toBeInstanceOf(SandboxCapacityError);
  await executor().stop(callback.sandbox); // duplicate callback must not free another sandbox
  await expect(executor().start(request)).rejects.toBeInstanceOf(SandboxCapacityError);
  const other = started.find((s) => s.sandboxId !== callback.sandbox.sandboxId);
  if (!other) throw new Error("Missing second sandbox");
  await executor().stop(other);
  await executor().start(request);
});

test("credential reservations recover expiration, isolate organizations, and share with Harbor admission", async () => {
  const records = new MemoryRecords();
  const capacity = credentialCapacity(orgRecords(records, 1), "key", 1);
  const lease = await capacity.acquire(60_000);
  await expect(
    credentialCapacity(orgRecords(records, 1), "key", 1).acquire(60_000),
  ).rejects.toBeInstanceOf(SandboxCapacityError);
  await credentialCapacity(orgRecords(records, 2), "key", 1).acquire(60_000);
  await capacity.release(lease);
  await capacity.acquire(-1); // expired worker reservation
  let entered = false;
  const harbor = withCredentialCapacity(capacity, 60_000, async () => {
    entered = true;
    await expect(capacity.acquire(60_000)).rejects.toBeInstanceOf(SandboxCapacityError);
    throw new Error("Harbor failed");
  });
  await expect(harbor).rejects.toThrow("Harbor failed");
  expect(entered).toBe(true);
  await capacity.acquire(60_000); // failed Harbor action released its slot
  entered = false;
  const waiting = withCredentialCapacity(capacity, 60_000, async () => {
    entered = true;
  });
  await expect(waiting).rejects.toMatchObject({
    type: SandboxCapacityError.type,
    nonRetryable: true,
  });
  await expect(waiting).rejects.toBeInstanceOf(ApplicationFailure);
  expect(entered).toBe(false);
  await expect(capacity.acquire(60_000)).rejects.toBeInstanceOf(SandboxCapacityError);
});
