import { afterEach, expect, test } from "bun:test";
import { solverAgentArguments } from "../src/evaluation/execution.js";
import { gatewayIds, piModels, setGatewayListing } from "../src/gateways/index.js";
import { refreshGateway } from "../src/gateways/refresh.js";
import { piModelsEnvironment } from "../src/generation/pipeline/agent.js";

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
  // Only Pi over that gateway takes them: Harbor's own Pi adapter refuses options it lacks.
  const name = "vercel-ai-gateway/mistral/mistral-large-4";
  expect(solverAgentArguments("pi", "vercel-ai-gateway", name, "high")).toEqual([
    "--agent-kwarg",
    "thinking=high",
    "--agent-kwarg",
    `models_json=${JSON.stringify(piModels("vercel-ai-gateway", "mistral/mistral-large-4"))}`,
  ]);
  expect(solverAgentArguments("codex", "vercel-ai-gateway", name)).toEqual([]);
  expect(
    solverAgentArguments("pi", "openrouter", "openrouter/mistralai/mistral-large-4-0"),
  ).toEqual([]);
  // Generation's Pi gets the same file, and only the overrides where its catalog lists the model.
  expect(piModelsEnvironment("vercel-ai-gateway", "mistral/mistral-large-4")).toEqual({
    AUTHOR_PI_MODELS: JSON.stringify(piModels("vercel-ai-gateway", "mistral/mistral-large-4")),
    AUTHOR_PI_MODEL_OVERRIDES: JSON.stringify({
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
  expect(piModelsEnvironment("vercel-ai-gateway", "vendor/plain")).toEqual({
    AUTHOR_PI_MODELS: JSON.stringify(piModels("vercel-ai-gateway", "vendor/plain")),
  });
  expect(piModelsEnvironment("openai", "gpt-6.1-sol")).toEqual({});
});
