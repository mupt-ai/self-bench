import { expect, test } from "bun:test";
import { scopePath } from "../src/evaluation/scope.js";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput, EvaluationRun, EvaluationTrial } from "../src/evaluation/types.js";
import { evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

/** A completed run of `model` on harness `codex` in the repository, each trial as `trials` says. */
function run(
  repoId: number,
  model: string,
  trials: Record<string, Partial<EvaluationTrial>>,
): EvaluationRun {
  const input: EvaluationInput = {
    ...evaluationInput(),
    repoId,
    model,
    modelName: `openai/${model}`,
    thinking: "high",
    credentials: { modelCredentialId: "key", sandboxCredentialId: "box", provider: "openai" },
    tasks: Object.keys(trials).map((taskId) => ({
      runId: "run-one",
      taskId,
      bundleKey: `tasks/${taskId}.tar.gz`,
    })),
  };
  const evaluation = initialEvaluation(input, model);
  evaluation.status = "completed";
  for (const trial of evaluation.trials)
    Object.assign(trial, {
      status: "completed",
      modelVerified: true,
      apiCostUsd: 0.1,
      finishedAt: evaluation.createdAt,
      ...trials[trial.taskId],
    });
  return evaluation;
}

test("results score each configuration on accepted tasks, and one task's view adds its failures and audit", async () => {
  const fixture = await evaluationServer(memoryVault());
  try {
    const repoId = fixture.repo.id;
    const passed = { rewards: { reward: 1 } };
    const failed = {
      rewards: { reward: 0 },
      failureSummary: { text: "It edited the wrong file.", model: "gpt-6-sol" },
    };
    await saveEvaluation(fixture.artifacts, run(repoId, "gpt-strong", { "task-one": passed }));
    // A task that is not accepted, and a trial not scored, count for nothing.
    await saveEvaluation(
      fixture.artifacts,
      run(repoId, "gpt-weak", { "task-one": failed, "task-unaccepted": passed }),
    );
    await saveEvaluation(
      fixture.artifacts,
      run(repoId, "gpt-errored", { "task-one": { status: "failed", rewards: {} } }),
    );

    const response = await fixture.request(`${fixture.base}/results`);
    expect(response.status).toBe(200);
    const report = await response.json();
    const strong = JSON.stringify(["gpt-strong", "codex", "high"]);
    const weak = JSON.stringify(["gpt-weak", "codex", "high"]);
    expect(report.tasks).toBe(1);
    expect(
      report.configurations.map((row: { key: string; passRate: number; scored: number }) => [
        row.key,
        row.passRate,
        row.scored,
      ]),
    ).toEqual([
      [strong, 100, 1],
      [weak, 0, 1],
    ]);
    expect(report.configurations[0].costPerTaskUsd).toBeCloseTo(0.1);
    expect(report.taskResults).toEqual([
      expect.objectContaining({ runId: "run-one", taskId: "task-one", scored: 2, passed: 1 }),
    ]);

    await fixture.artifacts.put(
      `audits/${scopePath({ repoId })}/run-one/task-one.json`,
      Buffer.from(
        JSON.stringify({
          verdict: "fair",
          text: "The tests check only what the instruction asks.",
          model: "gpt-6-sol",
          attempts: 2,
          failures: 1,
          auditedAt: "2026-11-06T00:00:00.000Z",
        }),
      ),
      "application/json",
    );
    const one = await (
      await fixture.request(`${fixture.base}/results?runId=run-one&taskId=task-one`)
    ).json();
    expect(one.audit.verdict).toBe("fair");
    expect(one.taskResults[0].results).toContainEqual(
      expect.objectContaining({
        configuration: weak,
        passed: false,
        harness: "codex",
        failureSummary: "It edited the wrong file.",
      }),
    );
    const missing = await fixture.request(`${fixture.base}/results?runId=run-one&taskId=nope`);
    expect(missing.status).toBe(404);
  } finally {
    await fixture.close();
  }
});

test("a trial a cyber classifier blocked is a failure counted apart, and an infra failure is not scored", async () => {
  const fixture = await evaluationServer(memoryVault());
  try {
    const repoId = fixture.repo.id;
    const blocked = run(repoId, "gpt-blocked", {
      "task-one": {
        status: "completed",
        rewards: { reward: 0 },
        cyberBlocked: true,
        error: "Cyber safeguards flagged this message.",
      },
    });
    // Its block came before any call was priced or verified, so it has neither.
    for (const trial of blocked.trials) {
      delete trial.apiCostUsd;
      delete trial.modelVerified;
    }
    // A block by a model other than the one requested is not that setting's result.
    const misrouted = run(repoId, "gpt-misrouted", {
      "task-one": {
        status: "completed",
        rewards: { reward: 0 },
        cyberBlocked: true,
        modelVerified: false,
      },
    });
    await saveEvaluation(
      fixture.artifacts,
      run(repoId, "gpt-guarded", { "task-one": { rewards: { reward: 1 } } }),
    );
    await saveEvaluation(fixture.artifacts, blocked);
    await saveEvaluation(fixture.artifacts, misrouted);
    await saveEvaluation(
      fixture.artifacts,
      run(repoId, "gpt-imaged", {
        "task-one": { status: "failed", rewards: {}, error: "E2B image build failed" },
      }),
    );

    const report = await (await fixture.request(`${fixture.base}/results`)).json();
    const guarded = JSON.stringify(["gpt-guarded", "codex", "high"]);
    const guardedBlocked = JSON.stringify(["gpt-blocked", "codex", "high"]);
    expect(
      report.configurations.map(
        (row: {
          key: string;
          passRate: number;
          scored: number;
          passed: number;
          blocked: number;
        }) => [row.key, row.passRate, row.scored, row.passed, row.blocked],
      ),
    ).toEqual([
      [guarded, 100, 1, 1, 0],
      [guardedBlocked, 0, 1, 0, 1],
    ]);
    expect(report.taskResults[0]).toMatchObject({ scored: 2, passed: 1 });
    expect(report.taskResults[0].results).toContainEqual(
      expect.objectContaining({ configuration: guardedBlocked, passed: false, blocked: true }),
    );
  } finally {
    await fixture.close();
  }
});
