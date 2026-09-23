import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asyncLocalStorage, type Context } from "@temporalio/activity";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { withExecutionEnvironment } from "../../src/contracts/config/execution-environment.js";
import type { RunRequest } from "../../src/contracts/index.js";
import { runAgent } from "../../src/generation/pipeline/agent.js";
import { candidateArtifacts } from "../../src/generation/runs/artifacts.js";
import {
  SandboxExecutionError,
  type SandboxExecutor,
  type SandboxResult,
} from "../../src/sandbox/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const prefix = "runs/run-1/authoring/cand-a/round-1/turn-1/attempt-1";
const result: SandboxResult = {
  sandboxId: "sandbox-1",
  exitCode: 0,
  stdout: "",
  stderr: "",
  outputs: {},
};

/** Runs one agent against the write-once local store, as an activity with the given sandbox. */
async function run(sandbox: SandboxExecutor["run"]) {
  const root = await mkdtemp(join(tmpdir(), "selfbench-agent-record-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const context = {
    heartbeat: () => undefined,
    cancellationSignal: new AbortController().signal,
  } as unknown as Context;
  const outcome = await asyncLocalStorage
    .run(context, () =>
      withExecutionEnvironment({ OPENAI_API_KEY: "test-key", GH_TOKEN: "test-token" }, () =>
        runAgent({
          store,
          sandbox: { run: sandbox, close: () => undefined },
          run: {
            runId: "run-1",
            repository: { url: "https://github.com/o/r" },
            authoring: { model: "gpt-test", reasoningEffort: "high" },
          } as RunRequest,
          label: "author-cand-a-r1",
          prefix,
          record: { stage: "authoring", round: 1, turn: 1, attempt: 1 },
          workspace: { kind: "clone", commit: "a".repeat(40) },
          extension: "/work/extension.js",
          tools: "bash",
          prompt: "Write the task.",
          files: [],
          outputs: [],
          timeoutMs: 60_000,
        }),
      ),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  const artifacts = await candidateArtifacts(store, "run-1", {
    taskId: "task-a",
    candidateId: "cand-a",
  });
  return { outcome, agents: artifacts.agents };
}

test("a finished run records its result without rewriting agent.json", async () => {
  const { outcome, agents } = await run(async () => result);
  expect(outcome).toBeUndefined();
  expect(agents).toHaveLength(1);
  expect(agents[0]).toMatchObject({ prefix, attempt: 1, exitCode: 0 });
  expect(agents[0]?.finishedAt).toBeString();
});

test("a failed run records its error", async () => {
  const { outcome, agents } = await run(async () => {
    throw new SandboxExecutionError("sandbox died", { ...result, exitCode: 137 });
  });
  expect(outcome).toBeInstanceOf(Error);
  expect(agents[0]).toMatchObject({ prefix, error: "sandbox died" });
});
