import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts/local.js";
import {
  type ModelSummaryRequest,
  readModelSummaries,
  summarizeModel,
} from "../src/evaluation/model-summary.js";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput, EvaluationRun } from "../src/evaluation/types.js";
import type { CommandOptions } from "../src/lib/process.js";
import { evaluationEnv, evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

const credentials = {
  modelCredentialId: "model-key",
  sandboxCredentialId: "sandbox-key",
  provider: "openai" as const,
};

/** A completed run of `model` on harness `codex`, scoring each task as `rewards` says. */
function scoredRun(
  model: string,
  rewards: Record<string, number>,
  change: (input: EvaluationInput) => void = () => {},
): EvaluationRun {
  const input: EvaluationInput = {
    ...evaluationInput(),
    model,
    modelName: `openai/${model}`,
    thinking: "high",
    credentials,
    tasks: Object.keys(rewards).map((taskId) => ({
      runId: "run-one",
      taskId,
      bundleKey: `tasks/${taskId}.tar.gz`,
    })),
  };
  change(input);
  const run = initialEvaluation(input, model);
  run.status = "completed";
  for (const trial of run.trials)
    Object.assign(trial, {
      status: "completed",
      rewards: { reward: rewards[trial.taskId] },
      modelVerified: true,
      apiCostUsd: 0.1,
      finishedAt: run.createdAt,
    });
  return run;
}

const configuration = (model: string) => JSON.stringify([model, "codex", "high"]);

test("a summary reads the configuration's results against the others', and keeps what the model said", async () => {
  const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "selfbench-summary-")));
  const own = scoredRun("gpt-own", { parser: 1, cache: 0, outside: 0 });
  const failed = own.trials.find((trial) => trial.taskId === "cache");
  if (failed) failed.failureSummary = { text: "It never invalidated the cache.", model: "x" };
  await saveEvaluation(store, own);
  await saveEvaluation(store, scoredRun("gpt-other", { parser: 0, cache: 1 }));
  const vault = { ...memoryVault(), scopeOrg: async () => 7 };
  const key = "byok-summary-provider-secret";
  const credential = await vault.credentials.create(
    7,
    { name: "My Key", kind: "openai", auth: "api-key", value: key },
    {},
  );
  const request: ModelSummaryRequest = {
    repoId: 1,
    configurations: [configuration("gpt-own")],
    // "outside" is not accepted, so its result is left out.
    tasks: ["parser", "cache"].map((taskId) => ({
      runId: "run-one",
      taskId,
      bundleKey: `tasks/${taskId}.tar.gz`,
    })),
    summary: { orgId: 7, credentialId: credential.id, model: "gpt-6-sol" },
  };
  let reply = { exitCode: 0, stdout: "Strong on parsing; misses cache invalidation.", stderr: "" };
  const prompts: string[] = [];
  const materials: string[] = [];
  const command = async (_name: string, args: readonly string[], options?: CommandOptions) => {
    expect(options?.env?.OPENAI_API_KEY).toBe(key);
    prompts.push(args.join(" "));
    const path = args.find((arg) => arg.startsWith("@"))?.slice(1);
    if (path) materials.push(await Bun.file(path).text());
    return reply;
  };
  const options = { vault, command, env: {}, redact: (text: string) => text };
  await summarizeModel(store, request, configuration("gpt-own"), options);
  expect(prompts[0]).toContain("What does this configuration do well");
  expect(materials[0]).toContain("Passed 1 of 2 scored tasks.");
  expect(materials[0]).toContain('<passed_task id="parser" others_passed="0 of 1">');
  expect(materials[0]).toContain('<failed_task id="cache" others_passed="1 of 1">');
  expect(materials[0]).toContain("It never invalidated the cache.");
  expect(materials[0]).not.toContain("outside");
  expect(await readModelSummaries(store, { repoId: 1 })).toMatchObject({
    summaries: [
      {
        configuration: configuration("gpt-own"),
        text: "Strong on parsing; misses cache invalidation.",
        model: "gpt-6-sol",
        tasks: 2,
        passed: 1,
      },
    ],
    failures: [],
  });

  reply = {
    exitCode: 1,
    stdout: "",
    stderr: '401 {"error":{"message":"Authentication failed.","type":"authentication_error"}}',
  };
  await expect(summarizeModel(store, request, configuration("gpt-own"), options)).rejects.toThrow(
    "Authentication failed.",
  );
  const { summaries, failures } = await readModelSummaries(store, { repoId: 1 });
  expect(summaries).toHaveLength(1);
  expect(failures).toMatchObject([
    { configuration: configuration("gpt-own"), message: "Authentication failed." },
  ]);
  // Another scope's summaries are its own.
  expect(await readModelSummaries(store, { repoId: 2 })).toEqual({ summaries: [], failures: [] });
});

test("Model Summaries start for configurations scored on accepted tasks, through a saved key", async () => {
  const vault = memoryVault();
  const started: ModelSummaryRequest[] = [];
  // The configurations Temporal would describe the repository's summaries as running for.
  let running: string[] = [];
  const fixture = await evaluationServer(
    vault,
    {
      summarize: {
        start: async (request) => void started.push(request),
        running: async () => running,
      },
    },
    { ...evaluationEnv, SELFBENCH_MANAGED_OFFERING: "false" },
  );
  try {
    await saveEvaluation(
      fixture.artifacts,
      scoredRun("gpt-own", { "task-one": 0 }, (input) => {
        input.repoId = fixture.repo.id;
      }),
    );
    const own = await vault.credentials.create(
      fixture.repo.orgId,
      { name: "openai", kind: "openai", auth: "api-key", value: "sk-test-own-key" },
      {},
    );
    const url = `${fixture.base}/summaries`;
    const post = (body: unknown) =>
      fixture.request(url, { method: "POST", body: JSON.stringify(body) });
    const summary = { credentialId: own.id, model: "gpt-6-sol" };
    expect(await (await fixture.request(url)).json()).toEqual({
      available: true,
      running: [],
      summaries: [],
      failures: [],
    });
    expect((await post({ configurations: [], summary })).status).toBe(400);
    expect(
      (
        await post({
          configurations: [configuration("gpt-own")],
          summary: { ...summary, model: "not-a-model" },
        })
      ).status,
    ).toBe(400);
    expect((await post({ configurations: [configuration("gpt-unrun")], summary })).status).toBe(
      409,
    );
    const response = await post({
      configurations: [configuration("gpt-own"), configuration("gpt-unrun")],
      summary,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ configurations: [configuration("gpt-own")] });
    expect(started).toEqual([
      {
        repoId: fixture.repo.id,
        configurations: [configuration("gpt-own")],
        tasks: [{ runId: "run-one", taskId: "task-one", bundleKey: "tasks/task.tar.gz" }],
        summary: { orgId: fixture.repo.orgId, credentialId: own.id, model: "gpt-6-sol" },
      },
    ]);
    expect(JSON.stringify(started)).not.toContain("sk-test-own-key");

    running = [configuration("gpt-own")];
    expect((await (await fixture.request(url)).json()).running).toEqual([configuration("gpt-own")]);
    expect((await post({ configurations: [configuration("gpt-own")], summary })).status).toBe(409);
  } finally {
    await fixture.close();
  }
});
