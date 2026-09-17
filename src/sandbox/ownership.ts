/** Resource ownership is distinct from workload exit status: never recover these as success. */
export interface OwnershipFailure {
  readonly ownershipFailure: true;
  readonly supervisionError?: unknown;
}

/** Preserve diagnostics through provider wrappers, including aggregate and frozen causes. */
export function hasOwnershipFailure(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const current = pending.pop();
    if (!(current instanceof Error) || seen.has(current)) continue;
    seen.add(current);
    if (
      "cleanupError" in current ||
      ("ownershipFailure" in current && current.ownershipFailure === true)
    )
      return true;
    pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

export function supervisionFailure(
  primary: unknown,
  supervisionError: unknown,
): Error & OwnershipFailure {
  const error = new Error("Sandbox command failed with unresolved supervision", { cause: primary });
  return Object.assign(error, { ownershipFailure: true as const, supervisionError });
}
