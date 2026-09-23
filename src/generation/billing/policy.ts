import type { BillingModelRates } from "../../db/schema.js";
import { sha256 } from "../../lib/hash.js";
import { E2B_GIB_USD_PER_SECOND, E2B_VCPU_USD_PER_SECOND } from "../managed/pricing.js";
import type { TokenUsage } from "../managed/usage.js";
import { generationModelPricing, generationModels } from "../models.js";
import type { BillingPolicy } from "./config.js";

export interface RateSnapshotSpec {
  readonly configHash: string;
  readonly policyVersion: string;
  readonly unitScale: number;
  readonly markupBps: number;
  readonly meterEventName: string;
  readonly modelRates: Record<string, BillingModelRates>;
  readonly vcpuUnitsPerSecond: number;
  readonly gibUnitsPerSecond: number;
}

/** Converts a USD amount into integer billable units, applying the snapshot markup. */
export function usdToUnits(usd: number, unitScale: number, markupBps: number): number {
  return Math.round((usd * unitScale * (10_000 + markupBps)) / 10_000);
}

/** Integer rates frozen from the current policy and published catalog/E2B figures. */
export function rateSnapshotSpec(policy: BillingPolicy): RateSnapshotSpec {
  const modelRates: Record<string, BillingModelRates> = {};
  for (const model of generationModels) {
    const rates = generationModelPricing(model);
    if (!rates) continue;
    modelRates[model] = {
      input: usdToUnits(rates.input, policy.unitScale, policy.markupBps),
      output: usdToUnits(rates.output, policy.unitScale, policy.markupBps),
      cacheRead: usdToUnits(rates.cacheRead, policy.unitScale, policy.markupBps),
      cacheWrite: usdToUnits(rates.cacheWrite, policy.unitScale, policy.markupBps),
    };
  }
  const spec: RateSnapshotSpec = {
    policyVersion: policy.version,
    unitScale: policy.unitScale,
    markupBps: policy.markupBps,
    meterEventName: policy.meterEventName,
    modelRates,
    vcpuUnitsPerSecond: usdToUnits(E2B_VCPU_USD_PER_SECOND, policy.unitScale, policy.markupBps),
    gibUnitsPerSecond: usdToUnits(E2B_GIB_USD_PER_SECOND, policy.unitScale, policy.markupBps),
    configHash: "",
  };
  return { ...spec, configHash: sha256(JSON.stringify({ ...spec, configHash: undefined })) };
}

export function modelBillableUnits(
  snapshot: Pick<RateSnapshotSpec, "modelRates">,
  model: string | undefined,
  tokens: TokenUsage | undefined,
): number {
  if (!model || !tokens) return 0;
  const rates = snapshot.modelRates[model];
  if (!rates) return 0;
  return Math.round(
    (tokens.input * rates.input +
      tokens.output * rates.output +
      tokens.cacheRead * rates.cacheRead +
      tokens.cacheWrite * rates.cacheWrite) /
      1_000_000,
  );
}

export function sandboxBillableUnits(
  snapshot: Pick<RateSnapshotSpec, "vcpuUnitsPerSecond" | "gibUnitsPerSecond">,
  seconds: number,
  cpu?: number,
  memoryMiB?: number,
): number {
  const vcpu = cpu ?? 4;
  const gib = (memoryMiB ?? 8192) / 1024;
  return Math.round(
    seconds * (vcpu * snapshot.vcpuUnitsPerSecond + gib * snapshot.gibUnitsPerSecond),
  );
}
