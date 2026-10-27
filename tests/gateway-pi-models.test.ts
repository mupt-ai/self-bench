import { afterEach, expect, test } from "bun:test";
import { piGatewayModels } from "../src/evaluation/gateway-trial.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { gatewayModelPrice, listedModelConfig } from "../src/gateway/models.js";
import { gatewayIds, piModels, setGatewayListing } from "../src/gateways/index.js";
import { refreshGateway } from "../src/gateways/refresh.js";
import { piModelsFiles } from "../src/generation/settings/models.js";

afterEach(() => {
  for (const gateway of gatewayIds) setGatewayListing(gateway, { models: [], rates: new Map() });
});

const respond = (data: unknown[]) =>
  (async () => Response.json({ data })) as unknown as typeof fetch;

test("Pi is told how Vercel AI Gateway takes each model, from the gateway's own listing", async () => {
  await refreshGateway(
    "vercel-ai-gateway",
    respond([
      {
        id: "mistral/mistral-large-4",
        name: "Mistral Large 4",
        type: "language",
        tags: ["reasoning", "tool-use", "vision"],
        modalities: { input: ["text", "image"], output: ["text"] },
        context_window: 524288,
        max_tokens: 262144,
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["none", "minimal", "low", "high", "xhigh"] },
        ],
        pricing: { input: "0.00000068", output: "0.00000209", input_cache_read: "0.00000007" },
      },
      {
        id: "vendor/plain",
        name: "Plain",
        type: "language",
        tags: ["tool-use"],
        modalities: { input: ["text"], output: ["text"] },
        pricing: { input: "0.000001", output: "0.000002" },
      },
    ]),
  );
  // Efforts go as adaptive thinking, under their own names; Pi maps minimal itself. A Pi that
  // lists the model takes only that from the overrides.
  expect(piModels("vercel-ai-gateway", "mistral/mistral-large-4")).toEqual({
    providers: {
      "vercel-ai-gateway": {
        models: [
          {
            id: "mistral/mistral-large-4",
            name: "Mistral Large 4",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 524288,
            maxTokens: 262144,
            cost: { input: 0.68, output: 2.09, cacheRead: 0.07, cacheWrite: 0.68 },
            thinkingLevelMap: { low: "low", high: "high", xhigh: "xhigh" },
            compat: { allowEmptySignature: true, forceAdaptiveThinking: true },
          },
        ],
        modelOverrides: {
          "mistral/mistral-large-4": {
            thinkingLevelMap: { low: "low", high: "high", xhigh: "xhigh" },
            compat: { forceAdaptiveThinking: true },
          },
        },
      },
    },
  });
  expect(piModels("vercel-ai-gateway", "vendor/plain")).toEqual({
    providers: {
      "vercel-ai-gateway": {
        models: [
          {
            id: "vendor/plain",
            name: "Plain",
            reasoning: false,
            input: ["text"],
            cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
            compat: { allowEmptySignature: true },
          },
        ],
      },
    },
  });
  expect(piModels("vercel-ai-gateway", "vendor/unlisted")).toBeUndefined();
  // An evaluation's Pi reaches the model through SelfBench's gateway, with the listing's limits.
  const name = "vercel-ai-gateway/mistral/mistral-large-4";
  const trial = {
    modelName: name,
    credentials: { provider: "vercel-ai-gateway" },
  } as EvaluationInput;
  const connection = { openAiBase: "https://gateway/v1", requestModel: `dari/model/${name}` };
  expect(piGatewayModels(trial, connection)).toMatchObject({
    providers: {
      selfbench: {
        models: [
          {
            id: `dari/model/${name}`,
            name: "Mistral Large 4",
            input: ["text", "image"],
            contextWindow: 524288,
            maxTokens: 262144,
          },
        ],
      },
    },
  });
  // The gateway itself serves a model Pi's catalog lacks as the listing describes it, and leaves
  // one Pi lists (as Mistral Large 4), and every model of a provider that is no gateway, to Pi.
  expect(listedModelConfig("vercel-ai-gateway/vendor/plain")).toEqual({
    provider: "vercel-ai-gateway",
    native_model_id: "vendor/plain",
    api: "openai-completions",
    cost: { input: 1, output: 2, cached_input: 1, cache_write: 1 },
  });
  expect(listedModelConfig(name)).toBeUndefined();
  expect(gatewayModelPrice(name)).toEqual({
    input: 0.68,
    output: 2.09,
    cached_input: 0.07,
    cache_write: 0.68,
  });
  expect(listedModelConfig("vercel-ai-gateway/vendor/unlisted")).toBeUndefined();
  expect(listedModelConfig("openai/gpt-6.1-sol")).toBeUndefined();
  // Generation's Pi gets the same file, and only the overrides where its catalog lists the model.
  expect(piModelsFiles("vercel-ai-gateway", "mistral/mistral-large-4")).toEqual({
    models: JSON.stringify(piModels("vercel-ai-gateway", "mistral/mistral-large-4")),
    overrides: JSON.stringify({
      providers: {
        "vercel-ai-gateway": {
          modelOverrides: {
            "mistral/mistral-large-4": {
              thinkingLevelMap: { low: "low", high: "high", xhigh: "xhigh" },
              compat: { forceAdaptiveThinking: true },
            },
          },
        },
      },
    }),
  });
  expect(piModelsFiles("vercel-ai-gateway", "vendor/plain")).toEqual({
    models: JSON.stringify(piModels("vercel-ai-gateway", "vendor/plain")),
  });
  expect(piModelsFiles("openai", "gpt-6.1-sol")).toBeUndefined();
});

test("a vendor's own key is priced at the catalog's reference rates, with long prompts tiered", () => {
  const price = gatewayModelPrice("openai/gpt-6.1-sol");
  expect(price).toMatchObject({ input: expect.any(Number), output: expect.any(Number) });
  expect(gatewayModelPrice("anthropic/gpt-6.1-sol")).toBeUndefined();
  expect(gatewayModelPrice("custom/acme-coder")).toBeUndefined();
  for (const tier of price?.tiers ?? []) expect(tier.input_tokens_above).toBeGreaterThan(0);
});
