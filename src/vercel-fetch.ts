export class VercelCommandStartError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`${message}; automatic retry was suppressed to prevent duplicate execution`, { cause });
    // @vercel/sandbox's retry layer only honors AbortError as a non-retryable
    // transport failure. The command layer restores the truthful public name.
    this.name = "AbortError";
  }

  restorePublicName(): void {
    this.name = "VercelCommandStartError";
  }
}

export function preventAmbiguousVercelCommandStartRetries(
  fetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const isCommandStart =
      init?.method === "POST" && /\/v2\/sandboxes\/sessions\/[^/]+\/cmd$/.test(url.pathname);
    try {
      const response = await fetch(input, init);
      if (isCommandStart && response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        throw new VercelCommandStartError(`Vercel command start returned HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      if (error instanceof VercelCommandStartError || !isCommandStart || init?.signal?.aborted) {
        throw error;
      }
      throw new VercelCommandStartError("Vercel command start response was not received", error);
    }
  };
  return Object.assign(wrapped, {
    preconnect: (...args: Parameters<typeof fetch.preconnect>): void => {
      if (typeof fetch.preconnect === "function") {
        fetch.preconnect(...args);
      }
    },
  });
}
