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
});
