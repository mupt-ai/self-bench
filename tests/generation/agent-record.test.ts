import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { finishAgent } from "../../src/generation/pipeline/agent.js";
import { candidateArtifacts } from "../../src/generation/runs/artifacts.js";
import type { SandboxJobOutcome } from "../../src/sandbox/jobs.js";
import { runOnlyExecutor } from "../support/sandbox-executor.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const prefix = "runs/run-1/authoring/cand-a/round-1/turn-1/attempt-1";

/** Finishes one recorded agent run against the write-once local store. */
async function finish(outcome: Partial<SandboxJobOutcome>) {
  const root = await mkdtemp(join(tmpdir(), "selfbench-agent-record-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const record = { stage: "authoring", round: 1, turn: 1, attempt: 1, prefix };
  await store.put(`${prefix}/agent.json`, Buffer.from(JSON.stringify(record)), "application/json");
  await finishAgent(
    store,
    runOnlyExecutor(async () => {
      throw new Error("not run");
    }),
    {
      sandbox: { sandboxId: "sb", stage: "author", startedAt: "", expiresAt: "" },
      prefix,
      exitCode: 0,
      files: {},
      inline: {},
      ...outcome,
    },
  );
  const artifacts = await candidateArtifacts(store, "run-1", {
    taskId: "task-a",
    candidateId: "cand-a",
  });
  return artifacts.agents;
}

test("a finished run records its result without rewriting agent.json", async () => {
  const agents = await finish({});
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({ prefix, attempt: 1, exitCode: 0 });
  expect(agents[0]?.finishedAt).toBeString();
});

test("a run the model provider ended records the provider error", async () => {
  const agents = await finish({ exitCode: 1, providerError: "Not Found" });
  expect(agents[0]).toMatchObject({ prefix, exitCode: 1, error: "Not Found" });
});
