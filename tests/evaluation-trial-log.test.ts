import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { trialLog } from "../src/evaluation/output.js";
import { recomputeEvaluationCost } from "../src/evaluation/recompute-cost.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  saveEvaluation,
} from "../src/evaluation/store.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

test("trial log orders sections for a reader and leaves out transcripts and duplicate job logs", () => {
  const trialText = "Selected strategy: _ModalDirect\nRunning command: codex exec\n";
  const log = trialLog(
    "Job Info\nTotal runtime: 11m 5s\n",
    new Map([
      ["solver/job.log", trialText],
      ["solver/task__1/trial.log", trialText],
      ["solver/task__1/agent/codex.txt", '{"type":"item.completed"}\n'],
      ["solver/task__1/agent/trajectory.json", "{}"],
      ["solver/task__1/verifier/test-stderr.txt", "warning\n"],
      ["solver/task__1/verifier/test-stdout.txt", "3 passed\n"],
    ]),
  );
  expect(log).toBe(
    [
      "--- Harbor output ---\nJob Info\nTotal runtime: 11m 5s",
      "--- solver/task__1/verifier/test-stdout.txt ---\n3 passed",
      "--- solver/task__1/verifier/test-stderr.txt ---\nwarning",
      "--- solver/task__1/trial.log ---\nSelected strategy: _ModalDirect\nRunning command: codex exec",
    ].join("\n\n"),
  );
  // Without a trial log (Harbor failed early), job.log is the only record and is kept.
  expect(trialLog("", new Map([["solver/job.log", "boom\n"]]))).toBe(
    "--- solver/job.log ---\nboom",
  );
});

test("one long section cannot evict the rest, and cuts start on a whole line", () => {
  const long = Array.from({ length: 20_000 }, (_, line) => `verifier line ${line}`).join("\n");
  const log = trialLog(
    "Harbor summary\n",
    new Map([
      ["solver/t/verifier/test-stdout.txt", long],
      ["solver/t/trial.log", "trial done\n"],
    ]),
  );
  expect(log.length).toBeLessThan(101_000);
  expect(log).toStartWith("--- Harbor output ---\nHarbor summary\n\n");
  expect(log).toEndWith("--- solver/t/trial.log ---\ntrial done");
  expect(log).toContain("verifier line 19999\n\n");
  expect(log).toMatch(/earlier characters omitted\]\nverifier line \d+\n/);
});

test("recompute re-derives stored OpenRouter Codex costs and writes only on apply", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-recompute-"));
  directories.push(directory);
  const store = new LocalArtifactStore(directory);
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      modelName: "openrouter/openai/gpt-6-astra",
      credentials: {
        modelCredentialId: "managed-model",
        sandboxCredentialId: "managed-sandbox",
        provider: "openrouter",
      },
    },
    "Test",
  );
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing trial");
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  Object.assign(trial, { status: "completed", modelVerified: false, tokenUsage: usage });
  run.status = "completed";
  const trajectory = {
    agent: { model_name: "openai/gpt-6-astra" },
    steps: [
      {
        source: "agent",
        model_name: "openai/openai/gpt-6-astra",
        metrics: { prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.25 },
      },
    ],
  };
  const result = {
    agent_result: { n_input_tokens: 10, n_cache_tokens: 0, n_output_tokens: 5, cost_usd: 0.25 },
  };
  for (const [name, body] of [
    ["0/solver/task__1/agent/trajectory.json", trajectory],
    ["0/solver/task__1/result.json", result],
  ] as const) {
    trial.artifacts.push(name);
    await store.put(
      `${evaluationPrefix(run.repoId, run.id)}artifacts/${name}`,
      Buffer.from(JSON.stringify(body)),
      "text/plain",
    );
  }
  await saveEvaluation(store, run);

  const dry = await recomputeEvaluationCost(store, run.repoId, run.id, false);
  expect(dry.applied).toBe(false);
  expect(dry.trials[0]?.after).toEqual({
    modelVerified: true,
    tokenUsage: usage,
    apiCostUsd: 0.25,
    costSource: "harbor",
  });
  expect((await getEvaluation(store, run.repoId, run.id))?.trials[0]?.apiCostUsd).toBeUndefined();

  expect((await recomputeEvaluationCost(store, run.repoId, run.id, true)).applied).toBe(true);
  const saved = await getEvaluation(store, run.repoId, run.id);
  expect(saved?.revision).toBe(2);
  expect(saved?.trials[0]).toMatchObject({
    modelVerified: true,
    apiCostUsd: 0.25,
    status: "completed",
  });
  expect((await recomputeEvaluationCost(store, run.repoId, run.id, true)).applied).toBe(false);
});
