import { isGateway } from "../gateways/index.js";
import { measureClaudeCodeCost } from "./claude-code-cost.js";
import { measureCodexCost } from "./codex-cost.js";
import { gatewayRequestModel } from "./execution.js";
import { measureHarborAgentCost } from "./harbor-agent-cost.js";
import { measureMuseCodeCost } from "./muse-code-cost.js";
import { measurePiCost } from "./pi-cost.js";
import { type RequestUsage, requestsCost, wholeCost } from "./request-cost.js";
import type { EvaluationRun, EvaluationTrial, Harness, TokenUsage } from "./types.js";

export function trialCost(
  run: EvaluationRun,
  harness: Harness,
  files: Map<string, string>,
  result: unknown,
  auth = run.credentials?.auth,
): Pick<
  EvaluationTrial,
  "modelVerified" | "apiCostUsd" | "tokenUsage" | "costSource" | "cacheWritesInferred"
> {
  const pricing = run.pricing;
  const model = run.modelName.split("/").slice(1).join("/");
  // Harbor records the model name it was given, which on the gateway names the one model it
  // serves (gatewayTrial); a trial recorded before the gateway gave a gateway's id as `openai/`.
  const request = gatewayRequestModel(run);
  const names = new Set([
    model,
    run.modelName,
    `openai/${model}`,
    request,
    `openai/${request}`,
    `selfbench/${request}`,
  ]);
  const matches = (value: unknown) => typeof value === "string" && names.has(value);
  let measurement:
    | {
        modelVerified: boolean;
        tokenUsage?: TokenUsage;
        requests?: readonly RequestUsage[];
        reportedCost?: number;
        cacheWritesInferred?: boolean;
        largestPrompt?: number;
        hourCacheWrite?: number;
        referenceRatesComplete?: boolean;
        costUnavailable?: boolean;
      }
    | undefined;

  if (harness === "pi") {
    // Pi reports its provider: the gateway's, or Harbor's custom endpoint on trials before it.
    measurement = measurePiCost(run, files, result, [
      `selfbench/${request}`,
      `harbor-endpoint/${model}`,
      `openai/${model}`,
    ]);
  } else if (harness === "codex") {
    measurement = measureCodexCost(run, files, result, auth, pricing, matches);
  } else if (harness === "claude-code") {
    measurement = measureClaudeCodeCost(files, result, matches);
  } else if (harness === "mini-swe-agent" || harness === "terminus-2") {
    measurement = measureHarborAgentCost(files, result, matches);
  } else if (harness === "muse-code") {
    const muse = measureMuseCodeCost(files, result);
    if (!muse) return {};
    return {
      modelVerified: muse.modelVerified,
      tokenUsage: muse.tokenUsage,
      ...(muse.apiCostUsd === undefined
        ? {}
        : { apiCostUsd: muse.apiCostUsd, costSource: "reference-rates" as const }),
    };
  }

  if (!measurement) return {};
  const {
    modelVerified,
    tokenUsage,
    requests,
    reportedCost,
    cacheWritesInferred,
    largestPrompt,
    hourCacheWrite = 0,
    referenceRatesComplete = true,
    costUnavailable = false,
  } = measurement;
  const measured = {
    modelVerified,
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(cacheWritesInferred ? { cacheWritesInferred: true } : {}),
  };
  if (!modelVerified || !tokenUsage || costUnavailable) return measured;
  // OpenRouter's actual charge can include routing, discounts and separate BYOK charges.
  // Only its gateway billing records provide a price, not harness or catalog estimates.
  if (run.credentials?.provider === "openrouter") return measured;
  const reported =
    reportedCost === undefined
      ? measured
      : {
          ...measured,
          apiCostUsd: reportedCost,
          costSource: cacheWritesInferred ? ("reference-rates" as const) : ("harbor" as const),
        };
  // Harbor prices a gateway route from LiteLLM's table for it, which may carry a discount or
  // another provider's rates; those runs are priced at their vendor's list rates (runPricing),
  // and Harbor's figure stands in only where those cannot price the trial. A Meta key's figure
  // for a harness other than Muse Code is another vendor's harness pricing it, so it is the same.
  // (A trial through SelfBench's gateway takes the gateway's recorded cost instead; runner.ts.)
  const provider = run.credentials?.provider;
  const harborPriced = !isGateway(provider) && provider !== "meta";
  if (!pricing || (reportedCost !== undefined && harborPriced)) return reported;
  if (!referenceRatesComplete && pricing.cacheWrite > pricing.input)
    return reportedCost !== undefined && harborPriced ? reported : measured;
  const apiCostUsd = requests
    ? requestsCost(pricing, requests)
    : wholeCost(pricing, tokenUsage, largestPrompt, hourCacheWrite);
  return apiCostUsd !== undefined && Number.isFinite(apiCostUsd)
    ? { ...measured, apiCostUsd, costSource: "reference-rates" }
    : reported;
}
