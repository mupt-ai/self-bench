import { expect, test } from "bun:test";
import { paretoFrontier } from "@mupt-ai/dari-pareto";
import { previewRelease } from "../src/public/release-build.js";
import { frontierOf } from "../src/public/release-rule.js";
import { approvedTasks, full, inputs, names, run } from "./support/release-fixture.js";

/** How runs resolve to settings: catalog ids across the catalog change, and credentials. */
const tPrev = names(1, 40);

test("a model no longer in the catalog keeps the name its runs recorded", () => {
  const retired = run({ model: "openai-terra56", results: { t1: 1 } });
  const preview = previewRelease(inputs({ runs: [retired], tasks: approvedTasks(["t1"]) }));
  expect(preview.settings[0]?.label).toBe(retired.modelLabel);
});

test("unresolvable settings (no credentials block, unknown credential) are ignored", () => {
  const legacy = full("legacy", tPrev);
  delete (legacy as { credentials?: unknown }).credentials;
  const unknown = full("unknown", tPrev, { credential: "deleted-and-purged" });
  const managed = full("managed", tPrev, { credential: "managed-model", provider: "openrouter" });
  const labels = previewRelease(inputs({ runs: [legacy, unknown, managed] })).settings.map(
    (setting) => setting.label,
  );
  expect(labels).toEqual(["MANAGED"]);
});

test("the frontier matches the Pareto package the charts draw with", () => {
  // The server cannot import the chart package (a browser dependency), so it keeps its own
  // frontier; this keeps the two in agreement, ties and duplicates included.
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let round = 0; round < 200; round += 1) {
    const settings = Array.from({ length: 1 + Math.floor(random() * 12) }, (_, index) => ({
      id: `s${index}`,
      // Coarse values, so ties and exact duplicates are common.
      accuracy: Math.round(random() * 10) * 10,
      costPerTaskUsd: Math.round(random() * 8) / 2,
    }));
    const ours = frontierOf(settings);
    const theirs = paretoFrontier(
      settings.map((setting) => ({
        id: setting.id,
        label: setting.id,
        x: setting.costPerTaskUsd,
        y: setting.accuracy,
      })),
    ).map((point) => point.id);
    expect([...ours].sort()).toEqual([...theirs].sort());
  }
});
