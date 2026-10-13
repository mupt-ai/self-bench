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

test("Dari pricing is a selected-model reference estimate, not a subscription bill", () => {
  const html = renderToStaticMarkup(
    <TokenCosts
      trial={{
        tokenUsage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        apiCostUsd: 0.12,
        costSource: "router-reference-rates",
      }}
    />,
  );
  expect(html).toContain("Dari-reported per-request reference-rate estimate");
  expect(html).toContain("Not an invoice or subscription charge");
  expect(html).not.toContain("Billed by Gateway");
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
