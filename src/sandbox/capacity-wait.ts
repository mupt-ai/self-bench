import { ApplicationFailure } from "@temporalio/common";
import { SandboxCapacityError } from "./contracts.js";
import type { CredentialCapacity } from "./credential-capacity.js";

/** Refuse before paid work; the workflow retries admission without spending activity retries. */
export async function withCredentialCapacity<T>(
  capacity: CredentialCapacity,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  const lease = await capacity.acquire(timeoutMs).catch((error: unknown) => {
    if (!(error instanceof SandboxCapacityError)) throw error;
    throw ApplicationFailure.create({
      type: SandboxCapacityError.type,
      message: error.message,
      nonRetryable: true,
    });
  });
  try {
    return await run();
  } finally {
    await capacity.release(lease);
  }
}
