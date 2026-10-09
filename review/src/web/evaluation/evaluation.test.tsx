import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { initialEvaluation } from "../../../../src/evaluation/store";
import { evaluationInput } from "../../../../tests/support/evaluation-fixture";
import { evaluationRequestId, evaluationUrl } from "./api";
import { EvaluationResults, scores } from "./EvaluationResults";
import { TrialDetails } from "./TrialDetails";

test("request IDs work without secure-context randomUUID and URL scopes are encoded", () => {
  expect(evaluationRequestId()).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(evaluationRequestId()).not.toBe(evaluationRequestId());
  expect(evaluationUrl("org name", "owner/repo")).toBe(
    "/api/orgs/org%20name/repos/owner/repo/evaluations",
  );
});
test("results distinguish zero rewards from missing scores and show the last solver message and why it failed", () => {
  const run = initialEvaluation(evaluationInput(), "Test model");
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing trial");
  expect(scores(trial)).toBe("Not Scored");
  trial.rewards = { reward: 0 };
  expect(scores(trial)).toBe("reward: 0");
  trial.steps = [
    { id: "one", role: "agent", text: "Reading the parser.", tools: [] },
    { id: "two", role: "agent", text: "Patched the parser.", tools: [] },
  ];
  expect(renderToStaticMarkup(<TrialDetails trial={trial} />)).not.toContain("Why It Failed");
  trial.failureSummary = "The parser still drops trailing commas.";
  const html = renderToStaticMarkup(<TrialDetails trial={trial} />);
  expect(html).toContain("Solver’s Final Response</h4><p>Patched the parser.</p>");
  expect(html).toMatch(/Why It Failed<\/h4><p[^>]*>The parser still drops trailing commas\.<\/p>/);
  expect(html).toContain("Summarized by GPT-6 Luna");
});
test("only a live run offers cancellation", () => {
  const run = initialEvaluation(evaluationInput(), "Test model");
  const render = () =>
    renderToStaticMarkup(
      <MemoryRouter>
        <EvaluationResults
          run={run}
          baseUrl="/api/evaluations"
          repo="owner/repo"
          onCancelled={() => {}}
        />
      </MemoryRouter>,
    );
  run.status = "running";
  expect(render()).toContain("Cancel Run");
  run.status = "failed";
  expect(render()).not.toContain("Cancel Run");
});
