import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { initialEvaluation } from "../../../../src/evaluation/store";
import { evaluationInput } from "../../../../tests/support/evaluation-fixture";
import { evaluationRequestId, evaluationUrl } from "./api";
import { ResultGroupRows } from "./ResultsBatchRows";
import { outcomeOf } from "./results-model";
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
  trial.status = "completed";
  expect(outcomeOf(trial)).toBe("unscored");
  trial.rewards = { reward: 0 };
  expect(outcomeOf(trial)).toBe("failed");
  trial.steps = [
    { id: "one", role: "agent", text: "Reading the parser.", tools: [] },
    { id: "two", role: "agent", text: "Patched the parser.", tools: [] },
  ];
  expect(renderToStaticMarkup(<TrialDetails trial={trial} />)).not.toContain("Why It Failed");
  trial.failureSummary = { text: "The parser still drops trailing commas.", model: "gpt-6-luna" };
  const html = renderToStaticMarkup(<TrialDetails trial={trial} />);
  expect(html).toContain("Solver’s Final Response</h4><p>Patched the parser.</p>");
  expect(html).toMatch(/Why It Failed<\/h4><p[^>]*>The parser still drops trailing commas\.<\/p>/);
  expect(html).toContain("Summarized by GPT-6 Luna");
});
test("only a live run offers cancellation, and every run deletion", () => {
  const run = initialEvaluation(evaluationInput(), "Test model");
  const render = () =>
    renderToStaticMarkup(
      <MemoryRouter>
        <table>
          <tbody>
            <ResultGroupRows
              run={run}
              baseUrl="/api/evaluations"
              onChanged={() => {}}
              name="test Run"
              heading="Run"
              results={[]}
              open
              shown={new Set()}
              sort={undefined}
              onToggle={() => {}}
              onToggleOutcome={() => {}}
              onSort={() => {}}
              onOpenTask={() => {}}
            />
          </tbody>
        </table>
      </MemoryRouter>,
    );
  run.status = "running";
  expect(render()).toContain("Cancel Run");
  expect(render()).toContain("Delete Run");
  run.status = "failed";
  expect(render()).not.toContain("Cancel Run");
  expect(render()).toContain("Delete Run");
});
test("a finished run's row offers to retry its errored tasks", () => {
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      credentials: {
        modelCredentialId: "model",
        sandboxCredentialId: "sandbox",
        provider: "openai",
      },
    },
    "Test model",
  );
  const [trial] = run.trials;
  if (!trial) throw new Error("missing trial");
  const render = () =>
    renderToStaticMarkup(
      <MemoryRouter>
        <table>
          <tbody>
            <ResultGroupRows
              run={run}
              baseUrl="/api/evaluations"
              pages="/repos/acme/widgets"
              onChanged={() => {}}
              name="test Run"
              heading="Run"
              results={[{ run, trial, task: "run-one/task-one", outcome: outcomeOf(trial) }]}
              open
              shown={new Set()}
              sort={undefined}
              onToggle={() => {}}
              onToggleOutcome={() => {}}
              onSort={() => {}}
              onOpenTask={() => {}}
            />
          </tbody>
        </table>
      </MemoryRouter>,
    );
  run.status = "running";
  trial.status = "running";
  expect(render()).not.toContain("Retry");
  run.status = "failed";
  Object.assign(trial, { status: "failed", error: "Command failed (exit 1)" });
  expect(render()).toContain("Retry 1 Errored Task");
});
