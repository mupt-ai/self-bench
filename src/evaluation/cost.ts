import { isGateway } from "../gateways/index.js";
import { measureClaudeCodeCost } from "./claude-code-cost.js";
import { measureCodexCost } from "./codex-cost.js";
import { compatibleEndpoint } from "./compatible-endpoints.js";
import { gatewayModel } from "./execution.js";
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
  // Harbor records the model name the runner passed it: the gateway form on a gateway route.
  const harborModel = gatewayModel(run.credentials?.provider, harness, run.modelName);
  const matches = (value: unknown) =>
    value === model || value === run.modelName || value === harborModel;
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
      }
    | undefined;

  if (harness === "pi") {
    // Pi can report either its configured custom provider or the OpenAI-compatible protocol name.
    const endpointModels = compatibleEndpoint(run.credentials?.provider, harness)
      ? [`harbor-endpoint/${model}`, `openai/${model}`]
      : [];
    measurement = measurePiCost(run, files, result, endpointModels);
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
  } = measurement;
  const measured = {
    modelVerified,
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(cacheWritesInferred ? { cacheWritesInferred: true } : {}),
  };
  if (!modelVerified || !tokenUsage) return measured;
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
  // another provider's rates; gateway runs are priced at their vendor's list rates (runPricing),
  // and Harbor's figure stands in only where those cannot price the trial. A compatible
  // endpoint's figure would be another vendor's harness pricing the model, so it is the same.
  const provider = run.credentials?.provider;
  if (
    !pricing ||
    (reportedCost !== undefined && !isGateway(provider) && !compatibleEndpoint(provider, harness))
  )
    return reported;
  if (!referenceRatesComplete && pricing.cacheWrite > pricing.input) {
    return reportedCost !== undefined &&
      !isGateway(provider) &&
      !compatibleEndpoint(provider, harness)
      ? reported
      : measured;
  }
  const apiCostUsd = requests
    ? requestsCost(pricing, requests)
    : wholeCost(pricing, tokenUsage, largestPrompt, hourCacheWrite);
  return apiCostUsd !== undefined && Number.isFinite(apiCostUsd)
    ? { ...measured, apiCostUsd, costSource: "reference-rates" }
    : reported;
}
