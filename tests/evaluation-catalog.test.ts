import { afterEach, expect, test } from "bun:test";
import {
  type CatalogModel,
  catalog,
  evaluationCatalog,
  withReferencePricing,
} from "../src/evaluation/catalog.js";
import {
  defaultThinking,
  harnessIds,
  modelRoutes,
  routeFor,
  thinkingArguments,
  thinkingOptions,
} from "../src/evaluation/models.js";
import {
  type GatewayId,
  gatewayIds,
  type ListedModel,
  setGatewayListing,
} from "../src/gateways/index.js";
import {
  generationModelLabel,
  generationModelPricing,
  generationModels,
} from "../src/generation/settings/models.js";

afterEach(() => {
  for (const gateway of gatewayIds) setGatewayListing(gateway, { models: [], rates: new Map() });
});

const listModels = (gateway: GatewayId, models: ListedModel[]) =>
  setGatewayListing(gateway, { models, rates: new Map() });

test("OpenRouter's popular models join the curated ones, which keep their routes and levels", () => {
  expect(evaluationCatalog()).toEqual(catalog);
  setGatewayListing("openrouter", {
    models: [
      { id: "qwen/qwen4-coder", label: "Qwen4 Coder", thinking: ["low", "high", "max"] },
      { id: "moonshotai/kimi-k3", label: "Kimi K3", thinking: ["low", "high", "max"] },
      { id: "openai/gpt-6-sol", label: "GPT-6 Sol", thinking: ["low"] },
    ],
    rates: new Map([["qwen/qwen4-coder", { rates: [1, 4, 0.1, 1], asOf: "2026-09-29" }]]),
  });
  const models = evaluationCatalog();
  expect(models.slice(0, 3).map((model) => model.id)).toEqual([
    "qwen/qwen4-coder",
    "kimi-k3",
    "gpt-6-sol",
  ]);
  expect(models).toHaveLength(catalog.length + 1);
  const [qwen, kimi, sol] = models;
  if (!qwen || !kimi || !sol) throw new Error("Missing models");
  expect(modelRoutes(qwen)).toEqual([
    {
      ...qwen,
      harnesses: [...harnessIds],
      pricing: expect.objectContaining({ input: 1, output: 4, asOf: "2026-09-29" }),
    },
  ]);
  expect(qwen).toMatchObject({ provider: "openrouter", model: "qwen/qwen4-coder" });
  expect(thinkingOptions(qwen, ["pi"])).toEqual(["low", "high"]);
  // Kimi has no curated levels, so OpenRouter's apply; Sol keeps its own and its OpenAI route.
  expect(thinkingOptions(kimi, ["pi"])).toEqual(["low", "high"]);
  expect(thinkingOptions(sol, ["codex"])).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  expect(routeFor(sol, "openai")?.model).toBe("gpt-6-sol");
});

test("a model two gateways list is one entry with a route on each, under each one's id", () => {
  listModels("openrouter", [{ id: "z-ai/glm-6", label: "GLM 6", thinking: ["low", "high"] }]);
  listModels("vercel-ai-gateway", [
    { id: "zai/glm-6", label: "GLM 6", thinking: ["high"] },
    { id: "zai/glm-5.3", label: "GLM 5.3" },
    { id: "alibaba/qwen4-max", label: "Qwen4 Max" },
  ]);
  const models = evaluationCatalog();
  expect(models.slice(0, 3).map((model) => model.id)).toEqual([
    "z-ai/glm-6",
    "glm-5.3",
    "qwen/qwen4-max",
  ]);
  const [glm6, glm, qwen] = models;
  if (!glm6 || !glm || !qwen) throw new Error("Missing models");
  expect(modelRoutes(glm6).map((route) => [route.provider, route.model])).toEqual([
    ["openrouter", "z-ai/glm-6"],
    ["vercel-ai-gateway", "zai/glm-6"],
  ]);
  // Each route offers the levels its gateway accepts; the curated GLM keeps its own on both.
  expect(thinkingOptions(glm6, ["codex"])).toEqual(["low", "high"]);
  expect(thinkingOptions(routeFor(glm6, "vercel-ai-gateway") ?? glm6, ["codex"])).toEqual(["high"]);
  expect(modelRoutes(glm).map((route) => [route.provider, route.model, route.thinking])).toEqual([
    ["openrouter", "z-ai/glm-5.3", ["low", "high", "max"]],
    ["vercel-ai-gateway", "zai/glm-5.3", ["low", "high", "max"]],
  ]);
  expect(modelRoutes(qwen).map((route) => [route.provider, route.model])).toEqual([
    ["vercel-ai-gateway", "alibaba/qwen4-max"],
  ]);
  expect(routeFor(qwen, "openrouter")).toBeUndefined();
});

