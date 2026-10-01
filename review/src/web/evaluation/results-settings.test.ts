import { expect, test } from "bun:test";
import { eligibleTrial } from "../../../../src/evaluation/eligible";
import { type CredentialFacts, resultsBySetting } from "../../../../src/public/release-results";
import type { EvaluationRun } from "./api";
import { at, credentials, errored, NOW, passed, run, type TrialSpec } from "./results-fixture";
import { configurationsOf } from "./results-model";

/** One catalog model reached three ways: its provider's API key, OpenRouter, a ChatGPT sign-in. */
const sol = { model: "gpt-6.1-sol", modelName: "openai/gpt-6.1-sol", modelLabel: "gpt-6.1-sol" };
const viaKey = (id: string, options: Partial<EvaluationRun>, trials: TrialSpec[]) =>
  run(id, { ...sol, ...options }, trials);
const viaOpenRouter = (id: string, options: Partial<EvaluationRun>, trials: TrialSpec[]) =>
  run(
    id,
    {
      ...options,
      model: "openai/gpt-6.1-sol",
      modelName: "openrouter/openai/gpt-6.1-sol",
      modelLabel: "openai/gpt-6.1-sol",
      credentials: {
        modelCredentialId: "managed-model",
        sandboxCredentialId: "modal",
        provider: "openrouter",
      },
    },
    trials,
  );
const viaSignIn = (id: string, options: Partial<EvaluationRun>, trials: TrialSpec[]) =>
  run(
    id,
    {
      ...sol,
      ...options,
      credentials: {
        modelCredentialId: "chatgpt",
        sandboxCredentialId: "modal",
        provider: "openai",
        auth: "codex-login",
      },
    },
    trials,
  );
const crash = (taskId: string) => errored(taskId, "Harbor exited with code 137");

test("a model's routes are one configuration, as in a release, and each run says its route", () => {
  const configurations = configurationsOf(
    [
      viaKey("key", { comparisonId: "c1", createdAt: at(300) }, [
        passed("task-1"),
        passed("task-2"),
      ]),
      viaOpenRouter("router", { comparisonId: "c2", createdAt: at(200) }, [crash("task-1")]),
      // One comparison may run a model two ways; each run keeps its own row.
      viaSignIn("sign-in", { comparisonId: "c2", createdAt: at(100) }, [
        { ...passed("task-2"), finishedAt: at(50) },
      ]),
    ],
    credentials,
    NOW,
  );
  expect(configurations).toHaveLength(1);
  const [configuration] = configurations;
  expect(configuration).toMatchObject({
    label: "GPT-6.1 Sol",
    provider: "openai",
    modelName: "openai/gpt-6.1-sol",
    routes: ["OpenAI API Key", "OpenRouter", "ChatGPT Sign-In"],
  });
  expect(configuration?.batches.map((batch) => [batch.id, batch.route])).toEqual([
    ["key", "OpenAI API Key"],
    ["router", "OpenRouter"],
    ["sign-in", "ChatGPT Sign-In"],
  ]);
  // OpenRouter's crash doesn't replace the API key's pass; the sign-in's later pass does.
  expect(configuration?.latest.map((result) => [result.trial.taskId, result.run.id])).toEqual([
    ["task-1", "key"],
    ["task-2", "sign-in"],
  ]);
});

test("custom endpoints serving one model name are one configuration, each run with its host", () => {
  const [configuration, ...rest] = configurationsOf(
    [
      run("a", { credential: "gpu-a", createdAt: at(300) }, [passed("task-1")]),
      run("b", { credential: "gpu-b", createdAt: at(200) }, [passed("task-2")]),
      // Its credential was deleted since, so the app no longer knows its endpoint.
      run("gone", { credential: "gpu-gone", createdAt: at(100) }, [passed("task-3")]),
    ],
    credentials,
    NOW,
  );
  expect(rest).toEqual([]);
  expect(configuration).toMatchObject({
    label: "llama-70b",
    provider: "custom",
    routes: ["gpu.example.test/a/v1", "gpu.example.test/b/v1", "Custom Endpoint"],
  });
  expect(configuration?.latest).toHaveLength(3);
});

test("a run from before runs recorded their credentials is left out, as a release leaves it", () => {
  const { credentials: _, ...unrecorded } = run("old", {}, [passed("task-1")]);
  const recorded = run("new", { createdAt: at(100) }, [passed("task-2")]);
  const [configuration, ...rest] = configurationsOf([unrecorded, recorded], credentials, NOW);
  expect(rest).toEqual([]);
  expect(configuration?.latest.map((result) => result.run.id)).toEqual(["new"]);
});

test("configurations and the results they count are a release's settings and its results", () => {
  const runs = [
    viaKey("key", { createdAt: at(400) }, [
      // Started first but finished last: a release counts it, as the app does.
      { ...passed("task-1"), finishedAt: at(20) },
      passed("task-2"),
    ]),
    viaOpenRouter("router", { createdAt: at(300) }, [
      { ...passed("task-1"), rewards: { reward: 0 }, finishedAt: at(60) },
      crash("task-2"),
    ]),
    viaSignIn("sign-in", { createdAt: at(200), thinking: "low" }, [passed("task-1")]),
    run("a", { credential: "gpu-a", createdAt: at(300) }, [passed("task-1")]),
    run("b", { credential: "gpu-b", createdAt: at(100) }, [
      { ...passed("task-1"), finishedAt: at(10) },
    ]),
  ];
  const release = resultsBySetting(
    runs,
    new Map<string, CredentialFacts>([
      ...credentials.map(({ id, auth, endpoint }) => [id, { auth, endpoint }] as const),
      // The server still has deleted credentials, and the ChatGPT sign-in isn't in the fixture.
      ["chatgpt", { auth: "codex-login" }],
      ["gpu-gone", { auth: "api-key" }],
    ]),
  );
  const app = configurationsOf(runs, credentials, NOW);
  expect(app.map((configuration) => configuration.key).sort()).toEqual([...release.keys()].sort());
  for (const configuration of app) {
    const counted = configuration.latest
      .filter((result) => eligibleTrial(result.trial))
      .map((result) => `${result.run.id}:${result.trial.taskId}`);
    const released = [...(release.get(configuration.key)?.results.values() ?? [])].map(
      (result) => `${result.run.id}:${result.trial.taskId}`,
    );
    expect(counted.sort()).toEqual(released.sort());
  }
  expect(app).toHaveLength(3);
});
