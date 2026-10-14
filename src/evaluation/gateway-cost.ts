import {
  billingPause,
  generationCharge,
  generationLookup,
  lookupGenerations,
} from "../gateways/billing.js";
import { gateways } from "../gateways/index.js";
import { openRouterCost } from "../gateways/openrouter/billing.js";
import { gatewayUsage, generationIds } from "../gateways/usage.js";
import type { EvaluationRun, EvaluationTrial, Harness } from "./types.js";

type BilledGateway = "openrouter" | "vercel-ai-gateway";

/**
 * Actual OpenRouter charges replace estimates. Other gateways retain their direct bill as
 * supporting evidence while list pricing remains primary.
 */
export async function billedTrialCost(
  run: EvaluationRun,
  trial: EvaluationTrial,
  env: NodeJS.ProcessEnv,
  files: Map<string, string>,
  billingKey?: string,
): Promise<Pick<EvaluationTrial, "billedCostUsd" | "apiCostUsd" | "costSource">> {
  const provider = run.credentials?.provider;
  if (!trial.modelVerified || (provider !== "openrouter" && provider !== "vercel-ai-gateway"))
    return {};
  const cost = await gatewayCost(
    provider,
    env[gateways[provider].keyVariable],
    trial.harness,
    files,
    fetch,
    billingKey,
  );
  if (cost === undefined) return {};
  return provider === "openrouter" || trial.apiCostUsd === undefined
    ? { billedCostUsd: cost, apiCostUsd: cost, costSource: "gateway" }
    : { billedCostUsd: cost };
}

/** Gateway's charged USD; incomplete lookups never return a partial bill. */
export async function gatewayCost(
  provider: BilledGateway,
  key: string | undefined,
  harness: Harness,
  files: Map<string, string>,
  fetcher: typeof fetch = fetch,
  billingKey?: string,
  pause: () => Promise<void> = billingPause,
): Promise<number | undefined> {
  if (!key) return undefined;
  if (provider === "openrouter")
    return openRouterCost(harness, files, key, billingKey, fetcher, pause);
  const ids = generationIds(harness, files);
  if (!ids) return undefined;
  const lookup = generationLookup("https://ai-gateway.vercel.sh/v1", key, fetcher, pause);
  const generations = await lookupGenerations(ids, lookup);
  if (!generations) return undefined;
  const usage = gatewayUsage(files);
  let total = 0;
  for (const data of generations) {
    const cost = generationCharge(data);
    if (
      cost === undefined ||
      (cost === 0 &&
        data.native_tokens_prompt === 0 &&
        data.native_tokens_completion === 0 &&
        ((usage.get(data.id)?.prompt ?? 0) > 0 || (usage.get(data.id)?.completion ?? 0) > 0))
    )
      return undefined;
    total += cost;
  }
  return Number.isFinite(total) ? total : undefined;
}
