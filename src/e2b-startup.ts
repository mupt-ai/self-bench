import { E2B } from "e2b";
import type { SelfBenchWorkerConfig } from "./config.js";

type E2BExecutionConfig = Extract<SelfBenchWorkerConfig["execution"], { readonly kind: "e2b" }>;

export interface E2BStartupApi {
  exists(template: string, signal: AbortSignal): Promise<boolean>;
}

export async function validateE2BWorkerStartup(
  config: E2BExecutionConfig,
  api?: E2BStartupApi,
  timeoutMs = 30_000,
): Promise<void> {
  const resolved = api ?? createE2BStartupApi(config);
  const signal = AbortSignal.timeout(timeoutMs);
  let exists: boolean;
  try {
    exists = await raceWithSignal(resolved.exists(config.image, signal), signal);
  } catch (error) {
    throw new Error(
      `E2B startup validation could not access template ${config.image}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!exists) {
    throw new Error(
      `E2B template ${config.image} does not exist or is not accessible; build it with self-bench setup e2b --name ${config.image}`,
    );
  }
}

function createE2BStartupApi(config: E2BExecutionConfig): E2BStartupApi {
  const client = new E2B(config.credentials);
  return {
    exists: async (template, signal) =>
      await client.Template.exists(template, { requestTimeoutMs: 30_000, signal }),
  };
}

async function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw signal.reason;
  }
  let removeAbortListener = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      void operation.catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbortListener();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