test("a model gateways list under different ids is one entry when vendor and name match", () => {
  listModels("openrouter", [
    { id: "mistralai/mistral-large-4-0", label: "Mistral Large 4", thinking: ["off", "high"] },
    { id: "meta/muse-spark-1.3", label: "Muse Spark 1.3" },
    { id: "qwen/qwen3-14b", label: "Qwen3 14B" },
    { id: "cohere/command-a-plus", label: "Command A+" },
    { id: "qwen/qwen3-32b", label: "Qwen3 32B" },
    { id: "qwen/qwen3-32b-2604", label: "Qwen3 32B" },
  ]);
  listModels("vercel-ai-gateway", [
    { id: "mistral/mistral-large-4", label: "Mistral Large 4", thinking: ["low", "high"] },
    // Vercel's meta stands for OpenRouter's meta-llama, but its Muse is OpenRouter's meta Muse.
    { id: "meta/muse-spark-1.3", label: "Muse Spark 1.3" },
    // Listed before the id OpenRouter shares, under the same name: a model of its own.
    { id: "alibaba/qwen3-14b-preview", label: "Qwen3-14B" },
    { id: "alibaba/qwen3-14b", label: "Qwen3 14B" },
    { id: "cohere/command-a", label: "Command A" },
    { id: "vendor/mistral-large-4", label: "Mistral Large 4" },
    // OpenRouter has two models by this name, so neither is this one's pair.
    { id: "alibaba/qwen-3-32b", label: "Qwen3-32B" },
  ]);
  const models = evaluationCatalog().filter((model) => !catalog.some(({ id }) => id === model.id));
  expect(models.map((model) => [model.id, model.gateways])).toEqual([
    [
      "mistralai/mistral-large-4-0",
      { openrouter: "mistralai/mistral-large-4-0", "vercel-ai-gateway": "mistral/mistral-large-4" },
    ],
    [
      "meta/muse-spark-1.3",
      { openrouter: "meta/muse-spark-1.3", "vercel-ai-gateway": "meta/muse-spark-1.3" },
    ],
    ["qwen/qwen3-14b", { openrouter: "qwen/qwen3-14b", "vercel-ai-gateway": "alibaba/qwen3-14b" }],
    ["cohere/command-a-plus", { openrouter: "cohere/command-a-plus" }],
    ["qwen/qwen3-32b", { openrouter: "qwen/qwen3-32b" }],
    ["qwen/qwen3-32b-2604", { openrouter: "qwen/qwen3-32b-2604" }],
    ["qwen/qwen3-14b-preview", { "vercel-ai-gateway": "alibaba/qwen3-14b-preview" }],
    ["cohere/command-a", { "vercel-ai-gateway": "cohere/command-a" }],
    ["vendor/mistral-large-4", { "vercel-ai-gateway": "vendor/mistral-large-4" }],
    ["qwen/qwen-3-32b", { "vercel-ai-gateway": "alibaba/qwen-3-32b" }],
  ]);
  const [mistral] = models;
  if (!mistral) throw new Error("Missing Mistral Large 4");
  // Each route still offers the levels its own gateway lists.
  expect(modelRoutes(mistral).map((route) => [route.provider, route.thinking])).toEqual([
    ["openrouter", ["off", "high"]],
    ["vercel-ai-gateway", ["low", "high"]],
  ]);
});

test("a curated model loses its route on a gateway whose prices loaded without it", () => {
  setGatewayListing("vercel-ai-gateway", {
    models: [{ id: "zai/glm-5.3", label: "GLM 5.3" }],
    rates: new Map([["zai/glm-5.3", { rates: [1, 4, 0.1, 1], asOf: "2026-09-30" }]]),
  });
  const models = evaluationCatalog();
  const route = (id: string) => {
    const model = models.find((entry) => entry.id === id);
    if (!model) throw new Error(`Missing ${id}`);
    return routeFor(model, "vercel-ai-gateway");
  };
  expect(route("glm-5.3")?.model).toBe("zai/glm-5.3");
  expect(route("kimi-k3")).toBeUndefined();
  // OpenRouter's prices have not loaded, so it still serves every curated model.
  expect(models.every((model) => routeFor(model, "openrouter"))).toBe(true);
});

test("a row with no chosen level runs at high, or else the first level its model offers", () => {
  const model: CatalogModel = {
    id: "vendor/model",
    provider: "openrouter",
    model: "vendor/model",
    label: "Model",
    harnesses: ["pi"],
    source: "",
    thinking: ["low", "max"],
  };
  expect(defaultThinking(thinkingOptions(model, ["pi"]))).toBe("low");
  expect(defaultThinking(thinkingOptions(model, ["codex"]))).toBe("low");
  expect(thinkingOptions({ ...model, thinking: ["max"] }, ["pi"])).toEqual(["default"]);
  expect(defaultThinking(thinkingOptions({ ...model, thinking: ["low", "high"] }, ["pi"]))).toBe(
    "high",
  );
});

