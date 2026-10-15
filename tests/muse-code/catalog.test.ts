import { afterEach, expect, test } from "bun:test";
import { catalog, evaluationCatalog } from "../../src/evaluation/catalog.js";
import { modelRoutes, openHarnesses, thinkingOptions } from "../../src/evaluation/models.js";
import { gatewayIds, setGatewayListing } from "../../src/gateways/index.js";

afterEach(() => {
  for (const gateway of gatewayIds) setGatewayListing(gateway, { models: [], rates: new Map() });
});

test("Muse models run every harness on a Meta key, Muse Code first, and gateways all but Muse Code", () => {
  const spark = catalog.find((model) => model.id === "muse-spark-1.3");
  if (!spark) throw new Error("Missing Muse Spark 1.3");
  const routes = modelRoutes(spark);
  expect(routes.map((route) => [route.provider, route.model, route.harnesses])).toEqual([
    ["meta", "muse-spark-1.3", ["muse-code", ...openHarnesses]],
    ["openrouter", "meta/muse-spark-1.3", [...openHarnesses]],
    ["vercel-ai-gateway", "meta/muse-spark-1.3", [...openHarnesses]],
  ]);
  expect(routes[0]?.pricing).toMatchObject({ input: 1.25, output: 4.25, cacheRead: 0.15 });
  // Muse refuses "none", and Meta documents max for Spark 1.3 but not 1.2.
  expect(thinkingOptions(spark, ["muse-code"])).toEqual([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const older = catalog.find((model) => model.id === "muse-spark-1.2");
  expect(older && thinkingOptions(older, ["muse-code"])).not.toContain("max");
});

test("a gateway's listing of a curated Muse model is that model's route, not a second entry", () => {
  for (const gateway of gatewayIds)
    setGatewayListing(gateway, {
      // Vercel's meta is OpenRouter's meta-llama, but its Muse is the curated meta Muse.
      models: [{ id: "meta/muse-spark-1.3", label: "Muse Spark 1.3" }],
      rates: new Map(),
    });
  const muse = evaluationCatalog().filter((model) => model.label === "Muse Spark 1.3");
  expect(muse.map((model) => [model.id, model.gateways])).toEqual([
    [
      "muse-spark-1.3",
      { openrouter: "meta/muse-spark-1.3", "vercel-ai-gateway": "meta/muse-spark-1.3" },
    ],
  ]);
});
