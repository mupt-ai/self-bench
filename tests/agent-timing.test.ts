import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts/local.js";
import { agentTimingOf, withAgentTimings } from "../src/evaluation/agent-timing.js";
import { trialMinutes } from "../src/evaluation/attempt-minutes.js";
import { evaluationPrefix } from "../src/evaluation/store.js";
import type { EvaluationRun } from "../src/evaluation/types.js";

const ID = "00000000-0000-4000-8000-000000000001";
const SCOPE = { repoId: 10 };

const trial = (overrides: Record<string, unknown> = {}) => ({
  taskId: "t",
  startedAt: "2026-09-01T00:00:00.000Z",
  finishedAt: "2026-09-01T00:30:00.000Z",
  ...overrides,
});

test("the agent's phase is read from Harbor's result only when it ran", () => {
  expect(agentTimingOf({ agent_execution: { started_at: "a", finished_at: "b" } })).toEqual({
    agentStartedAt: "a",
    agentFinishedAt: "b",
  });
  expect(agentTimingOf({ agent_execution: null })).toBeUndefined();
  expect(
    agentTimingOf({ agent_execution: { started_at: "a", finished_at: null } }),
  ).toBeUndefined();
  expect(agentTimingOf(null)).toBeUndefined();
});

test("a trial's minutes are the agent's where it has them, its wall-clock time otherwise", () => {
  const withAgent = trial({
    agentStartedAt: "2026-09-01T00:10:00.000Z",
    agentFinishedAt: "2026-09-01T00:25:00.000Z",
  });
  expect(trialMinutes(withAgent)).toBe(15);
  expect(trialMinutes(trial())).toBe(30);
});

test("an evaluation's sidecar gives its older trials their agent timings, by trial index", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfbench-agent-timing-"));
  try {
    const store = new LocalArtifactStore(root);
    const key = `${evaluationPrefix(SCOPE, ID)}agent-timing.json`;
    await store.put(
      key,
      Buffer.from(
        JSON.stringify({
          trials: {
            "0": {
              startedAt: "2026-09-01T00:10:00.000Z",
              finishedAt: "2026-09-01T00:25:00.000Z",
            },
            "1": { startedAt: "2026-09-01T01:00:00.000Z", finishedAt: "2026-09-01T01:05:00.000Z" },
          },
        }),
      ),
      "application/json",
    );
    const own = {
      agentStartedAt: "2026-09-01T02:00:00.000Z",
      agentFinishedAt: "2026-09-01T02:01:00.000Z",
    };
    const run = {
      id: ID,
      trials: [trial(), trial(own), trial()],
    } as unknown as EvaluationRun;
    const timed = await withAgentTimings(store, SCOPE, run);
    expect(timed.trials[0]).toMatchObject({
      agentStartedAt: "2026-09-01T00:10:00.000Z",
      agentFinishedAt: "2026-09-01T00:25:00.000Z",
    });
    // A trial that already has its agent timing keeps it.
    expect(timed.trials[1]).toMatchObject(own);
    // Trial 2 has no entry in the sidecar, so it keeps only its wall-clock time.
    expect(timed.trials[2]).not.toHaveProperty("agentStartedAt");
    // The stored run itself is not changed.
    expect(run.trials[0]).not.toHaveProperty("agentStartedAt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a run with no sidecar is returned as it was", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfbench-agent-timing-"));
  try {
    const store = new LocalArtifactStore(root);
    const run = { id: ID, trials: [trial()] } as unknown as EvaluationRun;
    expect(await withAgentTimings(store, SCOPE, run)).toBe(run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
