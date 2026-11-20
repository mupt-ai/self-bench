import { expect, test } from "bun:test";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { dariRouter } from "../../../../src/evaluation/catalog";
import { comparisonSchema } from "../../../../src/evaluation/comparisons";
import { initialEvaluation } from "../../../../src/evaluation/store";
import type { EvaluationRun } from "../../../../src/evaluation/types";
import { evaluationInput } from "../../../../tests/support/evaluation-fixture";
import { retryModelCredentials, retrySandboxes, retrySelection } from "./run-retry";

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

test("a finished run retries only its errored and cancelled tasks, as it ran them", () => {
  const retry = retrySelection(finishedRun(), "pi", ID);
  expect(retry?.errored).toBe(1);
  expect(retry?.cancelled).toBe(1);
  expect(retry?.selection).toEqual({
    id: ID,
    models: [{ catalogId: "dari/routing", credentialId: MODEL_CREDENTIAL, harnesses: ["pi"] }],
    sandbox: "managed",
    sandboxCredentialId: "managed-sandbox",
    tasks: [
      { runId: "batch", taskId: "b" },
      { runId: "batch", taskId: "c" },
    ],
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

test("a benchmark's run retries its errored tasks with the judge credential it ran with", () => {
  const judgeCredentialId = "5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d";
  const retry = retrySelection(
    finishedRun((run) => {
      delete run.repoId;
      run.benchmarkId = 3;
      if (run.credentials) run.credentials.judgeCredentialId = judgeCredentialId;
    }),
    "pi",
    ID,
  );
  expect(retry?.selection.judgeCredentialId).toBe(judgeCredentialId);
  expect(() => comparisonSchema.parse(retry?.selection)).not.toThrow();
});

test("live, deleted, uncredentialed and error-free runs offer no retry", () => {
  for (const change of [
    (run: EvaluationRun) => {
      run.status = "running";
    },
    (run: EvaluationRun) => {
      run.deletedAt = "2026-10-26T00:00:00.000Z";
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

const E2B_KEY = "3a1e9f42-6b7c-4d8e-9f01-2a3b4c5d6e7f";
const MODAL_KEY = "7c2d4e6f-8a9b-4c1d-8e2f-3a4b5c6d7e8f";
const SAVED = [
  { id: E2B_KEY, name: "Team E2B", kind: "e2b", auth: "api-key", createdAt: "2026-10-01" },
  { id: MODAL_KEY, name: "Modal", kind: "modal", auth: "api-key", createdAt: "2026-10-01" },
  { id: "openai-key", name: "OpenAI", kind: "openai", auth: "api-key", createdAt: "2026-10-01" },
] as const satisfies readonly CredentialInfo[];

test("a retry may move to another saved sandbox, which sets its provider", () => {
  const retry = retrySelection(finishedRun(), "pi", ID, E2B_KEY, SAVED);
  expect(retry?.selection).toMatchObject({ sandbox: "e2b", sandboxCredentialId: E2B_KEY });
  expect(() => comparisonSchema.parse(retry?.selection)).not.toThrow();
});

test("the sandbox choices are the run's own first, then the org's saved sandboxes", () => {
  expect(retrySandboxes(finishedRun(), SAVED)).toEqual([
    { id: "managed-sandbox", label: "Managed" },
    { id: E2B_KEY, label: "E2B · Team E2B" },
    { id: MODAL_KEY, label: "Modal · Modal" },
  ]);
  const onModal = finishedRun((run) => {
    if (run.credentials) run.credentials.sandboxCredentialId = MODAL_KEY;
  });
  expect(retrySandboxes(onModal, SAVED).map((choice) => choice.id)).toEqual([MODAL_KEY, E2B_KEY]);
});

test("a bring-your-own sandbox stays a choice while the saved list has not loaded", () => {
  const onModal = finishedRun((run) => {
    if (run.credentials) run.credentials.sandboxCredentialId = MODAL_KEY;
  });
  expect(retrySandboxes(onModal, [])).toEqual([
    { id: MODAL_KEY, label: "Modal · Run's Credential" },
  ]);
  expect(retrySelection(onModal, "pi", ID, MODAL_KEY, [])?.selection).toMatchObject({
    sandbox: "modal",
    sandboxCredentialId: MODAL_KEY,
  });
});

test("a loaded saved list without the run's sandbox means it was deleted", () => {
  const onModal = finishedRun((run) => {
    if (run.credentials) run.credentials.sandboxCredentialId = MODAL_KEY;
  });
  const others = SAVED.filter((credential) => credential.id !== MODAL_KEY);
  expect(retrySandboxes(onModal, others).map((choice) => choice.id)).not.toContain(MODAL_KEY);
});

test("a retry may run on another model credential, keeping everything else as it ran", () => {
  const other = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
  const retry = retrySelection(finishedRun(), "pi", ID, undefined, [], other);
  expect(retry?.selection.models).toEqual([
    { catalogId: "dari/routing", credentialId: other, harnesses: ["pi"] },
  ]);
  expect(comparisonSchema.safeParse(retry?.selection).success).toBe(true);
  expect(retrySelection(finishedRun(), "pi", ID)?.selection.models[0]?.credentialId).toBe(
    MODEL_CREDENTIAL,
  );
});

test("a retry offers the run's own model credential first, then others that run its model", () => {
  const key = (
    id: string,
    kind: CredentialInfo["kind"],
    auth: CredentialInfo["auth"] = "api-key",
  ) => ({ id, name: id, kind, auth, createdAt: "2026-11-01T00:00:00Z" }) as CredentialInfo;
  const saved = [
    key("other-router", "dari"),
    key("openai", "openai"),
    key("modal", "modal"),
    key(MODEL_CREDENTIAL, "dari"),
  ];
  const catalog = [dariRouter];
  const ids = (offered: readonly CredentialInfo[]) => offered.map((credential) => credential.id);
  expect(ids(retryModelCredentials(finishedRun(), "pi", saved, catalog))).toEqual([
    MODEL_CREDENTIAL,
    "other-router",
  ]);
  // Before the catalog loads, only the run's own.
  expect(ids(retryModelCredentials(finishedRun(), "pi", saved))).toEqual([MODEL_CREDENTIAL]);
  // A run whose sign-in is gone retries on a Dari connection that serves its model.
  const gpt = { ...dariRouter, id: "gpt-x", provider: "openai" as const, model: "gpt-x" };
  const dari = {
    ...key("dari-connection", "dari-link", "dari-link"),
    linkModels: { models: [{ id: "openai/gpt-x" }], prefixes: [] },
  };
  const signedIn = finishedRun((run) => {
    run.model = "gpt-x";
  });
  expect(ids(retryModelCredentials(signedIn, "pi", [dari], [gpt]))).toEqual(["dari-connection"]);
  // A model only Dari connections list: another connection serving it is offered.
  const glm = finishedRun((run) => {
    run.model = "opencode-go/glm-5.3";
  });
  const other = {
    ...key("other-connection", "dari-link", "dari-link"),
    linkModels: { models: [{ id: "opencode-go/glm-5.3" }], prefixes: [] },
  };
  expect(ids(retryModelCredentials(glm, "pi", [dari, other], [gpt]))).toEqual(["other-connection"]);
});
