/**
 * In-process ownership evidence. Providers may preserve SDK-specific causes and messages, but
 * every ownership failure must expose one of these markers before recovery can classify it.
 */
type OwnershipEvidence =
  | { readonly kind: "cleanup"; readonly error: unknown }
  | { readonly kind: "supervision"; readonly error: unknown };

export interface OwnershipFailure {
  readonly ownership: OwnershipEvidence;
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
  return markOwnershipFailure(error, () => supervisionError);
}

export interface CleanupFailure {
  readonly cleanupError: unknown;
  readonly ownership: Extract<OwnershipEvidence, { kind: "cleanup" }>;
}

/** Annotated providers preserve the error name and aggregate non-Error rejections. */
type CleanupPresentation =
  | { readonly detail: string; readonly aggregateMessage: string }
  | { readonly fallbackMessage: string };

/** Providers supply already-sanitized presentation; attachment and fallback stay shared. */
export function attachCleanupFailure(
  primary: unknown,
  cleanupError: unknown,
  presentation: CleanupPresentation,
): Error & CleanupFailure {
  const annotated = "detail" in presentation;
  const message =
    annotated && primary instanceof Error
      ? `${primary.message}; ${presentation.detail}`
      : undefined;
  return attachProperties(
    primary,
    {
      cleanupError: { configurable: true, value: cleanupError },
      ownership: { configurable: true, value: { kind: "cleanup", error: cleanupError } },
      ...(message === undefined
        ? {}
        : {
            message: { configurable: true, value: message, writable: true },
          }),
    },
    () => {
      if (annotated && !(primary instanceof Error)) {
        return new AggregateError([primary, cleanupError], presentation.aggregateMessage);
      }
      const wrapped = new Error(
        "fallbackMessage" in presentation ? presentation.fallbackMessage : message,
        { cause: primary },
      );
      if (annotated && primary instanceof Error) wrapped.name = primary.name;
      return wrapped;
    },
  ) as Error & CleanupFailure;
}

/** The getter is deliberately lazy: a detached SDK/hook may fail after local settlement. */
export function markOwnershipFailure(
  primary: Error,
  supervisionError: () => unknown,
): Error & OwnershipFailure {
  return attachProperties(
    primary,
    {
      ownershipFailure: { configurable: true, value: true },
      ownership: {
        configurable: true,
        get: () => ({ kind: "supervision", error: supervisionError() }),
      },
      supervisionError: { configurable: true, get: supervisionError },
    },
    () => {
      const wrapped = new Error(primary.message, { cause: primary });
      wrapped.name = primary.name;
      return wrapped;
    },
  ) as Error & OwnershipFailure;
}

function attachProperties(
  primary: unknown,
  properties: PropertyDescriptorMap,
  fallback: () => Error,
): Error {
  if (primary instanceof Error && Object.isExtensible(primary)) {
    try {
      // Preflight avoids partially mutating the primary when another descriptor conflicts.
      if (
        Object.keys(properties).every(
          (key) => Object.getOwnPropertyDescriptor(primary, key)?.configurable !== false,
        )
      ) {
        Object.defineProperties(primary, properties);
        return primary;
      }
    } catch {
      // Frozen or otherwise protected provider errors still retain their original cause.
    }
  }
  const wrapped = fallback();
  Object.defineProperties(wrapped, properties);
  return wrapped;
}

/** A concurrent deadline must never erase evidence that work still has an owner. */
export function selectSandboxFailure(operation: unknown, termination: unknown): unknown {
  return hasOwnershipFailure(operation) ? operation : (termination ?? operation);
}
