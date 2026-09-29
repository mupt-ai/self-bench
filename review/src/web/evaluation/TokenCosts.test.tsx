import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { initialEvaluation } from "../../../../src/evaluation/store";
import { evaluationInput } from "../../../../tests/support/evaluation-fixture";
import { TokenCosts } from "./TokenCosts";

test("token usage without pricing explains why the cost is missing", () => {
  const run = initialEvaluation(evaluationInput(), "user-supplied model");
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing fixture trial");
  trial.tokenUsage = { input: 12, cacheRead: 4, cacheWrite: 2, output: 8 };
  const html = renderToStaticMarkup(<TokenCosts trial={trial} />);
  expect(html).toContain("Cost unavailable: incomplete pricing or usage records.");
  expect(html).not.toContain("Inferred");
});

test("inferred sign-in cache writes are labeled as inferred", () => {
  const run = initialEvaluation(evaluationInput(), "GPT-6 Luna");
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing fixture trial");
  Object.assign(trial, {
    tokenUsage: { input: 0, cacheRead: 1_510_144, cacheWrite: 73_194, output: 15_836 },
    cacheWritesInferred: true,
    apiCostUsd: 0.032,
    costSource: "reference-rates",
  });
  const html = renderToStaticMarkup(<TokenCosts trial={trial} />);
  expect(html).toContain("Cache Writes (Inferred)");
  expect(html).toContain("Codex sign-in does not report cache writes");
});
