import { E2B } from "e2b";
import type { SelfBenchWorkerConfig } from "../../../contracts/config/index.js";
import { errorMessage } from "../../../lib/util.js";

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
    // The SDK does not always honor the signal, so the bound is enforced here.
    exists = await Promise.race([
      resolved.exists(config.image, signal),
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    ]);
  } catch (error) {
    throw new Error(
      `E2B startup validation could not access template ${config.image}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!exists) {
    throw new Error(
      `E2B template ${config.image} does not exist or is not accessible; build it with bun scripts/build-e2b-template.ts --name ${config.image}`,
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
