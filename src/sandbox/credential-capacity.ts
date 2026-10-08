import { randomUUID } from "node:crypto";
import type { EncryptedRecordStore } from "../db/encrypted-records.js";
import { RecordStoreError } from "../db/encrypted-records.js";
import { SandboxCapacityError, type SandboxExecutor } from "./contracts.js";

interface Reservation {
  id: string;
  expiresAt: number;
}

/** Shared across workers and batches; expired leases recover slots after a worker dies. */
export function credentialCapacity(
  records: EncryptedRecordStore,
  credentialId: string,
  limit: number,
) {
  const path = `sandbox-capacity/${credentialId}`;
  const update = async (change: (leases: Reservation[]) => Reservation[]) => {
    for (;;) {
      const saved = await records.read<Reservation[]>(path);
      const leases = (saved?.value ?? []).filter((lease) => lease.expiresAt > Date.now());
      const next = change(leases);
      try {
        await records.write(path, next, saved?.version ?? 0);
        return;
      } catch (error) {
        if (!(error instanceof RecordStoreError) || error.status !== 409) throw error;
      }
    }
  };
  return {
    async acquire(timeoutMs: number): Promise<string> {
      const id = randomUUID();
      await update((leases) => {
        if (leases.length >= limit)
          throw new SandboxCapacityError(`Credential sandbox limit (${limit}) reached`);
        return [...leases, { id, expiresAt: Date.now() + timeoutMs }];
      });
      return id;
    },
    async release(id: string) {
      await update((leases) => leases.filter((lease) => lease.id !== id));
    },
  };
}

export type CredentialCapacity = ReturnType<typeof credentialCapacity>;

/** Detached sandboxes retain their lease across activity completion and worker restarts. */
export function capacityLimitedSandbox(
  sandbox: SandboxExecutor,
  capacity: CredentialCapacity,
): SandboxExecutor {
  return {
    async run(request, options) {
      const id = await capacity.acquire(request.timeoutMs + 120_000);
      // A failed request may have failed teardown too. Keep its lease until the provider's
      // deadline rather than admit another sandbox while the old one might still be alive.
      const result = await sandbox.run(request, options);
      await capacity.release(id);
      return result;
    },
    async start(request, secretsFor) {
      // Allow creation to finish before the provider's timeout begins.
      const id = await capacity.acquire(request.timeoutMs + 120_000);
      try {
        return {
          ...(await sandbox.start(
            request,
            secretsFor ? (started) => secretsFor({ ...started, capacityLeaseId: id }) : undefined,
          )),
          capacityLeaseId: id,
        };
      } catch (error) {
        // Capacity refusal guarantees no allocation; other failures can leave an orphan.
        if (error instanceof SandboxCapacityError) await capacity.release(id);
        throw error;
      }
    },
    async stop(started, usage) {
      await sandbox.stop(started, usage);
      if (started.capacityLeaseId) await capacity.release(started.capacityLeaseId);
    },
    close: () => sandbox.close(),
  };
}
