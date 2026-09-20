import { generationModelPricing } from "../site/generation-models.js";

// E2B's published compute rates, per vCPU-second and per GiB-second
// (https://e2b.dev/pricing, as of 2026-09-19).
const E2B_VCPU_USD_PER_SECOND = 0.000014;
const E2B_GIB_USD_PER_SECOND = 0.0000045;

/** The standard generation allocation, which managed E2B templates fix at build time. */
const MANAGED_E2B_CPUS = 4;
const MANAGED_E2B_MEMORY_MIB = 8192;

export function managedSandboxCostUsd(
  seconds: number,
  cpu = MANAGED_E2B_CPUS,
  memoryMiB = MANAGED_E2B_MEMORY_MIB,
): number {
  return seconds * (cpu * E2B_VCPU_USD_PER_SECOND + (memoryMiB / 1024) * E2B_GIB_USD_PER_SECOND);
}

/** Estimated model cost for consumed tokens under the model's reference rates. */
export function managedModelCostUsd(
  model: string,
  usage: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  },
): number | undefined {
  const rates = generationModelPricing(model);
  if (!rates) return undefined;
  return (
    (usage.input * rates.input +
      usage.output * rates.output +
      usage.cacheRead * rates.cacheRead +
      usage.cacheWrite * rates.cacheWrite) /
    1_000_000
  );
}
