import { expect, test } from "bun:test";
import { comparisonSchema } from "../../../../src/evaluation/comparisons";
import { initialEvaluation } from "../../../../src/evaluation/store";
import type { EvaluationRun } from "../../../../src/evaluation/types";
import { evaluationInput } from "../../../../tests/support/evaluation-fixture";
import { retrySelection } from "./run-retry";

const ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const MODEL_CREDENTIAL = "0b8e4f7a-1c2d-4e3f-9a8b-7c6d5e4f3a2b";

function finishedRun(change: (run: EvaluationRun) => void = () => {}): EvaluationRun {
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      harnesses: ["pi"],
      tasks: ["a", "b", "c", "d"].map((taskId) => ({ runId: "batch", taskId, bundleKey: taskId })),
      model: "dari/routing",
      modelName: "dari/routing",
      sandbox: "modal",
      credentials: {
        modelCredentialId: MODEL_CREDENTIAL,
        sandboxCredentialId: "managed-sandbox",
        provider: "dari",
      },
    },
    "Dari Router",
  );
  run.status = "failed";
  const [passed, errored, cancelled, failedTests] = run.trials;
  Object.assign(passed ?? {}, { status: "completed", rewards: { reward: 1 } });
  Object.assign(errored ?? {}, { status: "failed", error: "Command failed (exit 1)" });
  Object.assign(cancelled ?? {}, { status: "failed", error: "Cancelled by someone." });
  Object.assign(failedTests ?? {}, { status: "completed", rewards: { reward: 0 } });
  change(run);
  return run;
}

test("a finished run retries only its errored tasks, as it ran them", () => {
  const retry = retrySelection(finishedRun(), "pi", ID);
  expect(retry?.errored).toBe(1);
  expect(retry?.selection).toEqual({
    id: ID,
    models: [{ catalogId: "dari/routing", credentialId: MODEL_CREDENTIAL, harnesses: ["pi"] }],
    sandbox: "managed",
    sandboxCredentialId: "managed-sandbox",
    tasks: [{ runId: "batch", taskId: "b" }],
    skipCompleted: true,
  });
  // The API accepts it as a repository's comparison.
  expect(() => comparisonSchema.parse(retry?.selection)).not.toThrow();
});

test("a custom model retries under its typed name, whatever route reached it", () => {
  for (const modelName of ["openai/my-model", "openrouter/my-model", "vercel/vendor/my-model"]) {
    const retry = retrySelection(
      finishedRun((run) => {
        run.model = "custom";
        run.modelName = modelName;
      }),
      "pi",
      ID,
    );
    expect(retry?.selection.models[0]).toMatchObject({
      catalogId: "custom",
      customModel: modelName.replace(/^[^/]+\//, ""),
    });
  }
});

test("live, deleted, benchmark, uncredentialed and error-free runs offer no retry", () => {
  for (const change of [
    (run: EvaluationRun) => {
      run.status = "running";
    },
    (run: EvaluationRun) => {
      run.deletedAt = "2026-10-26T00:00:00.000Z";
    },
    (run: EvaluationRun) => {
      delete run.repoId;
      run.benchmarkId = 3;
    },
    (run: EvaluationRun) => {
      delete run.credentials;
    },
    (run: EvaluationRun) => {
      run.trials = run.trials.filter((trial) => trial.status === "completed");
    },
  ])
    expect(retrySelection(finishedRun(change), "pi", ID)).toBeUndefined();
  // Another harness's errors are its own row's.
  expect(retrySelection(finishedRun(), "codex", ID)).toBeUndefined();
});
