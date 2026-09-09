import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { initialEvaluation } from "../../../../src/evaluation/store";
import { evaluationInput } from "../../../../tests/support/evaluation-fixture";
import { evaluationRequestId, evaluationUrl } from "./api";
import { EvaluationResults, scores } from "./EvaluationResults";

test("request IDs work without secure-context randomUUID and URL scopes are encoded", () => {
  expect(evaluationRequestId()).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(evaluationRequestId()).not.toBe(evaluationRequestId());
  expect(evaluationUrl("org name", "owner/repo")).toBe(
    "/api/orgs/org%20name/repos/owner/repo/evaluations",
  );
});
test("results distinguish zero rewards from missing scores and escape solver text", () => {
  const run = initialEvaluation(evaluationInput(), "Test model");
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing trial");
  expect(scores(trial)).toBe("Not Scored");
  trial.rewards = { reward: 0 };
  expect(scores(trial)).toBe("reward: 0");
  trial.steps = [{ id: "one", role: "agent", text: "<script>steal()</script>", tools: [] }];
  run.status = "completed";
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <EvaluationResults run={run} baseUrl="/api/evaluations" repo="owner/repo" />
    </MemoryRouter>,
  );
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("Solver’s Final Response");
  expect(html).toContain("Verifier Scores");
  expect(html).toContain("Harbor and Solver Output");
});
