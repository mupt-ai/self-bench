import { expect, test } from "bun:test";
import type { ComparisonDraft } from "../src/evaluation/comparisons.js";
import { getEvaluation, initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

const post = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });

test("cancelling a live run fails its unfinished trials and stops its workflow", async () => {
  const fixture = await evaluationServer();
  try {
    const input: EvaluationInput = {
      ...evaluationInput(),
      repoId: fixture.repo.id,
      harnesses: ["codex", "pi"],
    };
    const run = initialEvaluation(input, "Model");
    const [done, live] = run.trials;
    if (!done || !live) throw new Error("Missing trials");
    run.status = "running";
    done.status = "completed";
    done.rewards = { reward: 1 };
    live.status = "running";
    await saveEvaluation(fixture.artifacts, run);
    const url = `${fixture.base}/${input.id}/cancel`;

    expect((await fixture.request(url, post({}), 2)).status).toBe(404);
    expect(
      (await fixture.request(url, { ...post({}), headers: { origin: "https://evil.test" } }))
        .status,
    ).toBe(403);
    expect(fixture.stops).toEqual([]);

    const response = await fixture.request(url, post({}));
    expect(response.status).toBe(200);
    const cancelled = await response.json();
    expect(cancelled.status).toBe("failed");
    expect(cancelled.error).toBe("Cancelled by avyay.");
    expect(cancelled.trials.map((trial: { status: string }) => trial.status)).toEqual([
      "completed",
      "failed",
    ]);
    expect(cancelled.trials[0].rewards).toEqual({ reward: 1 });
    expect(fixture.stops).toEqual([`evaluation/${fixture.repo.id}/${input.id}`]);

    // A repeated request leaves the record as it is but still stops the workflow, so a retry
    // works when the first request reached the record but not Temporal.
    const again = await (await fixture.request(url, post({}))).json();
    expect(again.revision).toBe(cancelled.revision);
    expect(fixture.stops).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

test("cancelling a comparison stops its runs and keeps resume from submitting the rest", async () => {
  const records = memoryVault();
  const fixture = await evaluationServer(records);
  try {
    const credential = async (kind: string, value: string) => {
      const response = await fixture.request(
        "/api/orgs/avyay/credentials",
        post({ name: kind, kind, value }),
      );
      return (await response.json()).id as string;
    };
    const modelKey = await credential("openai", "model-secret");
    const draft: ComparisonDraft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      models: [
        { catalogId: "gpt-6-sol", credentialId: modelKey, harnesses: ["codex"] },
        { catalogId: "gpt-6-astra", credentialId: modelKey, harnesses: ["codex"] },
      ],
      sandbox: "e2b",
      sandboxCredentialId: await credential("e2b", "sandbox-secret"),
    };
    fixture.failStart(true);
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    fixture.failStart(false);
    const [live, unsubmitted] = (await records.comparisons.find(draft.id))?.inputs ?? [];
    if (!live || !unsubmitted) throw new Error("Missing comparison inputs");
    // The first run reached a worker; the second was never submitted.
    const running = initialEvaluation(live, live.modelName);
    running.status = "running";
    await saveEvaluation(fixture.artifacts, running);

    const response = await fixture.request(
      `${fixture.base}/comparisons/${draft.id}/cancel`,
      post({}),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).runs.map((run: { status: string }) => run.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect((await getEvaluation(fixture.artifacts, fixture.repo.id, live.id))?.error).toBe(
      "Cancelled by avyay.",
    );
    await fixture.request(`${fixture.base}/comparisons/${draft.id}/resume`, post({}));
    expect(fixture.starts).toEqual([]);
  } finally {
    await fixture.close();
  }
});
