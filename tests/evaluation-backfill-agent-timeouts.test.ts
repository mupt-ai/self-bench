import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { backfillAgentTimeouts } from "../src/evaluation/backfill-agent-timeouts.js";
import { eligibleTrial } from "../src/evaluation/eligible.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  saveEvaluation,
} from "../src/evaluation/store.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("timed-out trials recorded as failures are scored from their stored artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "backfill-timeouts-"));
  directories.push(directory);
  const store = new LocalArtifactStore(directory);
  const pricing = {
    input: 2,
    output: 8,
    cacheRead: 0.5,
    cacheWrite: 2.5,
    source: "https://provider.example/pricing",
    asOf: "2026-09-05",
  };
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      harnesses: ["pi"],
      pricing,
      tasks: [
        { runId: "run-one", taskId: "scored", bundleKey: "tasks/scored.tar.gz" },
        { runId: "run-one", taskId: "unscored", bundleKey: "tasks/unscored.tar.gz" },
      ],
    },
    "Test",
  );
  run.status = "failed";
  const reply = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openai",
      model: "test-model",
      usage: { input: 10, output: 10, cacheRead: 10, cacheWrite: 0 },
    },
  });
  for (const [index, rewards] of [{ reward: 1 }, {}].entries()) {
    const trial = run.trials[index];
    if (!trial) throw new Error("Missing trial");
    Object.assign(trial, {
      status: "failed",
      error: "Agent execution timed out after 2400.0 seconds",
      artifacts: [`${index}/solver/task__1/result.json`, `${index}/solver/task__1/agent/pi.txt`],
    });
    const files = {
      "solver/task__1/result.json": JSON.stringify({
        exception_info: { exception_type: "AgentTimeoutError" },
        verifier_result: { rewards },
        agent_result: { n_input_tokens: 1000, n_cache_tokens: 600, n_output_tokens: 100 },
      }),
      // Stored as a 1 MiB tail, as the runner keeps long transcripts.
      "solver/task__1/agent/pi.txt": `[Earlier output truncated]\n"usage":{\n${reply}\n{"type":"tu`,
    };
    for (const [name, text] of Object.entries(files))
      await store.put(
        `${evaluationPrefix(run.repoId, run.id)}artifacts/${index}/${name}`,
        Buffer.from(text),
        "text/plain",
      );
  }
  await saveEvaluation(store, run);

  const dry = await backfillAgentTimeouts(store, run.repoId, false);
  expect(dry).toMatchObject({ scored: 1, eligible: 1, skipped: 1, applied: false });
  expect((await getEvaluation(store, run.repoId, run.id))?.revision).toBe(run.revision);

  expect(await backfillAgentTimeouts(store, run.repoId, true)).toMatchObject({ applied: true });
  const saved = await getEvaluation(store, run.repoId, run.id);
  const [scored, unscored] = saved?.trials ?? [];
  expect(scored).toMatchObject({
    status: "completed",
    agentTimedOut: true,
    rewards: { reward: 1 },
  });
  expect(scored?.error).toBeUndefined();
  expect(scored && eligibleTrial(scored)).toBe(true);
  // Never an invented zero: a trial Harbor did not score stays failed, and so does its run.
  expect(unscored?.status).toBe("failed");
  expect(saved?.status).toBe("failed");
  // Applied once, a second pass finds nothing left to score.
  expect(await backfillAgentTimeouts(store, run.repoId, true)).toMatchObject({
    scored: 0,
    applied: false,
  });
});
