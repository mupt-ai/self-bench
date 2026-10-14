import { randomUUID } from "node:crypto";
import type { EncryptedRecordStore } from "../db/encrypted-records.js";
import { orgRecords, RecordStoreError } from "../db/encrypted-records.js";
import type { Vault } from "../db/vault.js";
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
    async acquire(timeoutMs: number, id: string = randomUUID()): Promise<string> {
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

/**
 * Admission under every credential's limit at once, such as a sandbox account's and the model
 * key its agent calls. One lease ID is held in each, so a started sandbox records only one.
 */
function combinedCapacity(capacities: CredentialCapacity[]): CredentialCapacity {
  return {
    async acquire(timeoutMs: number, id: string = randomUUID()): Promise<string> {
      const held: CredentialCapacity[] = [];
      try {
        for (const capacity of capacities) {
          await capacity.acquire(timeoutMs, id);
          held.push(capacity);
        }
      } catch (error) {
        await Promise.all(held.map((capacity) => capacity.release(id)));
        throw error;
      }
      return id;
    },
    async release(id: string) {
      await Promise.all(capacities.map((capacity) => capacity.release(id)));
    },
  };
}

/**
 * One admission for the organization's saved credentials among `ids`: a sandbox account, and the
 * model key or sign-in its agent calls, whose limit then carries into that sandbox. With
 * `unlimited`, credentials without a limit take leases too, so a sandbox started under a limit
 * since cleared still releases its slot; otherwise they are left out.
 */
export async function credentialsCapacity(
  vault: Pick<Vault, "credentials" | "records">,
  orgId: number,
  ids: readonly (string | undefined)[],
  unlimited = false,
): Promise<CredentialCapacity | undefined> {
  const records = orgRecords(vault.records, orgId);
  const capacities = (
    await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const credential = id ? await vault.credentials.find(orgId, id) : undefined;
        if (!id || !credential || (!credential.maxSandboxes && !unlimited)) return [];
        return [
          credentialCapacity(records, id, credential.maxSandboxes ?? Number.POSITIVE_INFINITY),
        ];
      }),
    )
  ).flat();
  if (capacities.length < 2) return capacities[0];
  return combinedCapacity(capacities);
}

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
