import { describe, expect, test } from "bun:test";
import { buildCouplingEvidence, discoverContractArtifacts } from "../src/coupling.js";

describe("coupling evidence", () => {
  test("rejects gold-only response fields asserted by held-out tests", () => {
    const testPatch = patch(
      "tests/runtime.test.ts",
      '+      routing_strategy: "heuristic",',
      "+      heuristic_config: { price_weight: 1 },",
      '+      model_prices: { "openai/cheap": { input: 1, output: 2 } },',
    );
    const goldPatch = patch(
      "src/types.ts",
      "+  routing_strategy?: RoutingStrategy;",
      "+  heuristic_config?: HeuristicConfig;",
      "+  model_prices?: Record<string, ModelPrice>;",
    );

    const evidence = buildCouplingEvidence({
      prompt: "Use the resolved strategy, weighting configuration, and model prices.",
      testPatch,
      goldPatch,
      baseArtifacts: new Set(),
    });

    expect(evidence.blockers).toHaveLength(3);
    expect(evidence.blockers.join("\n")).toContain('field_name "routing_strategy"');
    expect(evidence.blockers.join("\n")).toContain('field_name "heuristic_config"');
    expect(evidence.blockers.join("\n")).toContain('field_name "model_prices"');
  });

  test("accepts exact contracts established by the prompt or base repository", () => {
    const testPatch = patch(
      "tests/endpoint.test.ts",
      '+fetch("/v1/widgets")',
      '+expect(body["widget_id"]).toBe("w_1");',
    );
    const goldPatch = patch(
      "src/endpoint.ts",
      '+router.post("/v1/widgets", handler);',
      "+return { widget_id: widget.id };",
    );

    const evidence = buildCouplingEvidence({
      prompt: "Expose POST /v1/widgets.",
      testPatch,
      goldPatch,
      baseArtifacts: new Set(["widget_id"]),
    });

    expect(evidence.blockers).toEqual([]);
    expect(evidence.artifacts).toHaveLength(2);
  });

  test("ignores fixture values and assertions not introduced by the gold patch", () => {
    const candidates = discoverContractArtifacts(
      patch(
        "tests/example.test.ts",
        "+expect(response.status).toBe(200);",
        '+expect(response.json()["organization_id"]).toBe("org_test");',
      ),
    );
    const evidence = buildCouplingEvidence({
      prompt: "Return the organization.",
      testPatch: patch(
        "tests/example.test.ts",
        "+expect(response.status).toBe(200);",
        '+expect(response.json()["organization_id"]).toBe("org_test");',
      ),
      goldPatch: patch("src/example.ts", "+return loadOrganization();"),
      baseArtifacts: new Set(),
    });

    expect(candidates.some((candidate) => candidate.artifact === "org_test")).toBe(false);
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.blockers).toEqual([]);
  });
});

function patch(path: string, ...lines: string[]): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...lines].join("\n");
}
