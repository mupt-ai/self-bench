import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts/local.js";
import {
  type ModelSummaryRequest,
  readModelSummaries,
  reportSections,
  summarizeModels,
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

test("a report's sections are read off by heading, and text before the first is dropped", () => {
  expect(
    reportSections(
      "Preamble.\n### Overall\nAll rush.\n\n### C1\nCareful.\n## c2 (GPT)\nHasty.\n### C1\nAgain.",
    ),
  ).toEqual(
    new Map([
      ["Overall", "All rush."],
      ["C1", "Careful."],
      ["C2", "Hasty."],
    ]),
  );
});

test("one report compares the chosen configurations, and keeps what the model said of each", async () => {
  const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "selfbench-summary-")));
  const own = scoredRun("gpt-own", { parser: 1, cache: 0, outside: 0 });
  const failed = own.trials.find((trial) => trial.taskId === "cache");
  if (failed) failed.failureSummary = { text: "It never invalidated the cache.", model: "x" };
  await saveEvaluation(store, own);
  await saveEvaluation(store, scoredRun("gpt-other", { parser: 0, cache: 1 }));
  await saveEvaluation(store, scoredRun("gpt-unchosen", { parser: 1, cache: 1 }));
  const vault = { ...memoryVault(), scopeOrg: async () => 7 };
  const key = "byok-summary-provider-secret";
  const credential = await vault.credentials.create(
    7,
    { name: "My Key", kind: "openai", auth: "api-key", value: key },
    {},
  );
  const request: ModelSummaryRequest = {
    repoId: 1,
    configurations: [configuration("gpt-own"), configuration("gpt-other")],
    // "outside" is not accepted, so its result is left out.
    tasks: ["parser", "cache"].map((taskId) => ({
      runId: "run-one",
      taskId,
      bundleKey: `tasks/${taskId}.tar.gz`,
    })),
    summary: { orgId: 7, credentialId: credential.id, model: "gpt-6-sol" },
  };
  let reply = {
    exitCode: 0,
    stdout:
      "### Overall\nBoth skip edge cases; C2 less so.\n### C1\nStrong on parsing.\n### C2\nStrong on caching.",
    stderr: "",
  };
  const materials: string[] = [];
  const command = async (_name: string, args: readonly string[], options?: CommandOptions) => {
    expect(options?.env?.OPENAI_API_KEY).toBe(key);
    const path = args.find((arg) => arg.startsWith("@"))?.slice(1);
    if (path) materials.push(await Bun.file(path).text());
    return reply;
  };
  const options = { vault, command, env: {}, redact: (text: string) => text };
  await summarizeModels(store, request, options);
  expect(materials).toHaveLength(1);
  expect(materials[0]).toContain('<configuration label="C1" passed="1 of 2">');
  expect(materials[0]).toContain('<task id="parser" outcomes="C1 passed, C2 failed">');
  expect(materials[0]).toContain('<failures configuration="C1">');
  expect(materials[0]).toContain("It never invalidated the cache.");
  expect(materials[0]).not.toContain("outside");
  expect(materials[0]).not.toContain("C3");
  expect(await readModelSummaries(store, { repoId: 1 })).toMatchObject({
    report: {
      overview: "Both skip edge cases; gpt-other · high reasoning · Codex less so.",
      model: "gpt-6-sol",
      summaries: [
        {
          configuration: configuration("gpt-own"),
          text: "Strong on parsing.",
          tasks: 2,
          passed: 1,
        },
        {
          configuration: configuration("gpt-other"),
          text: "Strong on caching.",
          tasks: 2,
          passed: 1,
        },
      ],
    },
  });

  reply = {
    exitCode: 1,
    stdout: "",
    stderr: '401 {"error":{"message":"Authentication failed.","type":"authentication_error"}}',
  };
  await expect(summarizeModels(store, request, options)).rejects.toThrow("Authentication failed.");
  const { report, failure } = await readModelSummaries(store, { repoId: 1 });
  expect(report?.overview).toStartWith("Both skip edge cases;");
  expect(failure?.message).toBe("Authentication failed.");
  // A reply without the sections asked for keeps no report.
  reply = { exitCode: 0, stdout: "They are all fine.", stderr: "" };
  await summarizeModels(store, request, options);
  expect((await readModelSummaries(store, { repoId: 2 })).report).toBeUndefined();
  expect((await readModelSummaries(store, { repoId: 1 })).failure?.message).toContain(
    "no usable answer",
  );
});

test("Model Summaries start for configurations scored on accepted tasks, through a saved key", async () => {
  const vault = memoryVault();
  const started: ModelSummaryRequest[] = [];
  // The configurations Temporal would describe the repository's summaries as running for.
  let running: string[] = [];
  // Whether another request's summaries start first, between the check and the start.
  let racing = false;
  const fixture = await evaluationServer(
    vault,
    {
      summarize: {
        start: async (request) => {
          started.push(request);
          return !racing;
        },
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
    expect(await (await fixture.request(url)).json()).toEqual({ available: true, running: [] });
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

    running = [];
    racing = true;
    expect((await post({ configurations: [configuration("gpt-own")], summary })).status).toBe(409);
  } finally {
    await fixture.close();
  }
});