test("current catalog exposes explicit model IDs and dated provider pricing", () => {
  expect(new Set(catalog.map((model) => model.id)).size).toBe(catalog.length);
  expect(catalog.filter((model) => model.label.includes("Astra"))).toHaveLength(1);
  expect(catalog.map((model) => model.model)).toContain("gpt-6-astra");
  expect(catalog.map((model) => model.model)).toContain("claude-fable-5-1");
  expect(catalog.map((model) => model.model)).toContain("google/gemini-3.8-flash");
  expect(catalog.every((model) => model.source.startsWith("https://"))).toBe(true);
  const fable = catalog.find((model) => model.id === "claude-fable-5-1");
  if (!fable) throw new Error("Missing Fable");
  expect(withReferencePricing(fable).pricing).toMatchObject({
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
    asOf: "2026-09-23",
  });
});

test("generation and evaluation read the same catalog", () => {
  for (const id of generationModels) {
    const entry = catalog.find((model) => model.id === id);
    expect(entry?.label).toBe(generationModelLabel(id));
    expect(generationModelPricing(id)).toEqual(entry && routeFor(entry, "openrouter")?.pricing);
  }
});

test("a gateway-only model keeps its gateway IDs and every harness", () => {
  const model = catalog.find((entry) => entry.id === "deepseek-v4-pro-0813");
  if (!model) throw new Error("Missing model");
  expect(model.provider).toBe("openrouter");
  expect(model.model).toBe("deepseek/deepseek-v4-pro-0813");
  expect(modelRoutes(model)).toEqual(
    gatewayIds.map((provider) =>
      expect.objectContaining({
        provider,
        model: "deepseek/deepseek-v4-pro-0813",
        harnesses: [...harnessIds],
      }),
    ),
  );
});

test("credential routes preserve exact model IDs, provider pricing and harness support", () => {
  const sol = catalog.find((model) => model.id === "gpt-6-sol");
  if (!sol) throw new Error("Missing Sol");
  const routes = modelRoutes(sol);
  expect(routes.map((route) => [route.provider, route.model, route.pricing?.input])).toEqual([
    ["openai", "gpt-6-sol", 2],
    ["openrouter", "openai/gpt-6-sol", 2],
    ["vercel-ai-gateway", "openai/gpt-6-sol", 2],
  ]);
  expect(thinkingOptions(sol, ["codex"])).toContain("max");
  expect(thinkingOptions(sol, ["codex", "pi"])).not.toContain("max");

  const sonnet = catalog.find((model) => model.id === "claude-sonnet-5-5");
  if (!sonnet) throw new Error("Missing Sonnet 5.5");
  expect(modelRoutes(sonnet).map((route) => [route.provider, route.pricing?.input])).toEqual([
    ["anthropic", 2],
    ["openrouter", 2],
    ["vercel-ai-gateway", 2],
  ]);

  // Haiku 5.5's list rates cover prompts up to 100k tokens; Anthropic charges more past them.
  const haiku = catalog.find((model) => model.id === "claude-haiku-5-5");
  if (!haiku) throw new Error("Missing Haiku 5.5");
  const haikuRoutes = modelRoutes(haiku);
  expect(haikuRoutes.map((route) => route.provider)).toEqual(["anthropic", ...gatewayIds]);
  for (const route of haikuRoutes)
    expect(route.pricing).toMatchObject({ input: 0.1, output: 0.5, maxInputTokens: 100_000 });
  expect(thinkingOptions(haiku, ["claude-code"])).toContain("max");
});

test("thinking levels reach the actual Harbor harness flags without changing models", () => {
  expect(thinkingArguments("codex", "max")).toEqual(["--agent-kwarg", "reasoning_effort=max"]);
  expect(thinkingArguments("codex", "off")).toEqual(["--agent-kwarg", "reasoning_effort=none"]);
  expect(thinkingArguments("claude-code", "xhigh")).toEqual([
    "--agent-kwarg",
    "reasoning_effort=xhigh",
  ]);
  expect(thinkingArguments("pi", "high")).toEqual(["--agent-kwarg", "thinking=high"]);
  expect(thinkingArguments("pi", "default")).toEqual([]);
});

test("custom endpoints only offer default thinking whatever model ID is typed", () => {
  const custom: Omit<CatalogModel, "model"> = {
    id: "custom",
    label: "Custom model",
    source: "",
    provider: "custom",
    harnesses: ["pi"],
  };
  expect(thinkingOptions({ ...custom, model: "" }, ["pi"])).toEqual(["default"]);
  expect(thinkingOptions({ ...custom, model: "z-ai/glm-5.3" }, ["pi"])).toEqual(["default"]);
});

test.each([
  ["glm-5.3", ["low", "high", "max"]],
  ["deepseek-v4-pro-0813", ["off", "low", "high", "max"]],
] as const)(
  "%s exposes its reasoning levels independently of gateway ID mappings",
  (id, levels) => {
    const model = catalog.find((entry) => entry.id === id);
    if (!model) throw new Error(`Missing model ${id}`);
    expect(thinkingOptions(model, ["codex"])).toEqual([...levels]);
    expect(thinkingOptions(model, ["pi"])).toEqual(levels.filter((level) => level !== "max"));
    expect(thinkingOptions(model, ["mini-swe-agent"])).toEqual(["default"]);
    expect(thinkingOptions(model, ["terminus-2"])).toEqual(["default"]);
  },
);
