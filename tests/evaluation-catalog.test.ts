import { expect, test } from "bun:test";
import { catalog } from "../src/evaluation/catalog.js";
import { withReferencePricing } from "../src/evaluation/catalog-pricing.js";
import {
  modelRoutes,
  thinkingArguments,
  thinkingOptions,
} from "../src/evaluation/model-options.js";

test("current catalog exposes explicit model IDs and dated provider pricing", () => {
  expect(new Set(catalog.map((model) => model.id)).size).toBe(catalog.length);
  expect(catalog.filter((model) => model.label.includes("Astra"))).toHaveLength(1);
  expect(catalog.some((model) => model.label.includes("· OpenRouter"))).toBe(false);
  expect(catalog.map((model) => model.model)).toContain("gpt-6-astra");
  expect(catalog.map((model) => model.model)).toContain("claude-fable-5-1");
  expect(catalog.map((model) => model.model)).toContain("google/gemini-3.8-flash");
  expect(catalog.every((model) => model.source.startsWith("https://"))).toBe(true);
  const fable = catalog.find((model) => model.id === "anthropic-fable51");
  if (!fable) throw new Error("Missing Fable");
  expect(withReferencePricing(fable).pricing).toMatchObject({
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
    asOf: "2026-09-06",
  });
});

test("credential routes preserve exact model IDs, provider pricing and harness support", () => {
  const sol = catalog.find((model) => model.id === "openai-sol56");
  if (!sol) throw new Error("Missing Sol");
  const routes = modelRoutes(sol);
  expect(routes.map((route) => [route.provider, route.model, route.pricing?.input])).toEqual([
    ["openai", "gpt-5.6-sol", 4],
    ["openrouter", "openai/gpt-5.6-sol", 2],
  ]);
  expect(routes[1]?.harnesses).toEqual(["pi"]);
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
