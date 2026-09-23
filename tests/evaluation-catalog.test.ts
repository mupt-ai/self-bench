import { expect, test } from "bun:test";
import { findModel } from "../src/contracts/models.js";
import { type CatalogModel, catalog, withReferencePricing } from "../src/evaluation/catalog.js";
import {
  harnessIds,
  modelRoutes,
  routeFor,
  thinkingArguments,
  thinkingOptions,
} from "../src/evaluation/models.js";
import {
  generationModelLabel,
  generationModelPricing,
  generationModels,
} from "../src/generation/settings/models.js";

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
    asOf: "2026-09-06",
  });
});

test("generation and evaluation read the same catalog", () => {
  for (const id of generationModels) {
    const entry = catalog.find((model) => model.id === id);
    expect(entry?.label).toBe(generationModelLabel(id));
    expect(generationModelPricing(id)).toEqual(entry && routeFor(entry, "openrouter")?.pricing);
  }
  // Runs stored before the catalog was shared still resolve.
  expect(findModel("openai-sol56")?.id).toBe("gpt-5.6-sol");
  expect(findModel("router-glm53")?.id).toBe("glm-5.3");
});

test("an OpenRouter-only model keeps its OpenRouter ID and every harness", () => {
  const model = catalog.find((entry) => entry.id === "deepseek-v4-pro");
  if (!model) throw new Error("Missing model");
  expect(model.provider).toBe("openrouter");
  expect(model.model).toBe("deepseek/deepseek-v4-pro");
  expect(modelRoutes(model)).toHaveLength(1);
  expect(modelRoutes(model)[0]).toMatchObject({
    provider: "openrouter",
    model: "deepseek/deepseek-v4-pro",
    harnesses: [...harnessIds],
  });
});

test("credential routes preserve exact model IDs, provider pricing and harness support", () => {
  const sol = catalog.find((model) => model.id === "gpt-5.6-sol");
  if (!sol) throw new Error("Missing Sol");
  const routes = modelRoutes(sol);
  expect(routes.map((route) => [route.provider, route.model, route.pricing?.input])).toEqual([
    ["openai", "gpt-5.6-sol", 4],
    ["openrouter", "openai/gpt-5.6-sol", 2],
  ]);
  expect(routes[1]?.harnesses).toEqual([
    "codex",
    "claude-code",
    "pi",
    "mini-swe-agent",
    "terminus-2",
  ]);
  expect(thinkingOptions(sol, ["codex"])).toContain("max");
  expect(thinkingOptions(sol, ["codex", "pi"])).not.toContain("max");
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
  ["deepseek-v4-pro", ["off", "low", "high", "max"]],
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
